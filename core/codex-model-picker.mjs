// WHAT: Drives codex TUI's /model picker: type /model, parse the numbered
//       model list, press its digit, parse the effort list, press its digit,
//       verify the "Model changed to" confirmation line.
// WHY: Codex has NO text form of /model — forwarded "/model <name>" lands in
//      the conversation as a chat message and switches nothing (verified
//      live 2026-07-10). The picker is the only programmatic path, and both
//      Discord /model on codex panes and model-watch auto-recovery need one.
//
// Safety model: every keystroke is preceded by a capture that verifies the
// UI is in the expected stage. Digits SELECT INSTANTLY in both picker views
// (no confirming Enter), so a blind keystroke can commit the wrong row or
// type garbage into the composer of a live pane. On any mismatch the driver
// escapes back out and reports the stage it died at — it never guesses.
//
// UI reference (codex-cli 0.144.1, captured live claw:9 2026-07-10):
//
//   Select Model and Effort
//   › 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.
//     2. gpt-5.6-terra          Balanced agentic coding model ...
//   Press enter to confirm or esc to go back
//
//   Select Reasoning Level for gpt-5.6-luna
//     1. Low               Fast responses with lighter reasoning
//   › 2. Medium (default)  Balances speed and reasoning depth ...
//     4. Extra high        Extra high reasoning depth ...
//   Press enter to confirm or esc to go back
//
//   • Model changed to gpt-5.6-luna medium

const MODEL_LIST_HEADER = /Select Model and Effort/;
const EFFORT_LIST_HEADER = /Select Reasoning Level for\s+(\S+)/;
const CONFIRMATION_RE = /Model changed to\s+(\S+)(?:\s+(\S+))?/;

// Order matters: "extra high" must match before plain "high".
const EFFORT_NORMALIZE = [
  { key: "xhigh", re: /^extra\s*high/i },
  { key: "max", re: /^max/i },
  { key: "medium", re: /^medium/i },
  { key: "high", re: /^high/i },
  { key: "low", re: /^low/i },
  { key: "minimal", re: /^minimal/i },
];

export function normalizeEffortLabel(label) {
  const clean = String(label || "").replace(/\(default\)/i, "").trim();
  for (const { key, re } of EFFORT_NORMALIZE) {
    if (re.test(clean)) return key;
  }
  return null;
}

/**
 * Numbered rows between a header and the "Press enter to confirm" footer.
 * Row shape: optional selection marker, "N.", the value, then a two-space
 * gap before the description column.
 */
function parseNumberedRows(text, headerRe) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/press enter to confirm/i.test(line)) break;
    const m = line.match(/^\s*[›>]?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?\s*$/);
    if (!m) continue;
    const rawName = m[2].trim();
    rows.push({
      digit: m[1],
      name: rawName.replace(/\s*\(current\)\s*$/i, "").trim(),
      current: /\(current\)\s*$/i.test(rawName),
      raw: rawName,
    });
  }
  return rows.length ? rows : null;
}

export function parseModelList(text) {
  return parseNumberedRows(text, MODEL_LIST_HEADER);
}

/** Effort rows with normalized keys; header names the pending model. */
export function parseEffortList(text) {
  const rows = parseNumberedRows(text, EFFORT_LIST_HEADER);
  if (!rows) return null;
  const header = String(text || "").match(EFFORT_LIST_HEADER);
  return {
    model: header ? header[1] : null,
    rows: rows.map((r) => ({ ...r, effort: normalizeEffortLabel(r.name) })),
  };
}

/** The confirmation line codex prints after the effort digit lands. */
export function findConfirmation(text, model) {
  for (const line of String(text || "").split("\n").reverse()) {
    const m = line.match(CONFIRMATION_RE);
    if (m && m[1] === model) return { model: m[1], effort: m[2] || null };
  }
  return null;
}

const fail = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra });

