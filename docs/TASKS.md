> AMUX cost and model recovery work requested by Mattias on 2026-09-20.

Done requires targeted regression proof, strict changed-file lint, a receipted installed release, and verification through the actual bridge. Tests use synthetic logs and mocked provider boundaries; real compaction is recorded separately. Policy: [AMUX-COST-POLICY.md](AMUX-COST-POLICY.md).

| # | Outcome | Owner | Done when | State | Closed on |
|---|---|---|---|---|---|
| 1 | Requested AMUX cost policy is installed and documented | Codex root | Rows 2–5 verified; installed bridge reports the release SHA | Closed | 1.25.77 / 5091190d8ac5; running bridge SHA, pid and readiness agree |
| 2 | Codex panels report their own model, retain choices and compact before changes | Codex root | Parent-session regression red/green; launch and work gates verified; existing Codex choices set to Sol | Closed | 34 Sol choices saved, three active panes compacted and verified; later user choice ai:3 Astra verified after compact, same session. Final saved choices: 33 Sol, 1 Astra |
| 3 | Idle compact prevents repeated large-context wakes | Codex root | 10-minute/150k rule, exact receipt and no retry without new work verified | Closed | 473k/56% old decision none, fixed warn; durable fence survives controller restart; stopped-process regression red/green; shared night fence avoids a second paid compact |
| 4 | Cold wake and nightly contention fail safely | Codex root | 24-hour/150k wake guard and bounded lease retry verified, no duplicate paid compact | Closed | Nightly busy-lease case red/green, one simulated compact after three checks. Active giant-turn usage fallback verified live by recovered skyvw:0/2 deliveries. Explicit model-control lock waiting tested and ai:3 change completed |
| 5 | Operator and orchestrator documentation matches shipped behavior | Codex root | Generated rules and cost policy describe quotas, limits, proof and recovery accurately | Closed | AMUX-COST-POLICY.md packaged; hints v1.25.14; DSL tables cover 18 context states and 24 launch states |

Verification limits: 31 previously stopped Codex panes were deliberately not awakened. Their guarded transitions occur before their next work prompt. The next scheduled nightly run was not forced or observed. Two independently queued Skyvw `/compact Keep...` jobs remained `delivered_unverified` at final inspection; they retain their receipt watch and were not replayed. Their earlier work-message heads were acknowledged after the active-turn clock fix.

Tests: the broad affected-file run passed 311 tests in 1.96s. Follow-up fixes used only their affected files, including 62 model/handler tests in 1.70s and the stopped-process regression in 0.44s. Strict changed-file lint passed. Automated tests use synthetic logs and provider/process doubles, not live AI calls.
