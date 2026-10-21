# Demand-read fleet policy, 2026-10-21

Authority: [lsrc:0: Tillägg 2026-10-21 ~09:3xZ](../../../.agentmux/PRIORITIES.md). This replaces the decision to retain the 15.5k automatic file. Read that decision only when needed.

The generated register retains Orient, Send exactly once, Verify before reporting, Kommunikationsdisciplin and six one-sentence staffing rules. Ten explicit read triggers point at `docs/fleet/`, using the installed package's absolute path. The npm artifact includes those files. Runtime generation does not read their contents. Drift-guard keeps core and global sections, and names the actual merge/idle document when that rule moves.

Full old sections, dated rules and quotes move without wording changes. api:3's C bank, `1f4cf48a`, is applied by its net change as `0c6de9db`: only an explicit operator request may skip the source compact at a provider-confirmed spent 5h window. Automatic recovery is unchanged.

Verification plan: `test/hints-budget.test.mjs` (register <=8 KiB and required triggers), `test/fleet-policy.test.mjs` (loss/broken-link refusal), `core/reminder-state.test.mjs` (both engines, rotation and real target headings), `test/agent.test.mjs` (existing contracts through register plus linked rules), `core/hints-sync.test.mjs`, `cli/hints-sync.test.mjs` (generation, warnings and operator tails), `cli/codex-account-switch.test.mjs`, `core/codex-limit-recovery.test.mjs` (C boundary). Targeted run estimate 20 s plus strict changed lint and one installed smoke, total <=300 s. No full-repository suite.

Red first: the register test refuses missing read triggers; the reminder test refuses the old generated-file target. Green: 134 cases in eight files, 1.77 s before the final heading check. The CLI sync test now expects no size warning for the short register; its 9 KiB warning boundary remains tested unchanged in `core/hints-sync.test.mjs`.

Losslessness check: save the old generated file, generate the new one, then run `node bin/check-fleet-policy.mjs BEFORE.md REGISTER.md`. Every original paragraph/list item must appear verbatim apart from whitespace wrapping in the register or a directly linked document. An unlinked archive does not count. Initial result: 51 blocks, 10 linked files, zero missing. Removing the real 2026-10-10 no-fork paragraph makes it refuse and names the exact lost quote.

Before file with C: 15,659 bytes. Initial source register: 4,419 bytes. Installed paths make its exact size environment-dependent. Full receipts, original backup and the Opus A/B inputs live at `~/lsrc/.artifacts/agent-health-2026-10-21/fleet-registry-ai3/`. Final installation, generated-file byte count and fresh Opus token result are recorded there after release. Compare only the same `ab_start.sh` setup and MEMORY.md: ai:0 measured 35,903 at 08:4xZ, then 36,050 at 09:29Z, about ±200 noise; this is print-mode startup, not a normal pane or a compact.
