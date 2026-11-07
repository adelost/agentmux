#!/usr/bin/env bash
# Same temporary-index publication as Huset's push_ledger.sh; generator gets the latest ledger on stdin.
set -euo pipefail
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/work-ledger.mjs" "$@"
