<!--
  hijoguchi (claudeHubExit Bot) system-prompt placeholder.

  This file is read at startup by scripts/start-hijoguchi.sh and passed to
  `claude --append-system-prompt "$(cat ...)"`. S2 (#48) ships only this
  infrastructure (quoting + guard + tmux verify + logging). S3 (#49) will
  replace the body below with the real routing / scope rules.

  Keeping the stub intentionally minimal so current production behaviour is
  not altered before S3 lands.
-->

# hijoguchi system prompt (S2 stub — replaced by S3 #49)
