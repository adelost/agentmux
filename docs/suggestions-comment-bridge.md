# Suggestions comment bridge

The Suggestions comment bridge polls public boards once per minute and routes
new human `creator`/`user` comments to an explicitly configured amux pane. It
does not hold an `ADMIN_TOKEN`, Google session, cookie, or any other Suggestions
credential. After bootstrap, an idle poll reads config plus each mapped ticket
list; ticket details are fetched only for changed tickets or a due unanswered
reminder. It does not prompt an agent or spend model tokens.

## Configure routing

Install creates `~/.config/agent/suggestions-comment-bridge.yaml` from the
reusable example if the file is absent:

```yaml
baseUrl: https://suggestions.v1d.io
projects:
  skydive:
    agent: skydive
    pane: 3
```

The mapping is deliberately explicit. To reuse the bridge for another board,
add its public project ID and responsible amux target. A configured ID that is
not returned by `/api/config` is a visible error; public projects without a
mapping are intentionally ignored.

Every handoff includes the global implementation policy. The relay prefers the
bounded canonical structured `implementationPolicy` supplied by `/api/config`
(`title`, `summary`, `principles`, `boundary`, and the complete
`commentIntent` object), serializes it deterministically, and also accepts the
legacy string form. When the endpoint has no policy, the checked-in fail-safe
is:

> Rotorsak före plåster: förstå och åtgärda grundorsaken. Refaktorera den
> berörda sömmen när en hållbar rotfix kräver det och lämna berörd kod bättre.
> Följ kodstandarden; gör lösningen datadriven, deklarativ och generisk där det
> är lämpligt. Lägg en permanent regressionsgate för felklassen. Gör ingen
> orelaterad eller spekulativ refaktorering.

`implementationPolicy` in the local YAML may override that built-in fallback.
A valid bounded API policy still takes precedence.

## Install and operate

```bash
bin/install-suggestions-comment-bridge.sh install
bin/install-suggestions-comment-bridge.sh status
bin/install-suggestions-comment-bridge.sh run-once
bin/install-suggestions-comment-bridge.sh remove
```

`install` replaces any older tagged entry and leaves exactly one `* * * * *`
cron line. `run-once` uses the same non-blocking `flock` as cron, so overlapping
runs cannot enqueue the same stage. `remove` removes only cron; config and audit
state remain for a later reinstall.

Default local files:

- Config: `~/.config/agent/suggestions-comment-bridge.yaml`
- State: `~/.agentmux/suggestions-comment-bridge-state.json` (mode `0600`)
- Lock: `~/.agentmux/suggestions-comment-bridge.lock`
- High-signal log: `~/.agentmux/suggestions-comment-bridge.log`

Environment overrides for service/test installations are
`AMUX_SUGGESTIONS_CONFIG`, `AMUX_SUGGESTIONS_STATE`,
`AMUX_SUGGESTIONS_LOCK`, `AMUX_SUGGESTIONS_LOG`,
`AMUX_SUGGESTIONS_AMUX_BIN`, and `NODE_BIN`.

## Delivery and answer contract

On first bootstrap, a human comment is routed only when no later `kind=agent`
`purpose=comment` exists in the authoritative chronological thread. Evidence,
system, agent, and AI content is never routed as human input. Evidence alone
does not acknowledge a human comment.

Successful durable enqueue is recorded as a delivery attempt, not as an
answer. The comment becomes answered only after a later `kind=agent` plus
`purpose=comment` appears in the API. AI, system, and evidence comments never
count as answers. Several human comments before one such
reply are all acknowledged by that reply. If no answer appears, the relay uses
a bounded schedule: initial handoff, reminders after 15 minutes, 60 minutes,
and 4 hours, followed by one explicit operator error notification. Each stage
has a deterministic delivery-queue idempotency key, and state advances only
after amux accepts the durable enqueue. One failed target remains pending and
is reported as a non-zero aggregate poll error, but it does not prevent other
mapped projects or comments from being durably enqueued and checkpointed.
The operator notification follows the same isolation rule: a failed notify is
aggregated and remains retryable without blocking other mappings. Its
deterministic identity is forwarded to `amux notifyuser`, which derives a
stable Discord `nonce`, keeps a non-expiring local receipt after success, and
sends with `enforce_nonce`; a crash after Discord accepts the notification but
before relay-state persistence can therefore retry without creating a second
operator message.
Tracked unanswered ticket IDs are polled directly when a reminder is due, so
the schedule continues even after a busy board's bounded list no longer
contains that ticket. If that authoritative detail endpoint returns `404`
because the tracked ticket was deleted or archived, the relay writes a durable
`ticket-not-found` terminal tombstone, logs it once, stops retrying that ticket,
and continues other mappings.

Every prompt requires the responsible agent to re-read the raw suggestion,
current ticket, entire chronological thread, and all attachments; form the
likely intent; compare it with title/problem/expected/criteria; correct drift
through the admin API; ask a focused clarification if ambiguity remains; and
then answer in Suggestions. Title, author, comment body, and attachment
metadata are normalized and encoded as bounded terminal-safe JSON inside a
payload-dependent fence that the encoded payload cannot contain. Prompt text,
media, tokens, and credentials are never written to relay state or logs.

The public API contract is intentionally strict: `/api/config` must enumerate
projects, `/api/tickets?project=...` must return `tickets[]`, and each ticket
detail must return an ordered `comments[]`. Network failures, malformed JSON,
unknown comment kinds/purposes, and endpoint/schema drift fail visibly without
advancing delivery state.
