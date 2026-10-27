# Reply claim and task-name checks

Owner claw:5. Current scope: lsrc:0 delivery:3492a7d90e971a0c87e4e2db0d99cb54,27Oct09:11:59Z, and skyvw:0 delivery:73259b19faa1a13cf70a52e5e7c85d2c,09:15:52Z. These supersede the original broad classifier and the dependency that delayed task names and the state-age guard. Original evidence remains in `/home/adelost/lsrc/.artifacts/claim-guard-20261027/`.

## Current policy

`core/claim-guard.mjs` checks only requests for Mattias to run a command, supply a key or make a decision; assertions about operational state such as live/deployed/fixed/working/user impact; and technical-cause assertions. Other facts pass. A human request still needs justification under NEXT or when phrased as a question. Plans, investigations and explicit uncertainty are excluded from factual checks.

Evidence is a valid file:line at an observed origin default tip, a saved receipt/log/response, or a quoted command with captured output. A bare SHA or ordinary website URL no longer establishes justification. A dedicated Kvitto/Receipt/Log/Sparat svar line covers its reply; an unrelated source on another bullet does not. Quoted commands never execute. Existence establishes neither relevance nor truth.

The independent name check reports first mentions of known ledger IDs and explicit row/PR/ticket references without a nearby name of2–4 words in parentheses or after a comma. Recognized code, URLs, versions and measurements are excluded. Names are logged under `names` and measured separately; they never inflate claim catches or hold a reply through claim enforcement. Ambiguous numbers and local artifact paths remain measured limitations.

`AMUX_CLAIM_GUARD=shadow` remains the authorized default. Completed replies post immediately; the isolated source worker appends asynchronous decisions in `~/.agentmux/claim-guard/decisions.jsonl`. `off` disables checking. Both reply watchers share the policy. Human input remains independent of checking and checker errors.

## One final measured round

The original eight false stops on26Oct were grouped before the final round: four plans/investigations, two evidence-path resolution failures, one visual hypothesis and one caution that an observation was not proof. The largest class was addressed by the narrowed policy. There was no further tuning after the final sample review.

The corpus is unchanged:687 canonical sent reply posts on27Oct and2522 on26Oct. Each policy/day uses the deterministic SHA256 sample rule, at most50 holds. Every selected flag was reviewed manually by the owner; ambiguous full replies were reopened. This is not independent human grading.26Oct was inspected in an earlier round and is no longer unseen validation.

| Check/day | Before held | After held | Before false stops | After false stops |
| --- | ---: | ---: | ---: | ---: |
| Claims27Oct |426/687,62.01%|133/687,19.36%|2/50,4%|6/50,12%|
| Claims26Oct |1511/2522,59.91%|463/2522,18.36%|8/50,16%|16/50,32%|
| Names27Oct |not built|380/687,55.31%|not measured|7/50,14%|
| Names26Oct |not built|1555/2522,61.66%|not measured|5/50,10%|

Known errors belong to27Oct: inclusive catches5/7→4/7; strict catches4/7→4/7. Late key requests are now detected; the general absence-of-tool statement is outside the narrowed policy. Stale-but-existing citations and the ancestry method error remain missed. Another flagged sentence in a reply does not count as catching those errors.

All activation targets fail: strict catches below5/7, false stops above10%, and hold share above10% on both days. The narrowed sample concentrates false positives while total holds decline. The checks stay in shadow; no third tuning round is authorized. Only lsrc:0 decides future activation. Qualification now requires both days' hold shares≤10%; no qualification file is written.

## Reproduce

```
amux claims check --input /private/frozen-report.json --known /private/known.json --output /private/rechecked.json
amux claims check --input /private/frozen-report.json --known /private/known.json --review /private/claim-labels.json --name-review /private/name-labels.json --held-out /private/graded-26oct.json --output /private/graded.json
```

`--input` preserves IDs, text hashes and the original window while running the live policy. Claim/name labels independently bind corpus, algorithm, text and flag hashes. Final graded reports, labels, grouped causes and the current delivery receipt are in the existing artifact directory; old reports and the1.25.370 live shadow proof remain historical evidence.

The transport retains one durable hold/correction per turn, immediate release on human input, cancellation for unsent corrections, and an unknown-send fence preventing replay. Those mechanics do not authorize activation.

## Shadow counter and deferred classifier trial

lsrc:0 delivery:2b243dda0a0f21f13b0503f841df70a2,27Oct10:29:38Z closes heuristic tuning. Plain `amux quota` shows one line with actual unique shadow-held turns recorded today in UTC. Duplicate turn decisions, name-only warnings and other event types do not count. JSON quota output is unchanged. Missing or malformed measurement data is not reported as a verified zero.

Task111 is unassigned P3: a future Haiku trial through api.v1d.io, product bench, on300 replies from the same frozen corpus, with a hard total0.50USD ceiling. It cannot start until the gateway has ANTHROPIC_KEY and lsrc:0 gives a new explicit start instruction. No API calls or spending are authorized now.
