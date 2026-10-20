# Leading slash prose, lsrc:3 input stop, 2026-10-20

Source: Mattias direct repair request in lsrc:4, approximately 18:26Z, followed by the request to prevent recurrence approximately 18:28Z. Own implementation choice below.

1. Restore lsrc:3 and preserve both original human questions. Live original question is working after removing only its invalid slash heading; later delivery 380dc5b0 has an ordinary receipt at 18:27Z. No engine restart or replay of product work.
2. A command name must match command syntax, not absorb punctuation, paths, Unicode prose or newlines. Preserve real commands and their arguments.
3. A message explicitly delivered as a prompt must enter the engine as prose even if its original first character is `/`. Preserve the original message byte-for-byte and keep the exact original echo requirement. Never reinterpret an unknown submitted operation or erase another draft.

Budget: build and delivery 15 min; test writing at most 3 min, targeted tests plus one local smoke at most 60 s. No real model call used as a test.

Test plan, before implementation:

| Seam | Test and guarded behavior | Level | Write | Run |
| --- | --- | --- | --- | --- |
| lib.parseCommand | lib.test.mjs: malformed slash heading with newline body is prose; valid commands, double slash and arguments remain supported | unit | 1 min | 2 s |
| Discord ingress and prompt delivery | test/handlers.test.mjs: same heading/body queues as a message and passes real deliverToPane plus Codex event extraction with an exact receipt; terminal I/O double emits no user event for a leading command | component, existing broker/terminal boundary doubles | 2 min | 3 s |
| Existing consumers | lib.test.mjs, core/delivery.test.mjs, test/handlers.test.mjs, core/slash-ingest-guard.test.mjs | existing component selection | 0 | 15 s |
| Related selector and package | bin/focused-tests.test.mjs, handlers.test.mjs, test/attachments.test.mjs, core/release-install.test.mjs: existing tests selected for shared fixture mapping, version and preserved consumers | existing targeted selection | 0 | 30 s |
| Installed path | installed parse + prompt delivery with captured terminal boundary and ordinary JSONL echo; real command classification unchanged | local smoke | 0 | 5 s |

Small first: public parser and existing delivery/ingress fixtures exercise the failing shape before implementation. Original live recovery is separate evidence, not a test model call. No browser required.

Receipt review: keep framing at Discord ingress, before queue freeze and cursor capture. Both text and verifyText describe the exact physical message. Original body remains a byte-identical suffix and is separately retained by the inbound store. An initial delivery-only framing prototype was removed: it could invalidate the broker's later exact receipt. Its mirrored sink test was replaced by the composed ingress/delivery test above, which uses the real Codex event extractor. No receipt equality was weakened.

Selected existing tests: handlers.test.mjs had two test-class failures on unchanged sendSlashVerified. Its terminal double consumed the first post-submit image while the production code captured its pre-submit rejection fingerprint. The double now distinguishes before/after submit; the first two internal-call assertion is replaced by the public terminal-write requirement, exactly one unchanged command. Rescue Enter expectations remain. No production slash delivery change.
