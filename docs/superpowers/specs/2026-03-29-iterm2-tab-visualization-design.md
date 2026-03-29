# iTerm2タブでClaude Codeセッション可視化

**Issue:** #2
**Date:** 2026-03-29
**Status:** Approved

## 概要

Supervisor BotがClaude Codeセッションを起動する際、従来のtmuxバックグラウンド起動に加えて、iTerm2の既存ウィンドウに新しいタブを自動追加し、セッションの状態をリアルタイムで確認できるようにする。

## 背景・動機

- 在宅時: Macの前にいるとき、バックグラウンドのセッション状態をリアルタイムで見たい
- 外出時: Discord経由で操作（Tailscale+SSHでの文字化け・画像送信問題を回避）
- tmuxは信頼性のバックボーンとして維持（Discord不調時のフォールバック）

## アーキテクチャ

**方式: osascript + tmux attach**

```
SessionManager.start()
  → tmux new-session -d (従来通り、プロセス管理の主体)
  → osascript: iTerm2にタブ追加 + tmux attach (ビューア)
  → タブタイトル設定: "<channelName> (running)"
  → 背景色設定: project-colors.json から解決
  → セッション終了時: タブタイトル → "<channelName> (stopped)"
```

tmuxがプロセスライフサイクルを管理し、iTerm2タブはビューアとして機能する。iTerm2が閉じてもセッションは生き続ける。

## 新規ファイル

### `supervisor/src/session/iterm2.ts`

iTerm2タブ操作を集約するモジュール。

```typescript
// iTerm2が起動しているか確認
// osascript -e 'tell app "System Events" to (name of processes) contains "iTerm2"'
isItermRunning(): boolean

// 新しいタブを作成し、tmux attachコマンドを実行
// タブタイトルとプロジェクト背景色も設定
openTab(opts: {
  tmuxSessionName: string
  channelName: string
  projectDir: string
}): void

// タブタイトルを "(stopped)" に変更、背景色を暗くする
markTabStopped(channelName: string): void
```

**openTab の AppleScript:**

```applescript
tell application "iTerm2"
  tell current window
    create tab with default profile
    tell current session
      write text "tmux attach -t claude-<channelName>"
      set name to "<channelName> (running)"
      set background color to {r, g, b}
    end tell
  end tell
end tell
```

**markTabStopped の AppleScript:**

```applescript
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      if name of current session of t is "<channelName> (running)" then
        tell current session of t
          set name to "<channelName> (stopped)"
        end tell
      end if
    end repeat
  end repeat
end tell
```

**背景色の解決:**
- `~/.claude/scripts/project-colors.json` を読み取り
- `session_title_utils.py` の `resolve_color()` と同じロジックをTSに移植
  - projects マップで前方一致 → マッチすればその色
  - マッチしなければ SHA-256ハッシュ → HSL → hex
- stopped時: 元の色の50%輝度に暗くする

**エラーハンドリング:**
- 全関数で try/catch → 失敗時はログ出力のみ
- セッション起動をブロックしない

## 既存ファイルの変更

### `supervisor/src/session/manager.ts`

**start() メソッド:**
- tmux起動・PID取得・DB登録の後に `openTab()` を呼ぶ
- iTerm2不在時はスキップ（ログのみ）

**resume() メソッド:**
- 同様に `openTab()` を追加

**stop() メソッド:**
- 既存のSIGTERM・tmux kill処理の後に `markTabStopped()` を追加

**watchTmuxSession():**
- tmux終了検知時に `markTabStopped()` を呼ぶ

## タブライフサイクル

| イベント | タブ | タイトル | 背景色 |
|---|---|---|---|
| セッション起動 | 自動作成 | `<channelName> (running)` | プロジェクト色 |
| セッション終了 | 残す | `<channelName> (stopped)` | 暗い色（50%輝度） |
| ユーザーが手動で閉じる | — | — | — |

## 既存システムとの整合性

**タイトル管理 (`session_title_utils.py`):**
- Supervisor起動のタブは `<channelName> (running/stopped)` 形式
- 通常のClaude Codeセッション（SessionStartフック経由）はブランチ名/AIタイトル形式
- 命名規則が異なるためバッティングなし

**背景色 (`project-colors.json`):**
- 同じファイルを参照、同じ解決ロジック
- Supervisor側はTSに移植するが、アルゴリズムは同一

**tmux.conf:**
- `remain-on-exit` はコメントアウト済み → tmuxセッション終了時ペインは自動消去（想定通り）
- F12 detach → iTerm2タブからdetachしてもセッション生存（想定通り）
- マウスON → iTerm2タブ内でスクロール可能

## フォールバック・エッジケース

| シナリオ | 動作 |
|---|---|
| iTerm2未起動 | `isItermRunning()` → false → tmuxのみで起動（ログ出力） |
| iTerm2が途中で終了 | tmuxセッションは生存。`markTabStopped` 失敗→ログのみ |
| ユーザーがタブを手動で閉じる | tmuxセッション生存。終了時 `markTabStopped` はタブ見つからず→スキップ |
| ユーザーがタブ内でdetach（F12） | tmuxセッション生存。タブはシェルに戻る。再度 `tmux attach` で復帰可能 |
| Supervisor再起動 | `recoverFromDb()` で既存tmuxをkill。orphanタブはユーザーが手動で閉じる |
| 複数セッション同時起動 | タブがセッション数分追加。各タブは独立 |
| SSH経由（iTerm2なし） | `isItermRunning()` → false → tmuxのみ |

## セッション寿命の安全網

| 制御 | トリガー | 動作 |
|---|---|---|
| Claude Code自体の終了 | タスク完了 | `exec` なのでtmuxセッションも自動終了 |
| Reaper | 7日間無操作 | `sessionManager.stop()` → SIGTERM + tmux kill |
| ResourceMonitor | メモリ上限超過 | 同上 |

## スコープ外

- ダッシュボードUI
- Supervisor再起動時のorphanタブ自動クリーンアップ
- iTerm2 Python API対応
