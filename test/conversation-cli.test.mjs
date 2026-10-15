import { component, expect, feature } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../cli/commands.mjs";
import { appendAskLedger, appendPost, readAskLedger } from "../core/ask-ledger.mjs";

const ANSWER = `SUMMARY: Ett helt svar med åäö. ${"Bevis med källor. ".repeat(20)}Slutet är också bevarat.`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-conversation-cli-")), path = join(root, "ledger.jsonl"), configPath = join(root, "agents.yaml");
  const previous = process.env.AMUX_ASK_LEDGER_PATH;
  process.env.AMUX_ASK_LEDGER_PATH = path;
  writeFileSync(configPath, `test:\n  dir: ${root}\n  panes:\n    - cmd: codex\n`);
  const options = { path }, now = Date.now();
  appendAskLedger({ agent: "test", pane: 0, source: "discord", ts: now - 600000, verbatim: "Hittar du mitt riktiga uppdrag?" }, options);
  appendPost({ agent: "test", pane: 0, channelId: "channel", via: "bridge", kind: "reply", ts: now - 590000,
    messageId: "actual-discord-id", payload: ANSWER }, options);
  appendAskLedger({ agent: "test", pane: 0, source: "pane-hook", ts: now - 580000,
    verbatim: "<artifact-content-authored-by-others/> The summarized conversation below is context." }, options);
  const output = [], tmux = vi.fn(async () => { throw Error("No live engine, history must still be readable"); });
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(code => { throw Error(`process-exit:${code}`); });
  const ctx = { configPath, tmux, agent: {}, readAskLedger: () => readAskLedger({ path }), backfillAskLedger: async () => ({}) };
  return { root, previous, output, ctx, tmux };
}
const cleanup = fx => {
  vi.restoreAllMocks();
  if (fx.previous === undefined) delete process.env.AMUX_ASK_LEDGER_PATH; else process.env.AMUX_ASK_LEDGER_PATH = fx.previous;
  rmSync(fx.root, { recursive: true, force: true });
};

feature("the normal CLI reads what actually passed through AMUX", () => {
  for (const full of [false, true]) component(`canonical log reads a stopped pane without provider access, full=${full}`, {
    given: ["a canonical ask and the complete posted answer, with no running engine", fixture],
    when: ["reading the normal log command", async fx => { await dispatch(["log", "test", "-p", "0", "-n", "3", ...(full ? ["--full"] : [])], fx.ctx); return fx; }],
    then: ["the exact posted text and Discord source are shown without touching the engine", fx => {
      expect(fx.output.join("\n")).toContain(ANSWER);
      expect(fx.output.join("\n")).toContain("actual-discord-id");
      expect(fx.tmux).not.toHaveBeenCalled();
    }], cleanup,
  });
  component("asks uses the canonical answer and does not resurrect a compact summary", {
    given: ["the posted answer is longer than the old completion preview", fixture],
    when: ["listing the pane's full canonical answer", async fx => { await dispatch(["asks", "test", "--pane", "0", "--full"], fx.ctx); return fx.output.join("\n"); }],
    then: ["the actual answer is known and the engine summary is absent", text => {
      expect(text).toContain("Ett helt svar med åäö");
      expect(text).toContain("Slutet är också bevarat.");
      expect(text).not.toContain("unverified");
      expect(text).not.toContain("artifact-content-authored-by-others");
    }], cleanup,
  });
});
