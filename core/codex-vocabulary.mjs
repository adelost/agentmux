// Codex-owned composer text, pinned to the Codex release it was read from.
//
// tmux capture strips colours, so Codex's grey placeholder is byte-identical
// to a human draft. Delivery must therefore know the exact strings Codex
// paints into an EMPTY composer — and that knowledge rots on every Codex
// upgrade: 0.152 replaced the whole rotating 0.144 list with one static
// placeholder, and every send to every Codex pane was refused for an hour
// as "composer is not empty" (2026-09-02).
//
// This file is the single copy. codex-vocabulary-probe.mjs verifies every
// string below against the Codex binary panes actually run, so an upgrade
// that changes them turns `amux doctor` red and names the cause at the point
// of delivery instead of misreporting a human draft.
//
// Source of truth: openai/codex tag rust-v<verifiedCodexVersion>
//   codex-rs/tui/src/chatwidget.rs         PLACEHOLDER, SIDE_PLACEHOLDER
//   codex-rs/tui/src/bottom_pane/footer.rs  esc_hint_line, left_side_line

/** WHAT: Defines the Codex composer text pinned to one release. WHY: Keeps placeholder knowledge in one copy the probe can verify. */
export const CODEX_VOCABULARY = Object.freeze({
  verifiedCodexVersion: "0.152.1",
  // Painted alone on the › row while the composer is empty, idle and busy.
  placeholders: Object.freeze([
    "Ask Codex to do anything",
    "Ask a follow-up question",
  ]),
  // Footer text Codex paints after a key glyph ("Tab", "esc"). The glyph is
  // keymap-rendered and never stored in the binary, so only the fragment
  // after it is verifiable.
  footerFragments: Object.freeze([
    " to queue message",
    " to queue",
    " to edit previous message",
    "No previous message to edit.",
  ]),
});

/** WHAT: Collects every literal the probe must find in the Codex binary. WHY: Keeps the matcher and the tripwire from reading different lists. */
export function codexVocabularyStrings(vocabulary = CODEX_VOCABULARY) {
  return [...vocabulary.placeholders, ...vocabulary.footerFragments];
}

// Null when the installed binary is the verified release and still contains
// every pinned string.
/** WHAT: Names why the pinned vocabulary may not match the running Codex. WHY: Keeps a new placeholder from being reported as a human draft. */
export function describeCodexVocabularyDrift(probe) {
  if (!probe) return null;
  if (probe.error) return `Codex composer vocabulary is unverified: ${probe.error}`;
  const verified = probe.verifiedVersion;
  if (probe.missing.length > 0) {
    const list = probe.missing.map((value) => JSON.stringify(value)).join(", ");
    return `Codex ${probe.installedVersion} no longer contains ${probe.missing.length}/${probe.checked}`
      + ` known composer strings (${list}); the vocabulary was verified for ${verified}`;
  }
  if (probe.installedVersion !== verified) {
    return `Codex ${probe.installedVersion} is installed but the composer vocabulary was verified`
      + ` for ${verified} (all ${probe.checked} strings still present)`;
  }
  return null;
}

// `agent.codexVocabularyDrift` is optional: drivers without it (tests, Kimi)
// get the plain sentence. A probe failure is reported, never swallowed.
/** WHAT: Describes a non-empty composer together with any vocabulary drift. WHY: Keeps an unseen Codex placeholder from being reported as a human draft. */
export async function describeNonEmptyComposer(agent, composer, { head = "composer is not empty" } = {}) {
  const text = `${head} (starts with: ${composer.slice(0, 60)})`;
  if (typeof agent?.codexVocabularyDrift !== "function") return text;
  let drift;
  try { drift = await agent.codexVocabularyDrift(); }
  catch (error) { drift = `Codex composer vocabulary probe failed: ${error.message}`; }
  if (!drift) return text;
  return `${text}; ${drift}; an unrecognised empty-composer placeholder is the likely cause, see amux doctor`;
}