/**
 * Switch a codex pane's model (and optionally effort) by driving the picker.
 *
 * @param {object} agent - createAgent surface (capturePane, typeLiteral,
 *                         sendEnter, sendEscape, isBusy)
 * @param {string} name  - agent/session name
 * @param {number} pane  - pane index
 * @param {string} model - exact model name as the picker lists it (e.g. "gpt-5.6-sol")
 * @param {string|null} effort - low|medium|high|xhigh|max, or null to accept
 *                               the picker's highlighted default
 * @returns {{ok: true, model, effort}} or
 *          {{ok: false, stage, error, available?}} — never throws for UI
 *          mismatches; the pane is escaped back to neutral before returning.
 */
export async function driveCodexModelPicker({
  agent, name, pane, model, effort = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  const capture = async (lines = 45) => {
    try { return await agent.capturePane(name, pane, lines); }
    catch (err) { return `__CAPTURE_FAILED__ ${err.message}`; }
  };
  const escapeOut = async () => {
    // Two escapes unwind effort-view → model-view → closed. On a neutral
    // pane a bare Escape is a no-op, so over-escaping is safe here.
    try { await agent.sendEscape(name, pane); await sleep(300); await agent.sendEscape(name, pane); } catch { /* pane gone */ }
  };

  // Stage 0: never drive a mid-turn pane. Digits would land in the live
  // composer as queued text instead of the picker.
  try {
    if (await agent.isBusy(name, pane)) {
      return fail("busy", "pane is mid-turn; interrupt (esc) or wait for idle before switching model");
    }
  } catch { /* busy probe failed: proceed, stage checks below still gate */ }

  // Stage 1: type /model (no Enter) and verify it sits alone in the composer.
  // Real leftover text concatenates ("/usage" + "/model" → "/usage/model",
  // observed live) — abort rather than submit merged garbage.
  await agent.typeLiteral(name, "/model", pane);
  await sleep(700);
  let snap = await capture(15);
  const composerLine = snap.split("\n").reverse().find((l) => /[›❯>]\s*\/\S*model/.test(l));
  if (!composerLine || !/[›❯>]\s*\/model\s*$/.test(composerLine.trim())) {
    await escapeOut();
    return fail("compose", `composer did not show a clean /model (saw: ${(composerLine || "nothing").trim().slice(0, 60)})`);
  }

  // Stage 2: Enter opens the model list.
  await agent.sendEnter(name, pane);
  await sleep(1100);
  snap = await capture();
  const models = parseModelList(snap);
  if (!models) {
    await escapeOut();
    return fail("model-list", "model picker did not open (codex UI changed? pane not codex?)");
  }

  // Stage 3: press the target model's digit (selects instantly).
  const target = models.find((r) => r.name === model);
  if (!target) {
    await escapeOut();
    return fail("model-missing", `"${model}" is not in the picker (quota-hidden or renamed)`,
      { available: models.map((r) => r.name) });
  }
  log(`picker: ${name}:${pane} model "${model}" = digit ${target.digit}`);
  await agent.typeLiteral(name, target.digit, pane);
  await sleep(900);
  snap = await capture();
  const effortView = parseEffortList(snap);
  if (!effortView) {
    await escapeOut();
    return fail("effort-list", "effort view did not open after model digit");
  }
  if (effortView.model && effortView.model !== model) {
    await escapeOut();
    return fail("effort-list", `effort view is for "${effortView.model}", expected "${model}"`);
  }

  // Stage 4: effort digit (instant), or Enter to accept the default.
  if (effort) {
    const effortRow = effortView.rows.find((r) => r.effort === effort);
    if (!effortRow) {
      await escapeOut();
      return fail("effort-missing", `effort "${effort}" not offered for ${model}`,
        { available: effortView.rows.map((r) => r.effort).filter(Boolean) });
    }
    log(`picker: ${name}:${pane} effort "${effort}" = digit ${effortRow.digit}`);
    await agent.typeLiteral(name, effortRow.digit, pane);
  } else {
    await agent.sendEnter(name, pane);
  }
  await sleep(1100);

  // Stage 5: the confirmation line is the proof — footer alone can lag.
  snap = await capture(25);
  const confirmed = findConfirmation(snap, model);
  if (!confirmed) {
    await escapeOut();
    return fail("confirm", `no "Model changed to ${model}" confirmation appeared`);
  }
  return { ok: true, model: confirmed.model, effort: confirmed.effort };
}
