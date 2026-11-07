#!/bin/sh
set -eu
umask 077
# The job mount stays read-only. CLI caches and refreshed auth live in tmpfs.
mkdir -p "$HOME/.codex" "$HOME/.claude"
for filename in auth.json config.toml; do
  if [ "$filename" = config.toml ] && [ "${DUALLINK_CODEX_LOAD_CONFIG:-0}" != 1 ]; then continue; fi
  if [ -f "/credentials/codex/$filename" ]; then
    cp "/credentials/codex/$filename" "$HOME/.codex/$filename"
  fi
done
for filename in .credentials.json settings.json; do
  if [ -f "/credentials/claude/$filename" ]; then
    cp "/credentials/claude/$filename" "$HOME/.claude/$filename"
  fi
done
export CODEX_HOME="$HOME/.codex"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
exec "$@"
