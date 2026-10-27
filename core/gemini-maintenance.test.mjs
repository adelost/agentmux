import { vi, afterEach } from "vitest";
import { component, feature, unit, expect } from "bdd-vitest";
import { cmdCompact } from "../cli/compact.mjs";
import { detectPaneStatus } from "../cli/format.mjs";

const sent = vi.hoisted(() => []);
vi.mock("../cli/config.mjs", () => ({ listAgents: () => [{ name: "gemini-fixture", dir: "/tmp/amux-gemini-maintenance-fixture",
  panes: [{ engine: "gemini", cmd: "gemini --approval-mode yolo" }] }] }));
vi.mock("../cli/tmux.mjs", () => ({ hasSession: async () => true,
  listPanes: async () => [{ index: 0, command: "node" }],
  sendToPane: async (_ctx, name, pane, text) => { sent.push({ name, pane, text }); return { delivered: true }; },
}));
vi.mock("../cli/inspect-pane.mjs", async importOriginal => ({
  ...await importOriginal(), inspectPane: async () => ({ status: "idle", context: { tokens: 200_000, percent: 80 } }),
}));
afterEach(() => { sent.length = 0; vi.restoreAllMocks(); });
const context = () => ({ configPath: "/fixture/config", state: { get: (_key, fallback) => fallback } });

feature("Gemini phase-one maintenance exclusion", () => {
  component("bulk compact never sends a slash to a Gemini pane, even with a large context", {
    when: ["running bulk compact over a Gemini-only inventory", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      await cmdCompact(context(), {}, [], { detect: () => null });
      return sent.length;
    }], then: ["no maintenance input reaches Gemini", count => expect(count).toBe(0)],
  });

  component("targeted compact refuses Gemini before any TUI input", {
    when: ["an explicit compact targets the Gemini fixture", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      try { await cmdCompact(context(), { p: 0 }, ["gemini-fixture"], { detect: () => null }); return null; }
      catch (error) { return error; }
    }], then: ["the operator gets an explicit unsupported result, not a Claude slash", error => {
      expect(error?.message).toMatch(/Gemini.*compact.*unsupported/u); expect(sent).toHaveLength(0);
    }],
  });

  unit("the captured Gemini busy footer beats its still-visible empty composer", {
    when: ["classifying the actual fake-tool footer shape", () => detectPaneStatus([
      "Gemini CLI v0.65.0", " ⠇ Executing Hooks: amux-BeforeAgent (esc to cancel, 1s) ? for shortcuts",
      "────────────────────", "YOLO Ctrl+Y", "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄", " *   Type your message or @path/to/file",
      "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", "workspace (/directory) /model Auto",
    ].join("\n"))], then: ["the pane is working, never maintenance-ready idle", status => expect(status).toBe("working")],
  });
});
