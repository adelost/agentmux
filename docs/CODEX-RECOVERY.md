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

Usage limits and other errors retain their existing notices and do not use
capacity retries. Recovery runs on the existing watcher poll, including its
unchanged-file path. Durable state survives bridge restarts.
