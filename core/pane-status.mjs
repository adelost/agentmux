// Single source of truth for pane statuses and their behavioral traits.
//
// Before this table every consumer kept its own hardcoded status list
// (icon map, done-buckets, compact-safety, live-checks, sort tiers — ten
// scattered lists). Each new status meant hunting them all down, and two
// new statuses arrived the same week ("interrupted" from the ai:4 codex
// stream-error incident, "limited" for rate-limited panes right behind
// it). Adding a status is now ONE row here; consumers ask trait questions.
//
// Traits:
//   icon          - glyph for ps/top/done
//   live          - the pane is actively producing a turn right now
//   needsHuman    - blocked on a human/orchestrator decision (modal,
//                   interrupted turn) — surfaces in done's 🔴 bucket
//   compactUnsafe - sending /compact now would interrupt or misfire
//   tier          - sort priority for ps (higher = shown first)
export const PANE_STATUS = {
  working:     { icon: "🟢", live: true,  needsHuman: false, compactUnsafe: true,  tier: 3 },
  permission:  { icon: "🔴", live: false, needsHuman: true,  compactUnsafe: true,  tier: 3 },
  menu:        { icon: "🔴", live: false, needsHuman: true,  compactUnsafe: true,  tier: 3 },
  interrupted: { icon: "🔴", live: false, needsHuman: true,  compactUnsafe: true,  tier: 3 },
  resume:      { icon: "🟡", live: true,  needsHuman: false, compactUnsafe: false, tier: 2 },
  dismiss:     { icon: "🟡", live: false, needsHuman: false, compactUnsafe: false, tier: 2 },
  idle:        { icon: "💤", live: false, needsHuman: false, compactUnsafe: false, tier: 1 },
  unknown:     { icon: "⚪", live: false, needsHuman: false, compactUnsafe: false, tier: 0 },
};

export const statusIcon = (s) => PANE_STATUS[s]?.icon || "⚪";
export const isLiveStatus = (s) => PANE_STATUS[s]?.live ?? false;
export const needsHumanStatus = (s) => PANE_STATUS[s]?.needsHuman ?? false;
export const statusTier = (s) => PANE_STATUS[s]?.tier ?? 0;
// A status string we don't know is treated as UNSAFE to compact — the
// failure direction of a wrong "safe" is a /compact fired into live work.
export const isCompactUnsafe = (s) => PANE_STATUS[s]?.compactUnsafe ?? true;
