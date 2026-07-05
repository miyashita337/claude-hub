#!/usr/bin/env python3
"""Measure Claude Code hook fan-out per tool call (Issue #310).

For each representative tool (Bash / Read / Edit) this script:
  1. Parses every active hook source (user settings.json, ECC plugin
     hooks.json resolved via installed_plugins.json, project settings.json)
  2. Applies the event matcher to compute the exact number of hook commands
     Claude Code spawns for one tool call (PreToolUse + PostToolUse)
  3. Optionally (--time) runs each matching hook once with a synthetic JSON
     payload and reports wall-clock per hook (median of N runs)

UserPromptSubmit is reported as a separate per-prompt line.

Usage:
  python3 scripts/measure-hook-fanout.py [--time] [--runs 3] [--json OUT]

The measurement is read-only with respect to hook registration; --time
executes hook commands with harmless synthetic payloads (cwd points at a
throwaway /tmp dir so supervisor relay hooks exit early).
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time

HOME = os.path.expanduser("~")
USER_SETTINGS = os.path.join(HOME, ".claude", "settings.json")
USER_SETTINGS_LOCAL = os.path.join(HOME, ".claude", "settings.local.json")
INSTALLED_PLUGINS = os.path.join(HOME, ".claude", "plugins", "installed_plugins.json")

TOOLS = ["Bash", "Read", "Edit"]
EVENTS = ["PreToolUse", "PostToolUse"]


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def plugin_hook_sources():
    """Resolve hooks.json paths for installed plugins (installPath is authoritative)."""
    data = load_json(INSTALLED_PLUGINS) or {}
    sources = []
    for name, entries in (data.get("plugins") or {}).items():
        for e in entries:
            hooks_path = os.path.join(e.get("installPath", ""), "hooks", "hooks.json")
            if os.path.isfile(hooks_path):
                sources.append((f"plugin:{name}@{e.get('version')}", hooks_path))
    return sources


def iter_hooks(config, source_label):
    """Yield (event, matcher, command) from a settings-style hooks dict."""
    hooks = (config or {}).get("hooks") or {}
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for g in groups:
            matcher = g.get("matcher", "")
            for h in g.get("hooks", []):
                if h.get("type") == "command":
                    yield {
                        "source": source_label,
                        "event": event,
                        "matcher": matcher,
                        "command": h.get("command", ""),
                    }


def matcher_matches(matcher, tool):
    if matcher in ("", "*", None):
        return True
    try:
        return re.fullmatch(matcher, tool) is not None
    except re.error:
        return matcher == tool


def collect_sources(project_dir):
    sources = []
    if os.path.isfile(USER_SETTINGS):
        sources.append(("user:settings.json", USER_SETTINGS))
    if os.path.isfile(USER_SETTINGS_LOCAL):
        sources.append(("user:settings.local.json", USER_SETTINGS_LOCAL))
    for label, path in plugin_hook_sources():
        sources.append((label, path))
    if project_dir:
        for name in ("settings.json", "settings.local.json"):
            p = os.path.join(project_dir, ".claude", name)
            if os.path.isfile(p):
                sources.append((f"project:{name}", p))
    return sources


def synthetic_payload(event, tool, cwd):
    payload = {
        "session_id": "hook-fanout-measure",
        "transcript_path": "/tmp/hook-fanout-measure-transcript.jsonl",
        "cwd": cwd,
        "hook_event_name": event,
        "tool_name": tool,
    }
    sample = os.path.join(cwd, "sample.txt")
    if tool == "Bash":
        payload["tool_input"] = {"command": "echo hookmeasure", "description": "measure"}
    elif tool == "Read":
        payload["tool_input"] = {"file_path": sample}
    elif tool == "Edit":
        payload["tool_input"] = {"file_path": sample, "old_string": "a", "new_string": "b"}
    if event == "PostToolUse":
        payload["tool_response"] = {"stdout": "hookmeasure", "stderr": "", "interrupted": False}
    return json.dumps(payload)


def time_hook(command, payload, env, runs, timeout=15):
    samples = []
    for _ in range(runs):
        t0 = time.monotonic()
        try:
            subprocess.run(
                ["bash", "-c", command],
                input=payload,
                capture_output=True,
                text=True,
                env=env,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            samples.append(timeout * 1000.0)
            continue
        samples.append((time.monotonic() - t0) * 1000.0)
    return statistics.median(samples)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--time", action="store_true", help="also run each hook and measure wall-clock")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json", help="write machine-readable result to this path")
    ap.add_argument("--project-dir", default=os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))
    args = ap.parse_args()

    all_hooks = []
    for label, path in collect_sources(args.project_dir):
        all_hooks.extend(iter_hooks(load_json(path), label))

    work = tempfile.mkdtemp(prefix="hook-fanout-measure-")
    with open(os.path.join(work, "sample.txt"), "w") as f:
        f.write("a\n")

    env = dict(os.environ)
    env["CLAUDE_PROJECT_DIR"] = args.project_dir
    # Replicate the env Claude Code injects from settings.json "env"
    settings_env = (load_json(USER_SETTINGS) or {}).get("env") or {}
    env.update({k: str(v) for k, v in settings_env.items()})

    result = {"tools": {}, "user_prompt_submit": None}

    for tool in TOOLS:
        tool_res = {"events": {}, "total_spawns": 0, "total_ms": None}
        total_ms = 0.0
        timed_any = False
        for event in EVENTS:
            matching = [h for h in all_hooks if h["event"] == event and matcher_matches(h["matcher"], tool)]
            entries = []
            for h in matching:
                entry = {"source": h["source"], "matcher": h["matcher"] or "(all)",
                         "command": h["command"][:100], "ms": None}
                if args.time:
                    payload = synthetic_payload(event, tool, work)
                    entry["ms"] = round(time_hook(h["command"], payload, env, args.runs), 1)
                    total_ms += entry["ms"]
                    timed_any = True
                entries.append(entry)
            tool_res["events"][event] = entries
            tool_res["total_spawns"] += len(entries)
        if timed_any:
            tool_res["total_ms"] = round(total_ms, 1)
        result["tools"][tool] = tool_res

    ups = [h for h in all_hooks if h["event"] == "UserPromptSubmit"]
    result["user_prompt_submit"] = {"total_spawns": len(ups),
                                    "sources": sorted({h["source"] for h in ups})}

    print(f"{'tool':<6} {'Pre':>4} {'Post':>5} {'total':>6} {'ms(seq sum)':>12}")
    for tool, tr in result["tools"].items():
        pre = len(tr["events"]["PreToolUse"])
        post = len(tr["events"]["PostToolUse"])
        ms = f"{tr['total_ms']:.0f}" if tr["total_ms"] is not None else "-"
        print(f"{tool:<6} {pre:>4} {post:>5} {tr['total_spawns']:>6} {ms:>12}")
    print(f"UserPromptSubmit per-prompt spawns: {result['user_prompt_submit']['total_spawns']}")

    if args.time:
        print("\nPer-hook timing (median ms):")
        for tool, tr in result["tools"].items():
            for event, entries in tr["events"].items():
                for e in entries:
                    print(f"  {tool:<5} {event:<12} {e['ms']:>8} ms  [{e['matcher']}] {e['source']}: {e['command'][:60]}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(result, f, indent=1, ensure_ascii=False)
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
