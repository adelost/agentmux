// Shared, fail-closed primitives for driving Codex's terminal UI.
//
// tmux capture strips colours, so an empty grey Codex placeholder becomes
// indistinguishable from real text unless we match the exact placeholders we
// have observed.  Every driver (/model, /status, profile restart) uses this
// one gate so a UI change cannot make one path type over a human draft while
// another path still behaves safely.

// Narrow tmux captures occasionally merge the cursor cell into the gap
// (observed live as "editoprevious"). Keep the full Codex-owned sentence
// exact while tolerating at most two non-space paint artefacts at that seam.
const IDLE_EDIT_HINT = /esc again to edit\S{0,2}\s*previous message/i;
const NO_PREVIOUS_MESSAGE_HINT = /No previous message to edit\./i;
const EMPTY_COMPOSER_HINTS = new Set([
  "Explain this codebase",
  "Summarize recent commits",
  "Implement {feature}",
  "Find and fix a bug in @filename",
  "Write tests for @filename",
  "Improve documentation in @filename",
  "Run /review on my current changes",
  "Use /skills to list available skills",
  // Side-conversation placeholders from the same Codex 0.144.x source list.
  "Check recently modified functions for compatibility",
  "How many files have been modified?",
  "Will this algorithm scale well?",
]);

// Codex paints its cursor by temporarily replacing cells with box/block
// glyphs. A tmux capture can freeze those intermediate cells (observed live
// as "Impr─ve d─cumentation i──@filename"). Treat that as an empty rotating
// placeholder only when every non-artifact cell still matches one exact
// Codex-owned hint and the number of painted cells stays tightly bounded.
const TUI_PAINT_CELL = /^[\u2500-\u259f]$/u;
const MAX_PLACEHOLDER_PAINT_CELLS = 6;

function matchesPaintedPlaceholder(value, placeholder) {
  const actual = [...String(value || "")];
  const expected = [...String(placeholder || "")];
  if (actual.length !== expected.length) return false;

  let painted = 0;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] === expected[i]) continue;
    if (!TUI_PAINT_CELL.test(actual[i])) return false;
    painted++;
    if (painted > MAX_PLACEHOLDER_PAINT_CELLS) return false;
  }
  return painted > 0;
}

export function isCodexTranscriptView(text) {
  const value = String(text || "");
  return /\/\s*T\s*R\s*A\s*N\s*S\s*C\s*R\s*I\s*P\s*T\s*\//i.test(value)
    && /q to quit/i.test(value);
}

// Codex's backtrack / "edit a previous message" overlay is a SECOND full-screen
// pager that hides the › composer. Modern Codex maps Escape at an idle composer
// to this view, so the delivery layer's own "reveal the composer" Escape can
// push a pane into it. Its footer is the tell: "q to quit" plus edit-prev/next
// navigation. Like the transcript view it must be closed with q; a further
// Escape only navigates deeper, which is exactly how a pane wedged and every
// send reported "could not identify the Codex composer".
const CODEX_PAGER_QUIT = /q to quit/i;
const CODEX_PAGER_NAV = /to edit (?:prev|next|message)/i;
export function isCodexBacktrackPager(text) {
  const value = String(text || "");
  return CODEX_PAGER_QUIT.test(value) && CODEX_PAGER_NAV.test(value);
}

/** Either full-screen Codex pager (transcript or backtrack); both exit on q. */
export function isCodexFullscreenPager(text) {
  return isCodexTranscriptView(text) || isCodexBacktrackPager(text);
}

export function codexComposerText(text) {
  if (isCodexTranscriptView(text)) return null;
  const lines = String(text || "").split("\n");
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[›❯>]\s*/.test(lines[i])) { index = i; break; }
  }
  if (index === -1) return null;
  // Transcript user messages use the same › glyph as the live composer.
  // If a real assistant cell follows the candidate, it is history, not a
  // draft. The model/path footer also starts with •, so exclude that exact
  // footer shape.
  const assistantAfter = lines.slice(index + 1).some((candidate) => {
    if (!/^\s*•\s+/.test(candidate)) return false;
    return !/^\s*•\s+\S+\s+(?:minimal|low|medium|high|xhigh|max|ultra)\s+·\s+/.test(candidate);
  });
  if (assistantAfter) return null;
  const parts = [lines[index].replace(/^\s*[›❯>]\s*/, "").trim()];
  // captureScreen uses tmux -J, so terminal hard-wraps (including mid-word)
  // are already rejoined losslessly. These remaining indented rows are
  // logical composer paragraphs/continuations; keep them so exact pre-submit
  // verification does not degrade to the old short-prefix guess. Blank rows
  // can be intentional prompt paragraphs (the [from pane] envelope uses one);
  // status/bullet rows end input.
  for (let i = index + 1; i < lines.length; i++) {
    const candidate = lines[i];
    if (!candidate.trim()) continue;
    if (/^\s*(?:•\s+)?\S+\s+(?:minimal|low|medium|high|xhigh|max|ultra)\s+·\s+/.test(candidate)) break;
    if (/^\s*[•›❯>]/.test(candidate)) break;
    if (!/^\s{2,}\S/.test(candidate)) break;
    parts.push(candidate.trim());
  }
  const value = parts.join(" ").trim();
  // Codex shows "esc again to edit previous message" / "No previous message to
  // edit." ONLY while the composer is neutral (no unsent draft). A narrow tmux
  // capture can glue that hint onto the placeholder row, producing a joined
  // value that matches no single placeholder. Treating it as a real draft made
  // the readiness gate Escape to "reveal" a composer that was already there,
  // which opened the backtrack pager and wedged delivery. The hint's presence
  // alone proves the composer is empty.
  if (IDLE_EDIT_HINT.test(value) || NO_PREVIOUS_MESSAGE_HINT.test(value)) return "";
  if (EMPTY_COMPOSER_HINTS.has(value)
      || [...EMPTY_COMPOSER_HINTS].some((hint) => matchesPaintedPlaceholder(value, hint))) {
    return "";
  }
  return value;
}

