import { feature, unit, expect } from "bdd-vitest";
import { detectPaneStatus } from "../cli/format.mjs";
import { kimiModalForScreen } from "./kimi-agent-runtime.mjs";

// Faithful renders of kimi-code 0.34.0's two fleet-blocking dialogs. Both
// render the selected option with a "❯" pointer, which trims to Claude's
// promptChar — the exact shape that read as 💤 idle on 2026-08-07.
const KIMI_TRUST_MODAL = [
  " Kimi Code loads project-level MCP servers (.mcp.json, .kimi-code/mcp.json) only in trusted",
  " folders. They run as local processes on your machine. This folder defines: playwright.",
  "",
  " Trust this folder?",
  "",
  "  ❯ Trust this folder",
  "    Enable project MCP servers. Remembered for this folder.",
  "  Don't trust",
  "    Exit Kimi Code. Asked again next launch.",
  "",
  " ──────────────────────────────────────────────",
  " auto  K3 thinking: max  ~/proj/.agents/8  master",
].join("\n");

const KIMI_CACHE_HINT_MODAL = [
  " This session has been idle for 17h and is ~47.2k tokens.",
  " ↑↓ navigate · Enter select · Esc cancel",
  "",
  " Cache expired — the next message re-sends the entire history at full price.",
  "",
  "  ❯ Compact and continue   one-time compact cost · cheapest way to keep this topic",
  "    Start a new session    fresh thread, no carry-over",
  "    Continue as-is         keep everything, next send is full price",
  "",
  " auto  K3 thinking: max  ~/proj/.agents/8  master",
].join("\n");

// A Kimi pane that TALKS about the dialogs: its boxed composer row vetoes the
// modal match. Must never read as a modal.
const KIMI_BUSY_QUOTING = [
  "● I'll fix the Trust this folder? modal now",
  "The dialog offers Don't trust as the escape hatch.",
  "Cache expired — the next message re-sends the entire history at full price.",
  "  ❯ Compact and continue",
  "╭──────────────────────────────────────────────╮",
  "│ >                                            │",
  "╰──────────────────────────────────────────────╯",
  " auto  K3 thinking: max  ~/proj/.agents/8  master          context: 24%",
].join("\n");

const CLAUDE_PERMISSION_MODAL = [
  " ⏵⏵ accept edits on",
  " Do you want to proceed?",
  "   1. Yes",
  "   2. Yes, allow always",
  " Enter to select · Esc to cancel",
].join("\n");

feature("kimi modal recognition in detectPaneStatus", () => {
  unit("trust modal is a held pane, not an idle one", {
    given: ["trust modal screen", () => KIMI_TRUST_MODAL],
    when: ["classifying", detectPaneStatus],
    then: ["menu", (status) => expect(status).toBe("menu")],
  });

  unit("cache-expiry hint is a held pane, not an idle one", {
    given: ["cache hint screen", () => KIMI_CACHE_HINT_MODAL],
    when: ["classifying", detectPaneStatus],
    then: ["menu", (status) => expect(status).toBe("menu")],
  });

  unit("a kimi pane quoting the dialogs with a visible composer is not a modal", {
    given: ["quoting screen", () => KIMI_BUSY_QUOTING],
    when: ["classifying", detectPaneStatus],
    then: ["not menu", (status) => expect(status).not.toBe("menu")],
  });

  unit("claude modal recognition survives the registry move", {
    given: ["claude permission screen", () => CLAUDE_PERMISSION_MODAL],
    when: ["classifying", detectPaneStatus],
    then: ["permission", (status) => expect(status).toBe("permission")],
  });
});

feature("kimiModalForScreen", () => {
  unit("names the trust modal", {
    given: ["trust modal", () => KIMI_TRUST_MODAL],
    when: ["detecting", kimiModalForScreen],
    then: ["workspace-trust", (id) => expect(id).toBe("workspace-trust")],
  });

  unit("names the cache hint", {
    given: ["cache hint", () => KIMI_CACHE_HINT_MODAL],
    when: ["detecting", kimiModalForScreen],
    then: ["cache-expiry-hint", (id) => expect(id).toBe("cache-expiry-hint")],
  });

  unit("a visible composer vetoes detection", {
    given: ["quoting screen", () => KIMI_BUSY_QUOTING],
    when: ["detecting", kimiModalForScreen],
    then: ["null", (id) => expect(id).toBe(null)],
  });

  unit("empty and undefined screens are safe", {
    given: ["empty", () => ""],
    when: ["detecting", kimiModalForScreen],
    then: ["null", (id) => expect(id).toBe(null)],
  });
});
