// Shared, fail-closed primitives for driving Codex's terminal UI.
//
// tmux capture strips colours, so an empty grey Codex placeholder becomes
// indistinguishable from real text unless we match the exact placeholders we
// have observed.  Every driver (/model, /status, profile restart) uses this
// one gate so a UI change cannot make one path type over a human draft while
// another path still behaves safely.

import { promptRequiresAtomicPaste } from "./prompt-paste.mjs";

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
const CODEX_QUEUE_HINT = /tab to queue message/i;
export function isCodexBacktrackPager(text) {
  const value = String(text || "");
  return CODEX_PAGER_QUIT.test(value) && CODEX_PAGER_NAV.test(value);
}

/** Either full-screen Codex pager (transcript or backtrack); both exit on q. */
export function isCodexFullscreenPager(text) {
  return isCodexTranscriptView(text) || isCodexBacktrackPager(text);
}

/** Codex explicitly advertises a safe queue composer while a turn is busy. */
export function codexOffersQueueComposer(text) {
  return CODEX_QUEUE_HINT.test(String(text || ""));
}

// A large paste collapses in the Codex composer to a placeholder like
// "[Pasted Content 1024 chars]" — the literal text is never rendered, so the
// exact-text draft check can never confirm it and delivery withholds Enter
// forever (the message sticks unsubmitted; observed live 2026-07-12). The
// reported char count does NOT equal the prompt length (Codex caps it), so it
// cannot be validated by size. Delivery clears any foreign draft before it
// pastes, so a block present right after our paste IS our prompt.
const CODEX_PASTE_BLOCK = /\[Pasted Content\s+\d+\s*chars?\]/i;
export function codexComposerHasPasteBlock(text) {
  const composer = codexComposerText(text);
  return typeof composer === "string" && CODEX_PASTE_BLOCK.test(composer);
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
    // Queue-mode chrome is painted directly beneath a busy draft. It is not
    // composer content; retaining it made the durable broker classify its own
    // exact recovered draft as a different human edit.
    if (CODEX_QUEUE_HINT.test(candidate) || /\b\d+%\s+context left\b/i.test(candidate)) break;
    if (/^\s*(?:•\s+)?\S+\s+(?:minimal|low|medium|high|xhigh|max|ultra)\s+·\s+/.test(candidate)) break;
    if (/^\s*[•›❯>]/.test(candidate)) break;
    if (!/^\s{2,}\S/.test(candidate)) break;
    parts.push(candidate.trim());
  }
  // tmux `-J` can join Ratatui's prompt row and the queue footer into one
  // logical line even though a normal pane capture shows them separately.
  // Strip only the exact terminal-owned suffix (anchored at the end), so a
  // human sentence that happens to mention Tab is still preserved.
  const value = parts.join(" ").trim().replace(
    /\s+tab to queue message(?:\s+\d+%\s+context left)?\s*$/i,
    "",
  );
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

const normalizeComposerIdentity = (value) => String(value || "").replace(/\s+/g, "");
const SCROLLED_PROMPT_TAIL_CHARS = 160;
const OWNED_DRAFT_VISIBLE_CHARS = 160;

/**
 * Prove that the complete prompt is visible in the live Codex composer.
 *
 * This deliberately compares the whole normalized prompt, not merely a
 * prefix. A failed clear of a multiline draft can leave only its first rows
 * behind; treating that residue as the complete prompt makes the next retry
 * press Enter on truncated text.
 */
export function codexComposerContainsPrompt(snapshot, prompt) {
  const composer = codexComposerText(snapshot);
  if (typeof composer !== "string") return false;
  // Ratatui wraps long unbroken tokens (notably /tmp/discord-media-*.png)
  // into separate indented logical rows. tmux -J cannot rejoin those rows,
  // because they are application-rendered rather than terminal hard-wraps;
  // codexComposerText therefore has a synthetic space in the middle of the
  // token. Compare the exact non-whitespace stream so visual layout cannot
  // turn a fully painted draft into a false negative.
  const needle = normalizeComposerIdentity(prompt);
  if (!needle) return false;
  return normalizeComposerIdentity(composer) === needle;
}

/**
 * Prove that the visible composer ends with a long prompt's exact tail.
 *
 * Codex scrolls a tall draft inside its composer: once the cursor reaches the
 * end, the prompt head is no longer present in capture-pane even though the
 * atomic tmux paste arrived in full. Delivery may use this boundary receipt
 * only for prompts that were sent through the atomic-paste path. Requiring a
 * long, exact 160-character suffix avoids accepting a short or merely
 * prefix-shaped residue as complete.
 */
export function codexComposerEndsWithPrompt(snapshot, prompt) {
  const composer = codexComposerText(snapshot);
  if (typeof composer !== "string") return false;
  const needle = normalizeComposerIdentity(prompt);
  if (needle.length <= SCROLLED_PROMPT_TAIL_CHARS) return false;
  const tail = needle.slice(-SCROLLED_PROMPT_TAIL_CHARS);
  return normalizeComposerIdentity(composer).endsWith(tail);
}