/**
 * Prove that the live Codex composer contains this prompt, using enough of a
 * whitespace-normalized prefix to distinguish repeated recovery templates.
 * The old 20-character check treated every "[krasch-recovery] ..." draft as
 * identical and could submit an older pane's stale text.
 */
export function codexComposerContainsPrompt(snapshot, prompt) {
  const composer = codexComposerText(snapshot);
  if (typeof composer !== "string") return false;
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const needle = normalize(prompt);
  if (!needle) return false;
  const identity = needle.slice(0, Math.min(160, needle.length));
  return normalize(composer).includes(identity);
}

/**
 * A rescue Enter is safe only while Codex is idle and the live composer still
 * contains this exact prompt's head. Blind Enter retries during a running turn
 * can enqueue the same stale draft repeatedly; that produced four to six
 * duplicate crash-recovery turns from one delivery on 2026-07-12.
 */
export function shouldRescueCodexSubmit({ snapshot, prompt, busy }) {
  if (busy) return false;
  return codexComposerContainsPrompt(snapshot, prompt);
}

export function verifiedEmptyCodexComposer(text) {
  const value = codexComposerText(text);
  if (value !== null) return value;
  const raw = String(text || "");
  // Neutral receipts are ephemeral footer state, not timeless scrollback.
  // claw:10 kept an old "No previous message" near the top of its screen
  // while the live composer had disappeared; matching the whole capture made
  // delivery wait forever instead of using one safe idle Escape to reveal it.
  const tail = raw.split("\n").slice(-6).join("\n");
  return IDLE_EDIT_HINT.test(tail) || NO_PREVIOUS_MESSAGE_HINT.test(tail) ? "" : null;
}

const fail = (stage, error) => ({ ok: false, stage, error });

/**
 * Prove that a Codex pane is idle and has no draft before a TUI interaction
 * or process restart.  A completed turn can omit the composer; one Escape is
 * allowed solely to reveal Codex's exact neutral-state receipt.
 */
export async function prepareCodexIdle({
  agent,
  name,
  pane,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  captureLines = 15,
  allowBusy = false,
  requireVisibleComposer = false,
} = {}) {
  let busy = false;
  try {
    busy = await agent.isBusy(name, pane);
    if (busy && !allowBusy) {
      return fail("busy", "pane is mid-turn; wait for it to finish or interrupt it first");
    }
  } catch (err) {
    return fail("busy-check", `could not verify that pane is idle: ${err.message}`);
  }

  const capture = async () => {
    try {
      return agent.captureScreen
        ? await agent.captureScreen(name, pane)
        : await agent.capturePane(name, pane, captureLines);
    }
    catch (err) { return `__CAPTURE_FAILED__ ${err.message}`; }
  };

  let snapshot = await capture();
  if (isCodexFullscreenPager(snapshot)) {
    try { await agent.typeLiteral(name, "q", pane); }
    catch (err) { return fail("transcript", `could not close Codex full-screen pager: ${err.message}`); }
    await sleep(300);
    snapshot = await capture();
  }
  let composer = verifiedEmptyCodexComposer(snapshot);
  if (composer === null) {
    // /status is an official during-task command, but Escape is still an
    // interrupt while a turn runs.  Only reveal a missing composer when the
    // pane is idle; busy callers fail closed instead.
    if (busy) return fail("compose", "Codex is working and its composer is not visible");
    try { await agent.sendEscape(name, pane); }
    catch (err) { return fail("compose", `could not reveal the Codex composer: ${err.message}`); }
    await sleep(400);
    snapshot = await capture();
    // Modern Codex maps Escape at an idle composer to the backtrack pager, so
    // the reveal Escape can itself open one. Close it with q before concluding
    // the composer is missing, or this call wedges into "could not identify".
    if (isCodexFullscreenPager(snapshot)) {
      try { await agent.typeLiteral(name, "q", pane); }
      catch (err) { return fail("transcript", `could not close Codex full-screen pager: ${err.message}`); }
      await sleep(300);
      snapshot = await capture();
    }
    composer = verifiedEmptyCodexComposer(snapshot);
  }

  if (composer === null) {
    return fail("compose", "could not identify the Codex composer before acting");
  }

  // A neutral Escape receipt proves that Codex is idle, but not that its
  // input widget has finished painting. During resume the receipt can appear
  // a few seconds before the composer; typing then writes into a toast/status
  // row instead of the input. Commands that will type must wait for the real
  // › composer, not merely the receipt.
  if (requireVisibleComposer && codexComposerText(snapshot) === null) {
    for (let attempt = 0; attempt < 16; attempt++) {
      await sleep(250);
      snapshot = await capture();
      if (isCodexFullscreenPager(snapshot)) {
        try { await agent.typeLiteral(name, "q", pane); }
        catch (err) { return fail("transcript", `could not close Codex full-screen pager: ${err.message}`); }
        continue;
      }
      const visible = codexComposerText(snapshot);
      if (visible === null) continue;
      composer = visible;
      break;
    }
    if (codexComposerText(snapshot) === null) {
      return fail("compose", "Codex is idle but its visible composer is not ready");
    }
  }
  if (composer) {
    return fail("compose", `composer is not empty (starts with: ${composer.slice(0, 60)})`);
  }
  return { ok: true, snapshot, busy };
}
