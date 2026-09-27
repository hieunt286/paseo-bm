#!/bin/bash
# Creates a small git repository under the work dir and registers it with the
# isolated daemon as a project and a workspace. Prints the workspace id.
#
#   source <work-dir>/env.sh; scripts/manual-test/new-workspace.sh <name>
set -euo pipefail
: "${BM_TEST_WORK:?source <work-dir>/env.sh first}"
name=${1:?usage: new-workspace.sh <name>}
repo="$BM_TEST_WORK/$name"
mkdir -p "$repo"
cd "$repo"
git init -q
printf 'export function add(a, b) {\n  return a + b;\n}\n' > math.js
printf '{\n  "name": "demo",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > package.json
git add -A
git -c user.name=test -c user.email=test@example.invalid commit -qm init
project=$(paseo project create "$repo" --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).projectId))')
paseo workspace create --isolation local --path "$repo" --project "$project" --title "$name" --json \
  | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).workspaceId))'
