# Suggestions watchdog outbox delivery

Suggestions durably queues assignment/watchdog alerts. This local agentmux
consumer closes the external side effect: every minute it reads the `source`
project's public registry, polls every accessible project outbox, reads each
project's current bootstrap `brokerOwner`, and writes the immutable alert
prompt into agentmux's durable delivery queue. New public projects are included
without a cron or config edit. A bounded explicit `projects` list remains
available as an intentional operational override.

The remote outbox is acknowledged only after the delivery broker has recorded
an exact `acknowledged` receipt. A queue timeout, target failure,
`delivered_unverified`, malformed response, or failed HTTP acknowledgement
leaves the alert pending. The next run reuses
`suggestions-watchdog:<project>:<dedupe-hash>`; if delivery succeeded but the
HTTP ACK was lost, the existing local receipt makes the retry ACK-only without
another pane write. An existing key with different prompt or target data fails
closed.

## Install and operate

Do not install or schedule the consumer against an unaudited backlog. The
initial rollout is deliberately operator-gated: first deploy the assignment
lifecycle cleanup, verify that stale alerts are removed or reclassified, then
run one current synthetic alert as a canary and confirm its real agentmux
receipt plus Suggestions ACK. Enable the one-minute all-project schedule
only after that canary passes.

```bash
bin/install-suggestions-watchdog-outbox.sh install
bin/install-suggestions-watchdog-outbox.sh status
bin/install-suggestions-watchdog-outbox.sh run-once
bin/install-suggestions-watchdog-outbox.sh remove
```

The installer creates
`~/.config/agent/suggestions-watchdog-outbox.yaml` mode 0600 from the checked-in
example and owns one tagged cron entry. It requires the existing read/admin
token files mode 0600; credentials are sent only as bearer headers and are
never put in arguments, logs, prompts, local queue metadata, or URLs.

Healthy empty polls are silent. High-signal results and retryable failures go
to `~/.agentmux/suggestions-watchdog-outbox.log`. A non-blocking flock prevents
overlap. The server outbox remains the cursor; removing/reinstalling the local
consumer cannot mark an undelivered alert as sent.

Assignment offers have an additional fail-closed availability gate. The
consumer routes the immutable offer prompt to its declared owner only when
that pane is idle and either its latest reply explicitly reports completion or
it has remained idle for the Suggestions-owned threshold (currently 10
minutes). A
working, waiting, modal, unknown, or briefly idle pane keeps the outbox item
pending and is never interrupted or given a queued second assignment. Other
watchdog alerts continue to route to the project broker.

`assignment_offer_delivery` is delivered byte-for-byte from its snapshotted
`payload.offerPrompt` to `payload.targetAgent`. `broker_check_due` is delivered
byte-for-byte from its snapshotted `payload.resolvedPrompt`. Other watchdog
kinds use a deterministic bounded JSON envelope addressed to the bootstrap
broker.
