#!/usr/bin/env bash
# npm-ci-guard (row 160): `npm` first on PATH (~/.local/bin/npm). Every command but ci goes to the next npm on PATH by exec, so its arguments, stdin,
# environment and exit code are the real npm's own. ci is refused where it would empty a node_modules that is not its own (Cut's main
# cloud/node_modules and ai-gateway's root, 10 Nov): npm ci empties every node_modules under the prefix it resolves, through a symlinked folder
# (npm 11.6.0 lib/commands/ci.js:88-96), and from inside a workspace member that prefix is the workspace root (@npmcli/config lib/index.js:736-737).
# The guard reads no file in the working folder: the real npm says the prefix and the workspaces, and the guard only asks whether a path exists or
# is a link.
self=$(readlink -f "${BASH_SOURCE[0]}")
real=
IFS=: read -r -a dirs <<< "$PATH"
for dir in "${dirs[@]}"; do
  [ -x "$dir/npm" ] && [ ! -d "$dir/npm" ] && [ "$(readlink -f "$dir/npm")" != "$self" ] && { real=$dir/npm; break; }
done
[ -n "$real" ] || { echo "npm-ci-guard: no other npm on PATH" >&2; exit 127; }

# the command is the first word that is not an option or an option's value; --prefix (or -C) moves the project
command='' prefix=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in
    --prefix=*) prefix=${args[i]#--prefix=} ;;
    --prefix | -C) i=$((i + 1)); prefix=${args[i]:-} ;;
    -w | --workspace | --loglevel | --cache | --registry | --userconfig | --globalconfig | --omit | --include | --tag) i=$((i + 1)) ;;
    --) break ;;
    -*) ;;
    *) command=${args[i]}; break ;;
  esac
done
case $command in
  ci | clean-install | ic | install-clean | isntall-clean | cit | clean-install-test | install-ci-test | sit) ;;
  *) exec "$real" "$@" ;;
esac

refuse() { printf 'npm-ci-guard: %s\nNothing was removed.\n' "$1" >&2; exit 1; }
probe=("$real" --silent)
[ -n "$prefix" ] && probe+=(--prefix "$prefix")
said=$("${probe[@]}" prefix 2>/dev/null) || exec "$real" "$@"   # no project: npm says so itself
# where the person stands: --prefix, else the nearest folder up from here that holds a package.json
here=$(cd "${prefix:-$PWD}" 2>/dev/null && pwd -P) || exec "$real" "$@"
start=$here
while [ "$start" != / ] && [ ! -e "$start/package.json" ]; do start=$(dirname "$start"); done
[ "$start" = / ] && start=$here
# npm prints a path with every UUID in it as *** (@npmcli/redact), so the prefix it says is compared in that form
masked() { sed -E 's/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/***/gI' <<< "$1"; }
[ "$said" = "$(masked "$start")" ] || [ "$said" = "$(masked "$(cd "$start" && pwd -L)")" ] ||
  refuse "npm ci in $start would empty $said/node_modules: npm takes $start as a workspace of $said. Run npm ci in $said."
# the workspaces by their place under the root, which npm empties too (ci.js includeWorkspaceRoot)
mapfile -t places < <("${probe[@]}" query .workspace 2>/dev/null | python3 -I -c 'import json,sys
try: print("\n".join(w["location"] for w in json.load(sys.stdin)))
except Exception: pass')
for place in . "${places[@]}"; do
  [ -n "$place" ] || continue
  modules=$start/node_modules; [ "$place" = . ] || modules=$start/$place/node_modules
  [ -L "$modules" ] && refuse "npm ci would empty $(readlink -f "$modules"): $modules is a link to it. Remove the link (rm $modules) and run npm ci again."
done
exec "$real" "$@"
