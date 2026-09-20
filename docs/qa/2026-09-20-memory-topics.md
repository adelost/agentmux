# Source-bound memory topics, 2026-09-20

## Outcome and scope

Ordinary `amux search` can retrieve short private Markdown topics alongside
original sources. Topic state is declared with the same ProductSpec DSL used
by Skyvw and AMUX cost policy. The existing lexical and semantic source paths
remain available; `--raw` excludes derived topics. Publication never edits an
original memory file or invokes a provider.

The initial private pilot covers memory/Dream recovery and browser operation.
Personal source bytes and its six topic notes are not shipped in the package.
The CLI discovers only notes explicitly published into its workspace.

## Verification

- 44 targeted checks across topics, search CLI, lexical search, caller search
  state and memory lint pass in under one second locally.
- Source-change bypass mutation is red: pretending the changed source hash
  still matches makes the stale-result regression fail. Restored code passes.
- A real ranking error matched Swedish `samma` to `sammanfatta`; the new
  regression fails before restricting prefix matches to declared endings and
  passes after. Topic pages and question wording were unchanged by that fix.
- The DSL covers all 18 evidence/status combinations, rejects holes and
  overlaps, and admits only one combination to retrieval.
- CLI smoke uses actual `memory topics --json` and `search --show 1` paths.
- Changed-file strict lint and `git diff --check` pass. The command dispatcher
  receives flag registrations only, with no extra lines above its existing cap.
  Churn inspection flags that existing dispatcher; the new logic lives in
  separate intent-named modules rather than extending its branches.

## Retrieval measurement and limits

Twenty new questions, ten per domain, were fixed before writing pilot notes.
Their SHA256 is
`96b800cf48e671190b6140d97cda43eac298185dfc227505ec365f2b419ca1a2`.
The private artifact is `memory-wiki-prototype-2026-09-20/pilot-questions.json`.
`pilot-run.mjs` runs the same source lookup and topic code against fixed copies
of the two original references. It also tests manually shortened keyword
queries, so failure of full-sentence word-AND is not the only baseline.

- Expected topic first: 19/20; within three: 20/20.
- First expanded topic: 37/39 required string groups, 22,315 UTF-8 bytes.
- Keyword-source expansion: 30/39 groups, 31,350 bytes.
- Expanding the hybrid top three: 39/39 groups, 38,164 bytes.
- Full-sentence lexical baseline found none of the required groups here.

The first expansion uses 28.8% fewer bytes than keyword-source expansion.
Reading several topics costs more, so the workflow is overview then one
relevant expansion, not loading every topic. These are retrieval/string-group
measurements, not tokens, subscription savings or evaluated final agent answers.
One curator built both the corpus and the measurement. The generic prefix fix
used a failure found during verification; this is an acceptance set, not a
fully independent unseen benchmark. No universal memory-completeness claim.

## Persistence and rollback

Topic publication checks original file hashes, takes a kernel lease, preserves
the previous exact page in `.history`, then fsyncs and atomically replaces it.
Search rechecks on lookup and expansion. Stale, missing, invalid, conflicted
and retired notes cannot enter lexical/semantic results by their file paths.
Source hashes prove source identity, not semantic accuracy or the absence of
a later correction in another source. Curators must check the actual cited
passages and later decisions before publishing a revised note.

`--raw` is the immediate retrieval rollback. Original files remain unchanged.
Archive restoration goes through the same validator. No bridge restart is
needed for the new CLI retrieval path, and no dormant panel needs to wake.
