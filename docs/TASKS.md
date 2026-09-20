> AMUX cost and model recovery work requested by Mattias on 2026-09-20.

Done requires targeted regression proof, strict changed-file lint, a receipted installed release, and verification through the actual bridge. Tests use synthetic logs and mocked provider boundaries; real compaction is recorded separately. Policy: [AMUX-COST-POLICY.md](AMUX-COST-POLICY.md).

| # | Outcome | Owner | Done when | State | Closed on |
|---|---|---|---|---|---|
| 1 | Requested AMUX cost policy is installed and documented | Codex root | Rows 2–5 verified; installed bridge reports the release SHA | In progress | |
| 2 | Codex panels report their own model, retain choices and compact before changes | Codex root | Parent-session regression red/green; launch and work gates verified; existing Codex choices set to Sol | Tests passed; awaiting install | 311-test targeted pass; final model/handler pass 77 tests |
| 3 | Idle compact prevents repeated large-context wakes | Codex root | 10-minute/150k rule, exact receipt and no retry without new work verified | Tests passed; awaiting install | 473k/56% old decision none, fixed warn; durable fence verified across controller restart |
| 4 | Cold wake and nightly contention fail safely | Codex root | 24-hour/150k wake guard and bounded lease retry verified, no duplicate paid compact | Tests passed; awaiting install | Nightly busy-lease test red then green; exactly one simulated compact after three lease checks |
| 5 | Operator and orchestrator documentation matches shipped behavior | Codex root | Generated rules and cost policy describe quotas, limits, proof and recovery accurately | In progress | |
