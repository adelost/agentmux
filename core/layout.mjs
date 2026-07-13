export const DEFAULT_TMUX_LAYOUT = "tiled";

/**
 * Resolve the one fleet-wide tmux layout contract.
 * Missing means the safe even grid. Explicit layouts remain supported, while
 * malformed values fail before tmux receives an ambiguous command.
 */
export function resolveTmuxLayout(layout) {
  if (layout === undefined || layout === null) return DEFAULT_TMUX_LAYOUT;
  if (typeof layout !== "string" || !layout.trim()) {
    throw new Error("tmux layout must be a non-empty string");
  }
  return layout.trim();
}
