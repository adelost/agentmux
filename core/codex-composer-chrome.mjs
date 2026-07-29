const SLASH_INPUT = /^\/[a-z][\w-]*(?:\s.*)?$/i;
const COMMAND_PALETTE_ROW = /^\s{2,}\/[a-z][\w-]*\s{2,}\S/i;

/**
 * WHAT: Returns whether a row is Codex's selected slash-menu description.
 * WHY: Keeps terminal chrome from becoming duplicated command text.
 */
export function isCodexCommandPaletteRow(input, row) {
  return SLASH_INPUT.test(String(input || ""))
    && COMMAND_PALETTE_ROW.test(String(row || ""));
}
