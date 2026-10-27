# Reply claim guard

Source: [27Oct design](/home/adelost/lsrc/.artifacts/claim-guard-20261027/DESIGN.md), task107. One policy checks completed agent replies in both JSONL and native-runtime mirrors. It never checks incoming human messages.

`AMUX_CLAIM_GUARD=shadow` is the default: post immediately, classify asynchronously and append a private decision to `~/.agentmux/claim-guard/decisions.jsonl`. `off` stops checking. `enforce` requires a matching qualification file; otherwise it remains shadow and logs the refusal. Git/file checks run in one worker thread, with a bounded request lifetime, outside the human-delivery event loop.

`core/claim-guard.mjs` checks present/past software, service, release, account, quota, key, test, existence and cause assertions. Questions, plans, NEXT and explicit uncertainty pass. A citation belongs to its sentence or bullet. Paths/lines use the observed `origin` default tip, never working-copy bytes; commits must resolve. URLs/delivery references establish source presence, not their truth. A denial also needs a search command, tree and SHA. Quoted commands are never executed.

Limit: reference existence cannot establish that its contents support an assertion, that the branch was freshly fetched, that a cause is correct, or that an action agrees with a human decision. The stale-checkout example has an existing path/line, so this policy does not catch that error. The ancestry comparison is a method error. Key requests under NEXT are plans excluded by the agreed design. Report those misses separately.

## Measure

```
amux claims check --since 24h --known /private/confirmed-groups.json --output /private/today.json
amux claims check --day 2026-10-26 --output /private/held-out.json
amux claims check --input /private/today.json --known /private/confirmed-groups.json --review /private/labels.json --held-out /private/reviewed-held-out.json --output /private/graded-today.json
```

Corpus includes canonical `post`, `kind:reply`, `status:sent` rows only, all panes, with exact IDs, timestamps, text and hashes. `--input` rechecks that frozen corpus, so ongoing new replies do not invalidate a review sample. The report's stable pseudorandom sample has every hold when ≤50, otherwise50. The review names the corpus/policy hashes; each label names original ID, text hash, flagged-sentence hash, `falseStop` and a reason. Grade a false stop only when all flagged sentences are nonclaims or already adequately sourced. A genuinely unsupported assertion makes the reply a true hold, even if other flags are wrong. Retain that sentence-level limitation.

Qualification requires confirmed seven error groups, ≥5 caught target assertions, both days completely graded, ≤10% false stops on each, different ordered days and identical policy hashes. Do not count another sentence's flag as detecting a known error. lsrc:0 confirmed the27Oct content/time mapping; pre07:06Z key requests violate prior decision, later ones also conflict with code.

After a real shadow observation, the owner may save `{algorithm,today,heldOut}` from qualified reports to private `qualification.json` and select enforce through normal environment/reload. That file does not itself change the mode. No automatic model grading, account changes or retries.

## A held reply

The hold owner durably stores the original and one corrective request through the ordinary broker. A correction identifies its original turn and never gets held again; it is posted with a missing-source warning if still unsupported. A new human message immediately releases held originals with that warning, independently of inbound delivery. Unsent correction requests use ordinary cancellation; submitted/unknown ones remain protected.

Before releasing to Discord the hold records `sending`. A failed/lost send response is `unknown`, and neither restart nor another human message replays it. Discord chunks and attachments retain the normal limits. Pending content and decision logs remain private.
