# Claude Code × Discord エージェント PoC セットアップガイド

**目的**: 1つのDiscordチャンネルに「プロジェクト管理エージェント」を常駐させ、スマホからリポジトリ管理・編集・レビュー・デプロイ指示・スケジュール管理ができるようにする。

**参考**: [5 Claude Agents, 5 Discord Channels, 1 Obsidian Vault](https://artemxtech.substack.com/p/5-claude-agents-5-discord-channels) by Artem Zhutov

---

## 前提条件

| 項目 | 要件 |
|------|------|
| Claude Code CLI | v2.1.80以上 |
| claude.aiアカウント | Pro / Max プラン（APIキーでは不可） |
| Bun | チャンネルプラグイン実行に必要 |
| Discord | 自分のサーバー（無料で作成可能） |
| OS | macOS / Linux（Windowsは非対応） |

---

## Step 1: 前提ツールの確認

```bash
# Claude Codeのバージョン確認
claude --version
# → v2.1.80以上であること

# Bunのインストール確認（なければインストール）
bun --version
# インストールされていない場合:
curl -fsSL https://bun.sh/install | bash
```

---

## Step 2: Discord Botの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリック → 名前を「PM-Agent」などにする
3. 左メニュー「Bot」→ 「Reset Token」→ **トークンをコピーして保存**
4. 同じ画面で **「Message Content Intent」を有効化**（Privileged Gateway Intents内）
5. 左メニュー「OAuth2 > URL Generator」→ 以下を設定:
   - Scopes: `bot`
   - Bot Permissions:
     - View Channels
     - Send Messages
     - Send Messages in Threads
     - Read Message History
     - Attach Files
     - Add Reactions
6. 生成されたURLを開いて、自分のDiscordサーバーにBotを追加

---

## Step 3: Discordサーバーにチャンネル作成

Discordサーバーに以下のチャンネルを作成:

```
#pm-agent  （プロジェクト管理エージェント用）
```

将来の拡張用に以下も予約しておくと良い:

```
#research      （リサーチ用）
#daily-review  （日次レビュー用）
#monitoring    （監視用）
#orchestrator  （統括用）
```

---

## Step 4: Claude Codeにプラグインをインストール

```bash
# Claude Codeを起動
claude

# プラグインマーケットプレイスを追加（初回のみ）
/plugin marketplace add anthropics/claude-plugins-official

# Discordプラグインをインストール
/plugin install discord@claude-plugins-official

# プラグインを再読み込み
/reload-plugins

# Botトークンを設定（Step 2でコピーしたもの）
/discord:configure YOUR_BOT_TOKEN_HERE

# 一旦終了
/exit
```

---

## Step 5: ペルソナファイル（claude.md）の作成

プロジェクトのルートディレクトリに `.claude/` フォルダを作り、`claude.md` を配置する。
これがエージェントの「性格」と「役割」を定義する。

### `.claude/claude.md` の例:

```markdown
# PM Agent - プロジェクト管理エージェント

## あなたの役割
あなたはシニアプロジェクトマネージャー兼DevOpsエンジニアです。
Discordチャンネル経由で受ける指示に対して、以下の業務を担当します。

## 担当業務

### 1. プロジェクト管理
- タスクの進捗確認と報告
- git logやissue一覧からの状況サマリー作成
- マイルストーンの追跡

### 2. リポジトリ管理
- ブランチの作成・マージ
- PRの作成・レビュー
- コンフリクト解決のサポート

### 3. コードレビュー
- 指定されたPR/ファイルのレビュー
- セキュリティ・パフォーマンス観点のチェック
- 改善提案の提示

### 4. デプロイ
- デプロイスクリプトの実行
- ステージング/本番環境の状態確認
- デプロイ後の動作確認

### 5. スケジュール管理
- 定期レポートの生成
- リマインダーの設定
- 期日の追跡と通知

## 行動指針
- 日本語で応答する
- 簡潔かつ正確に報告する
- 不明な点は確認を取ってから実行する
- 破壊的操作（force push, deleteなど）は必ず確認を求める
- コマンド実行結果は要約して報告する

## プロジェクト情報
- リポジトリ: （ここにリポジトリパスを記載）
- メインブランチ: main
- デプロイ方法: （ここにデプロイ手順を記載）
```

---

## Step 6: エージェントを起動

```bash
# プロジェクトディレクトリに移動
cd /path/to/your/project

# tmux or screen でセッションを作成（永続化のため）
tmux new-session -s pm-agent

# Claude Codeをチャンネル付きで起動
claude --channels plugin:discord@claude-plugins-official
```

---

## Step 7: ペアリング（初回のみ）

1. Discordを開き、Botに **DM（ダイレクトメッセージ）** を送る
2. Botがペアリングコードを返す
3. Claude Codeのターミナルで:

```
/discord:access pair YOUR_PAIRING_CODE
```

4. **重要**: セキュリティのためallowlistモードに切り替え:

```
/discord:access policy allowlist
```

---

## Step 8: 動作確認

Discordの `#pm-agent` チャンネル（またはBot DM）で以下を試す:

```
リポジトリの状態を教えて
```

```
最新のコミット5件を一覧して
```

```
今のブランチ一覧を見せて
```

Claude Codeがメッセージを受信し、ローカルのファイルシステムとgitを使って応答すれば成功。

---

## トラブルシューティング

| 問題 | 対処 |
|------|------|
| Botが応答しない | Claude Codeが `--channels` 付きで起動しているか確認 |
| ペアリングコードが出ない | Botに直接DMを送る（チャンネルではなく） |
| パーミッションで止まる | ターミナルで承認するか、信頼できる環境なら `--dangerously-skip-permissions` を使う |
| セッション切断 | tmux/screenを使って常駐させる |
| Message Content Intentエラー | Discord Developer PortalでIntentを有効にしたか確認 |

---

## 次のステップ（5エージェント拡張）

PoCが成功したら、以下のように拡張可能:

1. **追加のDiscord Botを作成**（各エージェントごと）
2. **各Botに異なる `DISCORD_STATE_DIR` を設定**して分離
3. **各エージェント用のclaude.mdを作成**
4. **tmuxの複数ペインで5セッション起動**:

```bash
# tmux内で5つのウィンドウを作成
tmux new-session -s agents
# ウィンドウ1: PM Agent
cd /path/to/project && claude --channels plugin:discord@claude-plugins-official
# ウィンドウ2: Research Agent
# ... 以下同様
```

---

## 参考リンク

- [Claude Code Channels ドキュメント](https://code.claude.com/docs/en/channels)
- [Channels リファレンス](https://code.claude.com/docs/en/channels-reference)
- [Discord プラグインソース](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord)
- [DataCamp: Claude Code Channels with Discord](https://www.datacamp.com/tutorial/claude-code-channels)
