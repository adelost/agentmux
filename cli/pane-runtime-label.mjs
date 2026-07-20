/**
 * WHAT: Formats a pane's engine and transport backend.
 * WHY: Keeps operators from inferring dispatch identity from model names.
 */
export function paneRuntimeLabel(engine, backend = "tmux", isShell = false) {
  return `${engine || (isShell ? "shell" : "svc")}/${backend || "tmux"}`;
}
