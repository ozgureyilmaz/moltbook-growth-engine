#!/usr/bin/env bash
set -euo pipefail

# Hermes calls this repository script through a small ~/.hermes/scripts wrapper.
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
task_node="${MARX_FEED_NODE:-${MARX_GROWTH_NODE:-$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin/node}}"
if [[ ! -x "$task_node" ]]; then
  echo 'Set MARX_FEED_NODE to the absolute Node 22 executable path.' >&2
  exit 1
fi
export PATH="$(dirname -- "$task_node"):$PATH"
if [[ "$("$task_node" -p 'process.versions.node.split(".")[0]')" != '22' ]]; then
  echo 'The feed worker requires Node 22 and its matching SQLite native module.' >&2
  exit 1
fi
task_result="$("$task_node" dist/cli/main.js marx-feed-cycle "$@")"
# Unchanged feeds are quiet; completions and failures remain visible to Hermes.
"$task_node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s);if(r.status!=="NO_NEW_FEED")process.stdout.write(JSON.stringify(r,null,2)+"\n")})' <<< "$task_result"
