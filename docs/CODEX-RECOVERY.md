# Codex capacity recovery

The bridge reads a closed unanswered turn and the exact thread/turn error
from Codex's local SQLite log. Earlier token usage does not hide a failed
request at the end of a long turn. A null final answer alone is not proof of
failure.

Only `Selected model is at capacity.` schedules automatic continuation.
AMUX uses the same account and model, with at most three queue identities
at 2, 5 and 10 minutes after the first capacity refusal. A refused automatic
continuation keeps that original budget. A successful continuation does not
schedule another prompt without a new capacity failure.

New human or agent input supersedes the continuation. Working panes, dialogs,
nonempty composers and live deliveries hold it. The broker checks again before
the physical submit. Submitted or unverified deliveries retain their ordinary
receipt fence; recovery never rewrites them.

Recovery runs on the existing watcher poll, including its unchanged-file
path. Durable state survives bridge restarts.

## Reached weekly limit

An exact `usage limit` refusal plus a fresh official Codex weekly observation
at 100 % allows a pane-local account switch. The other account must be logged
in and have room in all reported Codex windows. Forecasts never switch accounts.

Automatic and `//switch` transitions use the same model-preserving switch,
native verification and rollback function. Automatic switching additionally
requires the exact current session to be available on the other profile, and
verifies the account identity and session after restart. No session is silently
replaced. A blocked continuity check posts one notice naming the pane. An
unknown outcome after starting a switch is never retried automatically.

After verification, the broker receives one ordinary continuation with the
same pre-submit guards as capacity recovery. Other errors only notify.
Set `AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false` in the bridge environment to
disable account recovery. Restart the bridge while its delivery queue is clear.
