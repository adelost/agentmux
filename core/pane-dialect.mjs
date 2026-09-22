import { detectDialect } from "./dialects.mjs";

/** WHAT: Resolves a configured coding engine. WHY: Keeps lifecycle routing from duplicating command recognition. */
export function commandDialect(command) {
  const value = String(command || "");
  if (/(?:^|[\/\s])qwen(?:\s|$)/iu.test(value)) return "qwen";
  if (/kimi(?:-code)?/iu.test(value)) return "kimi";
  if (/codex/iu.test(value)) return "codex";
  if (/claude/iu.test(value)) return "claude";
  return null;
}

/** WHAT: Builds config-first dialect resolvers with a bounded live fallback. WHY: Generic node processes must not hide their owning engine. */
export function createPaneDialectResolver({ configFor, currentCommand, capture, log = console.warn } = {}) {
  function configured(agentName, pane) {
    try { return commandDialect(configFor(agentName).panes?.[pane]?.cmd); }
    catch (error) {
      log(`paneDialectName(${agentName}) failed: ${error.message}`);
      return null;
    }
  }
  async function live(agentName, pane) {
    const known = configured(agentName, pane);
    if (known) return known;
    try {
      if (await currentCommand(`${agentName}:.${pane}`) !== "node") return null;
      return detectDialect(await capture(agentName, pane, 120))?.name || null;
    } catch (error) {
      log(`livePaneDialectName(${agentName}:${pane}) failed: ${error.message}`);
      return null;
    }
  }
  return { paneDialectName: configured, livePaneDialectName: live };
}
