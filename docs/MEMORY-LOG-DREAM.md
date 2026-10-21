# Conversation-first memory, 2026-10-21

Authority: lsrc:0 P1 brief, followed by his correction withdrawing point 1. Keep all conversation content, including compact tool mirrors actually posted to Discord. His next addendum requires one UTC-day file under `~/.agentmux/ask-ledger/YYYY-MM-DD.jsonl` and lossless splitting of retained legacy files. No content cleanup, schema change or post-kind change is authorised.

Outcome: search finds his words and posted answers first with explicit authors; Dream derives the digest from that log, not hand-written diary sections; the failed 21 October night is recovered with original proof and no repeated model request. Only the compact MEMORY.md registry belongs in automatic startup context. lsrc:5 owns protocol text and hook wording, coordinated separately.

Initial evidence: nightly input 13adc1b0 was created 02:00Z; controller stopped 02:21Z with dream-output-missing; original curator product and terminal DREAM_OK appeared 03:55Z. The ten-minute catch-up only sees a prior failed attempt and never recovers that late product. The original summary validates now. Inspect original delivery/terminal proof before committing any recovery. No submitted prompt may be resent.

Implementation steps:
1. Search: preserve all indexed content; rank original human inputs and narrative replies above derived notes and tool-only mirrors; show han and panel:N svarade. The normal cold path must not silently omit the conversation log.
2. Dream: conversation-only collection when the log is selected, including unanswered inputs; remove manual-diary reads from new curator prompts. Keep legacy recovery's exact original prompt and input identity valid.
3. Recovery: reuse the existing checked recovery route for a completed late product; catch-up never sends another curation. Preserve run, session, quality, terminal, concurrent-memory and one-attempt fences. Prove the recovered night via readDreamSuccess/doctor and recorded source/product identities.
4. Integrate lsrc:5's independent hook/text bank, fresh focused checks, immutable release and installed smoke. No hand-written daily entry is part of this work.

Test map (shared focused run plus smoke <=300 s; existing component cases remain):
- core/search-conversation.test.mjs -> original human/reply beat tool mirrors; row ids and exact expansion survive: component, update 5 min, run 1 s.
- cli/search.test.mjs -> cold default includes log, source filters preserved, original sources lead derived ones: component, update 5 min, run 2 s.
- core/search.test.mjs -> source labels identify han and panel:N svarade: unit, update 2 min, run 1 s.
- core/conversation-window.test.mjs -> indexed ordering equals scan after priority changes, no unsafe early cutoff: component, update 0 min, run 3 s.
- core/dream-conversation.test.mjs and core/dream-summarizer.test.mjs -> log-only collection never calls provider history, pending human inputs remain: unit/component, update 5 min, run 2 s.
- core/dream-owner.test.mjs -> new prompt reads the log packet, no diary instructions; legacy prompt remains reproducible for recovery: unit, update 3 min, run 1 s.
- core/dream-schedule.test.mjs, test/dream-recovery.test.mjs, test/dream-terminal-receipt.test.mjs -> late original product recovered once, no dispatch, no compact, no invented completion: component, update 10 min, run 4 s.
- Hook/text seam tests selected from lsrc:5's actual diff; no duplicate reimplementation.

Red first on the missing search preference/cold-log behavior and late-recovery path. No test or production threshold is raised. Runtime log and handwritten diary originals stay recoverable. Byte counts distinguish unchanged log, bounded input packet and generated digest; no deleted log bytes count as a saving.
