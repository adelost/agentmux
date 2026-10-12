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

A fully observed successful compact with no authored input or product output
is maintenance, not superseding work. A task start alone, an incomplete compact,
an error, real input or tool work receives no exemption.
The final check reads at most eight MiB, only with an idle composer; lsrc:4's
actual compact record exceeded 1.5 MB. An augmented continuation is identified
by its frozen physical payload, so memory orientation cannot reset the budget.
Three confirmed failed continuations record `exhaustedAt` in existing recovery
state. The existing stall-watch cron reads it and queues one investigation.
It also coalesces stalled human messages per lane, keeps failed alerts retryable,
and routes to the AMUX owner when the orchestrator's own lane is blocked for
ten minutes. It never sends a fourth model retry or changes a model/account.

## Unverified submit blocking human input

Only an exact authored event after the saved byte cursor earns acknowledgement.
Reading an image from the queue, an assistant mentioning it, or a goal's internal
context is not that receipt. A later closed Codex turn can release the lane as
`delivered_unverified` after one minute, even if another goal turn is already busy.
With no closed turn, a waiting human Discord message bounds this ambiguity to
ten minutes. Native runtime completion keeps its own contract. Neither verdict
resends the original, clears the composer or claims the original was not sent.
The ordinary broker delivers subsequent prompts once, in FIFO order. The
existing stall-watch investigates stalled deliveries; it is not a second writer.

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

At the reached limit AMUX transfers only that pane's quiescent rollout to the
other account. Credentials are never copied. An existing target is replaced
only when its bytes are an exact prefix of the source, no target writer exists,
and the source did not change during the verified atomic copy. Divergent history
is preserved. A real isolated Sol session resumed on account 2 on 2026-10-12;
the provider accepted the copied history and returned `CONTINUITY_PROBE_OK`.

If a session cannot be transferred safely, the authorized fallback creates
one fresh Sol/xhigh session on the other account. Before restarting, AMUX saves
the exact latest assignment and reply posts from the conversation log in a
private handover. The new prompt explains the new account/session, links the
original evidence, requires reading Git and receipts, and forbids replaying a
release, move or go without its receipt. Missing task evidence blocks the
fallback. The same opt-out applies. An ambiguous submitted handover is never
replaced with another send.

After verification, the broker receives one ordinary continuation with the
same pre-submit guards as capacity recovery. Other errors only notify.
Set `AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false` in the bridge environment to
disable account recovery. Restart the bridge while its delivery queue is clear.

## Unavailable historical model

Astra launches and explicit Astra choices are refused under Mattias's current
policy. For a stopped pane whose old session cannot compact, explicitly run:

```
amux model PROJECT -p N sol xhigh --new-session
```

This creates a new conversation, verifies Sol/xhigh and the new session id,
preserves the old journal and its id, and sends no previous prompt again.
It refuses working panes and queued deliveries. Ordinary wake still resumes
the owned session; it never silently resets history.
