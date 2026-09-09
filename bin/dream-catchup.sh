#!/usr/bin/env bash
set -euo pipefail
exec /bin/bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dream-cron.sh" --catch-up "$@"
