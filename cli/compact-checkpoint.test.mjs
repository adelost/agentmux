import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCompact } from "./compact.mjs";
import { createSelfCompactStore } from "../core/self-compact.mjs";
import { vi } from "vitest";

vi.mock("./tmux.mjs", () => ({ hasSession: async () => true,
  listPanes: async () => [{ index: 4, command: "codex" }], sendToPane: async () => ({ delivered: true }) }));
vi.mock("./inspect-pane.mjs", () => ({ dialectFor: () => "codex",
  inspectPane: async () => ({ status: "working", context: { tokens: 301_300, percent: 36 } }) }));

/** The calling pane lsrc:4 at `tokens`, with a clean saved checkpoint and an empty request store. */
function checkpoint(tokens) {
  const root = mkdtempSync(join(tmpdir(), "amux-self-cli-")), path = join(root, "rollout.jsonl");
  const configPath = join(root, "agents.yaml"), handoff = "Read checkpoint 87530dea. Fortsätt med bytes. No deploy/provider.";
  writeFileSync(path, ""); writeFileSync(configPath, `lsrc:\n  dir: ${root}\n  panes:\n${"    - cmd: codex\n".repeat(5)}`);
  const store = createSelfCompactStore({ dir: join(root, "requests") });
  const ctx = { configPath, agent: { sendOnly: () => { throw new Error("must not touch the active composer"); } } };
  const options = { detect: () => ({ session: "lsrc", pane: 4, key: "lsrc:4" }), store,
    readContext: async () => ({ tokens }), lastCompactAt: () => null,
    identityFor: () => ({ sessionId: "session", path }) };
  return { root, path, store, ctx, options, handoff };
}

feature("an agent compacts its own checkpoint, not its active composer", () => {
  // Row 214 (the owner's decision of 16 Nov 2026) moved this request from 301 300 to 401 300 tokens: a pane's own request is stored only above 400k.
  component("the actual lsrc:4 targeted force command is a safe deferred request with an exact handoff", {
    given: ["the calling pane lsrc:4 at 401 300 tokens and a clean saved checkpoint", () => checkpoint(401_300)],
    when: ["the agent calls its old targeted --force -m spelling", fx => cmdCompact(fx.ctx, { p: 4, force: true, m: fx.handoff }, ["lsrc"], fx.options)],
    then: ["a deferred self request saves exact handoff bytes without typing /compact prose mid-turn", (_, fx) => {
      expect(fx.store.read("lsrc", 4)).toMatchObject({ focus: fx.handoff, continuation: fx.handoff,
        identity: { sessionId: "session", path: fx.path, engine: "codex" } });
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});

// Row 214, the owner's decision of 16 Nov 2026: a pane at work is never compacted under 400k, whatever form it asks in.
// A missing handoff does not prove finished work; rest does, and the idle rules compact a resting pane by themselves.
feature("amux compact --self from a pane runs only above 400k, in every form", () => {
  for (const [label, tokens, flags, stored] of [
    ["deep:0's case of 16 Nov 2026: bare --self at 185k is not stored", 185_000, { self: true }, false],
    ["--no-resume at 300k is not stored", 300_000, { self: true, "no-resume": true }, false],
    ["-m at 399 999 is not stored", 399_999, { self: true, m: "continue row 214" }, false],
    ["a handoff file at exactly 400 000 is not stored", 400_000, { self: true, "continue-file": true }, false],
    ["a handoff file at 450k is stored and resumes", 450_000, { self: true, "continue-file": true }, true],
    ["--no-resume at 450k is stored as maintenance only", 450_000, { self: true, "no-resume": true, m: "keep the numbers" }, true],
  ]) component(label, {
    given: [`the calling pane lsrc:4 at ${tokens} tokens`, () => {
      const fx = checkpoint(tokens), file = join(fx.root, "handoff.txt");
      writeFileSync(file, fx.handoff);
      return { ...fx, flags: flags["continue-file"] ? { ...flags, "continue-file": file } : flags };
    }],
    when: ["the pane asks", async fx => {
      const before = process.exitCode;
      try { return { result: await cmdCompact(fx.ctx, fx.flags, [], fx.options), failed: process.exitCode !== before }; }
      finally { process.exitCode = before; }
    }],
    then: ["under 400k nothing is stored and the answer is plain words, not an error", ({ result, failed }, fx) => {
      const request = fx.store.read("lsrc", 4);
      expect(failed).toBe(false);
      if (stored) {
        expect(request).toMatchObject({ tokens });
        return expect(request.continuation).toBe(fx.flags["no-resume"] ? undefined : fx.handoff);
      }
      expect(fx.store.list()).toEqual([]);
      expect(result).toMatchObject({ ok: false, cell: "at-work" });
      expect(result.detail).toMatch(/not above 400000\. This is not an error: a pane at work is not compacted under that \(owner's decision 16 Nov 2026\)/u);
      expect(result.detail).toContain("AMUX compacts the pane by itself once it has rested (Claude after 50 min from 80k, Codex after 25 min from 150k)");
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
