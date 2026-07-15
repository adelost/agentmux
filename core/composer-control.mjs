// Public composer control is deliberately smaller than tmux's key language.
// Callers can express recovery intent, never inject tmux flags or arbitrary
// text through the key channel.

import { isCodexFullscreenPager } from "./codex-tui.mjs";

export const COMPOSER_KEY_ALLOWLIST = Object.freeze([
  "Escape",
  "C-a",
  "C-k",
  "C-u",
  "Enter",
]);

const ALLOWED = new Set(COMPOSER_KEY_ALLOWLIST);
export const CLEARLINE_RECIPE = Object.freeze(["Escape", "C-a", "C-k"]);

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