/**
 * Recover a durable, already-pasted atomic draft from a clipped viewport.
 *
 * This is intentionally weaker than initial paste verification and MUST only
 * be used after the durable queue has recorded draft ownership. Codex can
 * scroll both the head and tail of a tall composer out of view; a long exact
 * interior window is then the only visible identity. A 160-character minimum
 * rejects short prefix residue, while requiring the whole visible window to
 * occur inside the immutable source rejects concatenated/edited drafts.
 */
export function codexComposerMatchesOwnedDraft(snapshot, prompt) {
  if (codexComposerContainsPrompt(snapshot, prompt) || codexComposerHasPasteBlock(snapshot)) return true;

  const composer = codexComposerText(snapshot);
  if (typeof composer !== "string") return false;
  const visible = normalizeComposerIdentity(composer);
  const source = normalizeComposerIdentity(prompt);
  // A complete source followed by another copy shares the same exact tail.
  // Reject any non-exact viewport at least as long as the source before the
  // tail shortcut, otherwise an already-amplified composer receives Enter.
  if (visible.length >= source.length) return false;
  if (codexComposerEndsWithPrompt(snapshot, prompt)) return true;
  if (visible.length < OWNED_DRAFT_VISIBLE_CHARS) return false;
  return source.includes(visible);
}

/**
 * A rescue Enter is safe only while the live composer still owns this exact
 * draft. An idle composer may submit normally. A busy pane may submit only
 * through Codex's explicit queue editor (`tab to queue message`): JSONL is
 * intentionally late there, so rejecting every busy rescue leaves a missed
 * first Enter sitting in the queue editor and the next delivery appends to it.
 *
 * The exact draft gate is what prevents duplicates. Once Enter is accepted the
 * queue editor disappears, so a later rescue sees no matching composer and is
 * a no-op even though the active turn remains busy.
 */
export function shouldRescueCodexSubmit({ snapshot, prompt, busy }) {
  const exactDraft = codexComposerContainsPrompt(snapshot, prompt)
    || codexComposerEndsWithPrompt(snapshot, prompt)
    || (promptRequiresAtomicPaste(prompt) && codexComposerHasPasteBlock(snapshot));
  if (!exactDraft) return false;
  return !busy || codexOffersQueueComposer(snapshot);
}

/**
 * Clear an agentmux-owned multiline Codex draft without assuming one
 * kill-line sequence reaches every paragraph.
 *
 * Codex has no whole-buffer editing shortcut that is safe during a running
 * turn. The tmux adapter therefore walks backwards across logical lines; a
 * tall prompt can need several passes. Re-capturing between passes both
 * proves progress and prevents a fixed line-count from leaving a truncated
 * prompt behind for the next delivery to submit.
 */
export async function clearCodexComposerDraft({
  capture,
  clear,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPasses = 64,
} = {}) {
  let passes = 0;
  while (passes < maxPasses) {
    let snapshot;
    try { snapshot = await capture(); }
    catch (error) { return { ok: false, passes, error: error.message }; }
    const composer = codexComposerText(snapshot);
    if (composer === "") return { ok: true, passes };
    if (composer === null) {
      return { ok: false, passes, error: "could not identify composer while clearing" };
    }
    try { await clear(); }
    catch (error) { return { ok: false, passes, error: error.message }; }
    passes++;
    await sleep(50);
  }

  try {
    const composer = codexComposerText(await capture());
    if (composer === "") return { ok: true, passes };
    return {
      ok: false,
      passes,
      error: composer === null
        ? "could not identify composer after bounded clear"
        : "composer remained non-empty after bounded clear",
    };
  } catch (error) {
    return { ok: false, passes, error: error.message };
  }
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
  openBusyQueue = false,
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
    if (busy) {
      // During tools/reasoning Codex intentionally hides the normal composer
      // and advertises "tab to queue message". Tab opens a dedicated queue
      // editor without interrupting the active turn; Escape would interrupt.
      // Prompt delivery explicitly opts into openBusyQueue. While Codex is
      // busy, Tab is its non-interrupting queue key even during short repaints
      // where the "tab to queue message" hint itself is absent. The old
      // hint-only gate waited up to 8–12 seconds for that text to return.
      // Other callers (for example /status) retain the advertised-hint rule.
      const mayOpenPromptQueue = openBusyQueue || codexOffersQueueComposer(snapshot);
      if (mayOpenPromptQueue && agent.sendTab) {
        try { await agent.sendTab(name, pane); }
        catch (err) { return fail("compose", `could not open the Codex queue composer: ${err.message}`); }
        for (let attempt = 0; attempt < 16; attempt++) {
          await sleep(125);
          snapshot = await capture();
          composer = verifiedEmptyCodexComposer(snapshot);
          if (composer !== null) break;
        }
        if (composer === null) {
          return fail("compose", "Codex is working and its queue composer did not open");
        }
      } else {
        return fail("compose", "Codex is working and its composer is not visible");
      }
    }
    if (!busy) {
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
