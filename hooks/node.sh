#!/bin/sh
# Starts a hook script on Node.js 20 or later. Claude Code runs hooks in a non-interactive shell,
# which often lacks the PATH a version manager (nvm, fnm, volta, asdf, mise) sets up in .zshrc or
# .bashrc; there a bare `node` is "command not found" and every hook fails.
#
#   sh node.sh [--fail-closed] <script.mjs> [args...]
#
# Looks, in this order, for: $PIPE_NODE, `node` on PATH, then volta, asdf, mise, fnm, nvm (newest
# version first), Homebrew and the system folders. Takes the first one that is Node.js 20 or later.
# When none is found it says so on stderr and exits 2 with --fail-closed (a PreToolUse gate blocks
# the call rather than let it through unchecked) or 1 otherwise (a hook error that blocks nothing,
# so a Stop or SubagentStop hook never traps the agent).

fail=1
if [ "$1" = "--fail-closed" ]; then
  fail=2
  shift
fi

found=""
seen=""

consider() {
  [ -n "$found" ] && return
  [ -n "$1" ] && [ -x "$1" ] || return
  major=$("$1" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null) || return
  seen="$seen $1 (v$major)"
  [ "$major" -ge 20 ] 2>/dev/null && found="$1"
}

consider "$PIPE_NODE"
consider "$(command -v node 2>/dev/null)"
consider "$HOME/.volta/bin/node"
consider "${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node"
consider "$HOME/.local/share/mise/shims/node"
for fnm in "$FNM_DIR" "$HOME/.local/share/fnm" "$HOME/Library/Application Support/fnm" "$HOME/.fnm"; do
  [ -n "$fnm" ] && consider "$fnm/aliases/default/bin/node"
done
# nvm: the newest installed version, by numeric sort of vMAJOR.MINOR.PATCH.
nvm_dir="${NVM_DIR:-$HOME/.nvm}"
if [ -d "$nvm_dir/versions/node" ]; then
  for v in $(ls "$nvm_dir/versions/node" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
    consider "$nvm_dir/versions/node/v$v/bin/node"
  done
fi
consider /opt/homebrew/bin/node
consider /usr/local/bin/node
for brew in /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node; do
  consider "$brew"
done
consider /usr/bin/node

if [ -z "$found" ]; then
  echo "pipe: no Node.js 20 or later found for the hook ${1##*/}${seen:+ (found:$seen)}. Install it, or set PIPE_NODE to its path in the environment Claude Code starts in (for example \"env\": {\"PIPE_NODE\": \"/path/to/node\"} in ~/.claude/settings.json)." >&2
  exit "$fail"
fi

exec "$found" "$@"
