#!/usr/bin/env python3
"""UserPromptSubmit hook: Inject AI title generation after 2+ user messages."""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Allow importing sibling module
sys.path.insert(0, str(Path(__file__).parent))
from session_title_utils import read_title

# Structured JSON log destination. Override with PROMPT_TITLE_LOG env var (tests).
# Defaults to ~/.claude/logs/prompt-title-check.log per observability.md
_DEFAULT_LOG_PATH = Path.home() / ".claude" / "logs" / "prompt-title-check.log"


def log_warn(message: str, context: dict) -> None:
    """Append a structured JSON warning to the log file.

    Failures to write the log are silently ignored so the hook cannot be
    broken by log I/O problems. See rules/general/observability.md.
    """
    log_path = Path(os.environ.get("PROMPT_TITLE_LOG") or _DEFAULT_LOG_PATH)
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": "WARN",
        "message": message,
        "context": context,
    }
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except (OSError, TypeError, ValueError):
        pass


def count_user_messages(transcript_path: str) -> int:
    """Count user messages in transcript JSONL file."""
    count = 0
    try:
        with open(transcript_path) as f:
            for line_no, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if entry.get("type") == "user":
                        count += 1
                except json.JSONDecodeError as e:
                    log_warn(
                        "transcript_parse_error",
                        {
                            "transcript_path": transcript_path,
                            "line_no": line_no,
                            "error": str(e),
                        },
                    )
                    continue
    except (FileNotFoundError, PermissionError) as e:
        log_warn(
            "transcript_read_error",
            {
                "transcript_path": transcript_path,
                "error": str(e),
                "error_type": type(e).__name__,
            },
        )
    return count


def main():
    data = json.load(sys.stdin)
    session_id = data.get("session_id", "")
    transcript_path = data.get("transcript_path", "")
    prompt = data.get("prompt", "")

    if not session_id:
        return

    # Skip for --channels-routed messages (Discord/Slack plugins).
    # These sessions run under launchd/tmux where `printf > /dev/tty` either
    # fails or triggers a Bash permission dialog that --dangerously-skip-permissions
    # doesn't bypass, freezing the bot on the first inbound message.
    # See miyashita337/claude-hub#44.
    if 'source="plugin:' in prompt:
        return

    # Fast path: already has AI or manual title
    _, source = read_title(session_id)
    if source in ("ai", "manual"):
        return

    # Check user message count
    if not transcript_path:
        return

    user_msg_count = count_user_messages(transcript_path)
    if user_msg_count < 2:
        return

    # Inject title generation instruction.
    # The /dev/tty write is wrapped in `( ... || true )` so that a failure to
    # open /dev/tty (launchd / headless / CI) cannot short-circuit the `&&`
    # chain and leave the title file unwritten. See claude-hub#44 defense-in-depth.
    instruction = (
        f"[Session Title Request] This session still has a branch-based title. "
        f"Based on the conversation so far, generate a concise session title "
        f"(Japanese, max 10 characters) that captures the main topic. Then run this command:\n"
        f"( printf '\\033]1;%s\\007' \"YOUR_TITLE\" > /dev/tty 2>/dev/null || true ) && "
        f"mkdir -p ~/.claude/session-titles && "
        f"printf '%s\\nai\\n' \"YOUR_TITLE\" > ~/.claude/session-titles/{session_id}.txt\n"
        f"Replace YOUR_TITLE with the generated title. No confirmation needed. "
        f"After setting the title, respond to the user's message normally."
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": instruction,
        }
    }
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
