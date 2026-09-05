# Codex delivery evidence

> **Why:** A journal-format change must not turn a completed instruction into a retry.

The shared reader accepts legacy `event_msg/user_message` and modern
`response_item/message` records with `role=user`, `input_text` content and
matching `content_item_kinds=user.text`. Environment/AGENTS records, assistant
quotes, tool output, unsupported kinds and untyped response items are not
receipts. The exact text must occur after the saved append cursor, or satisfy
the existing timestamp boundary for cursorless callers. No substring matching
or mutation of provider JSONL participates.

Modern inputs are normalized in memory for the existing turn extractor, log
and watcher. Representation twins in dual-format journals produce one logical
prompt; repeated authored inputs remain separate. The original source record
hash is retained. Receipt checks operate directly on appended source records.

After a Codex submit fence, an empty composer, a retained draft, a dead process
or a closed task does not prove that the instruction never ran. None authorizes
another Enter, a restart or a resend. An exact receipt acknowledges normally.
An idle closed task without an exact receipt becomes `delivered_unverified`
after the existing one-minute boundary, preserving the original cursor,
payload, attempts and submit timestamp. Other ambiguous submissions retain the
existing bounded wait. Pre-submit paste recovery and native HTTP idempotency
are unchanged. This slice does not redesign Claude's compact-epoch recovery.

Regression: typed inputs without legacy markers must remain visible in logs
and reconcile through the normal broker lease without any physical methods.
Unknown future input kinds must finish unverified rather than enter the retry
lane. An unverified outcome is not an ACK and is not `NOT SENT`.
