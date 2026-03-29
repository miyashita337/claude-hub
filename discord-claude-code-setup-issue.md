# Discord × Claude Code Channels セットアップ手順書

## 概要
iPhoneのDiscordアプリからClaude Codeセッションを遠隔操作する仕組みのセットアップ手順。
Claude Code Channels（Research Preview）を利用し、Discordチャンネル → Claude Code → リポジトリ操作を実現する。

**参考記事**: [5 Claude Agents, 5 Discord Channels, 1 Obsidian Vault](https://artemxtech.substack.com/p/5-claude-agents-5-discord-channels)

## アーキテクチャ

```
iPhone Discord App
    ↓ メッセージ送信
Discord Server (#pm-agent チャンネル)
    ↓ Discord Bot (PM-Agent)
Claude Code Session (--channels flag)
    ↓ ツール実行
リポジトリ操作 / ファイル編集 / デプロイ etc.
```

---

## 前提条件

| 項目 | 要件 |
|------|------|
| Claude プラン | Max ($200) |
| Claude Code | v2.1.80+ |
| OS | macOS |
| ランタイム | Bun (`curl -fsSL https://bun.sh/install \| bash`) |
| Discord | アカウント + iPhoneアプリ |

---

## Phase 1: Discord サーバー & チャンネル作成

### 1-1. Discordサーバーを作成
1. Discord を開く
2. 左サイドバーの「＋」ボタンをクリック
3. 「オリジナルを作成」→「自分と友達のため」を選択
4. サーバー名: **Claude Agents** で作成

### 1-2. テキストチャンネルを作成
1. サーバー内でチャンネル一覧の「＋」をクリック
2. テキストチャンネルを選択
3. チャンネル名: **#pm-agent** で作成

---

## Phase 2: Discord Bot 作成

### 2-1. アプリケーション作成
1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「新しいアプリケーション」をクリック
3. 名前: **PM-Agent** で作成
4. ⚠️ hCaptcha が出たら手動で解決

### 2-2. Bot トークン取得
1. 左メニュー「Bot」をクリック
2. 「トークンをリセット」→ 確認ダイアログで「実行します！」
3. Discord パスワードを入力して本人確認
4. **表示されたトークンを安全な場所にコピー**（一度しか表示されない）

### 2-3. Message Content Intent 有効化
1. Bot ページ下部の「Privileged Gateway Intents」セクション
2. **Message Content Intent** のトグルをON
3. 「変更を保存」をクリック

### 2-4. Bot をサーバーに招待
以下のURLの `YOUR_CLIENT_ID` を Application ID に置き換えてブラウザで開く:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274877975552&scope=bot&guild_id=YOUR_GUILD_ID
```

- `permissions=274877975552`: メッセージ送受信 + 読み取り権限
- サーバー選択 → 「認証」で完了

---

## Phase 3: Claude Code 設定

### 3-1. Discord プラグインインストール
```bash
claude plugin install discord@claude-plugins-official
```

### 3-2. Bot トークンを環境変数に設定
```bash
export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN_HERE"
```

**永続化する場合** (`~/.zshrc` に追記):
```bash
echo 'export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN_HERE"' >> ~/.zshrc
source ~/.zshrc
```

### 3-3. チャンネル付きで Claude Code を起動
```bash
claude --channels plugin:discord@claude-plugins-official
```

---

## Phase 4: ペアリング

### 4-1. DM でペアリングコード取得
1. iPhoneの Discord アプリを開く
2. サーバーのメンバーリストから **PM-Agent Bot** を探す
3. Bot のプロフィールを開き「メッセージ」をタップ
4. 何かメッセージを送る（例: `hi`）
5. Bot が **ペアリングコード** を返す（例: `5a42dd`）

### 4-2. Claude Code でペアリング実行
起動中の Claude Code セッション内で:
```
/discord:access pair <ペアリングコード>
```

### 4-3. アクセスポリシー設定
```
/discord:access policy allowlist
```

---

## Phase 5: 動作確認

1. iPhone Discord → **#pm-agent** チャンネルにメッセージ送信
2. Mac の Claude Code セッションがメッセージを受信して応答
3. Bot が Discord チャンネルに返答を投稿

**使い方**:
- **DM**: PM-Agent Bot と1対1（個人作業向き）
- **#pm-agent チャンネル**: サーバー上で共有（チーム向き）

---

## 補足: 5エージェント拡張する場合

| エージェント | チャンネル | 用途 |
|-------------|-----------|------|
| PM-Agent | #pm-agent | プロジェクト管理・リポ管理 |
| Code-Agent | #code-agent | コード編集・実装 |
| Review-Agent | #review-agent | コードレビュー |
| Deploy-Agent | #deploy-agent | CI/CD・デプロイ |
| Research-Agent | #research-agent | リサーチ・調査 |

各エージェントは**別々の Claude Code セッション**として起動し、それぞれ独自の Bot トークンと `DISCORD_STATE_DIR` を持つ。

```bash
# 例: tmux で複数セッション管理
tmux new-session -d -s pm-agent
tmux send-keys -t pm-agent 'DISCORD_BOT_TOKEN=$PM_TOKEN claude --channels plugin:discord@claude-plugins-official' Enter

tmux new-session -d -s code-agent
tmux send-keys -t code-agent 'DISCORD_BOT_TOKEN=$CODE_TOKEN claude --channels plugin:discord@claude-plugins-official' Enter
```

---

## トラブルシューティング

| 問題 | 解決策 |
|------|--------|
| Bot がオフライン | `DISCORD_BOT_TOKEN` が正しく設定されているか確認 |
| メッセージを受信しない | Message Content Intent が有効か Developer Portal で確認 |
| ペアリングコードが来ない | Bot へ DM（チャンネルではなく直接メッセージ）を送る |
| `plugin not found` | `claude plugin install discord@claude-plugins-official` を再実行 |
| Claude Code が応答しない | `--channels` フラグ付きで起動しているか確認 |

---

## 実績値（2026/03/29 PoC）
- **サーバー**: Claude Agents (ID: `.claude/env.local` の `DISCORD_GUILD_ID` を参照)
- **チャンネル**: #pm-agent (ID: `.claude/env.local` の `DISCORD_CHANNEL_ID` を参照)
- **Application ID**: `.claude/env.local` の `DISCORD_APP_ID` を参照
- **Claude Code Version**: v2.1.87
- **ペアリング**: 成功確認済み
