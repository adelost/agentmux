// Public composer control is deliberately smaller than tmux's key language.
// Callers can express recovery intent, never inject tmux flags or arbitrary
// text through the key channel.

import { isCodexFullscreenPager } from "./codex-tui.mjs";
import { ALL_DIALECTS, composerLines } from "./dialects.mjs";

export const COMPOSER_KEY_ALLOWLIST = Object.freeze([
  "Escape",
  "C-a",
  "C-k",
  "C-u",
  "Enter",
]);

const ALLOWED = new Set(COMPOSER_KEY_ALLOWLIST);
export const CLEARLINE_RECIPE = Object.freeze(["Escape", "C-a", "C-k"]);

// Codex 0.163 reads an Escape and the key after it in one write as Alt+key: "Escape C-a C-k" in one tmux write left
// every draft in place, while the same keys with Escape written alone cleared it (real 0.163 probe, 2026-10-20). Two
// Escapes stay one write, as Claude's verified double Escape was sent.
/** WHAT: Builds the tmux writes for composer keys. WHY: Keeps an Escape from fusing with the next key into Alt+key. */
export function composerKeyWrites(keys) {
  const writes = [[]];
  for (const key of keys) {
    const write = writes.at(-1);
    if (write.at(-1) === "Escape" && key !== "Escape") writes.push([key]);
    else write.push(key);
  }
  return writes;
}

/** WHAT: Builds the visible editor's clear sequence. WHY: Prevents collapsed Claude pastes from surviving logical-line deletion. */
export function clearComposerRecipe(snapshot) {
  const line = composerLines(snapshot)[0] ?? "";
  const dialect = ALL_DIALECTS.find(candidate => line.startsWith(candidate.promptChar));
  return Object.freeze([...(dialect?.clearlineKeys ?? CLEARLINE_RECIPE)]);
}

export function normalizeComposerKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 32) {
    throw new Error("composer keys requires 1-32 allowlisted keys");
  }
  const normalized = keys.map((key) => String(key));
  const rejected = normalized.find((key) => !ALLOWED.has(key));
  if (rejected) {
    throw new Error(
      `composer key '${rejected}' is not allowed (use: ${COMPOSER_KEY_ALLOWLIST.join(", ")})`,
    );
  }
  return Object.freeze(normalized);
}

/** `q` is an internal pager-exit recipe and is never accepted by public keys. */
export function escapeComposerRecipe(snapshot) {
  return isCodexFullscreenPager(snapshot)
    ? Object.freeze({ keys: Object.freeze(["q"]), pager: true })
    : Object.freeze({ keys: Object.freeze(["Escape"]), pager: false });
}
