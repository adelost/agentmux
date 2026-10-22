import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { conversationAskEntries } from "../core/conversation-view.mjs";
import { filterAskEntries, joinAskLedgerEntries } from "../core/ask-history.mjs";
import { appendAskLedger, appendPost, persistAskCompletionEvidence, readAskLedger } from "../core/ask-ledger.mjs";
import { readAskBindings } from "../core/ask-bindings.mjs";
import { dispatch } from "../cli/commands.mjs";

const at = "2026-10-22T04:00:00Z";
const ask = (id, source = "discord") => ({ id, event: "ask", agent: "test", pane: 0, ts: at, source, verbatim: "synthetic task" });
const binding = { ledgerId: "human", kind: "row", ref: "/repo/docs/TASKS.md:71", by: "test:0", ts: at };

feature("human task closure requires an explicit binding, not an answer", () => {
  component("canonical posted answers remain unbound under --open", {
    when: ["joining separate answered human, agent and system conversations", () => ["discord", "cli", "dream"].flatMap(source => {
      const row = ask(source, source);
      if (source === "cli") row.sender = "other:0";
      return conversationAskEntries({ asks: [row], posts: [{ agent: "test", pane: 0, ts: at, kind: "reply", status: "sent", text: "A synthetic answer" }] });
    })],
    then: ["only the human answer is unresolved, with the answer preserved", rows => {
      expect(rows.map(row => row.status)).toEqual(["unbound", "answered", "answered"]);
      expect(filterAskEntries(rows, { openOnly: true }).map(row => row.ledgerId)).toEqual(["discord"]);
      expect(rows[0].reply).toBe("A synthetic answer");
    }],
  });
  component("durable done or answered evidence stays unbound, binding closes without changing the answer", {
    when: ["joining persisted evidence with and without a binding", () => ["done", "answered"].map(completionStatus => {
      const input = { ledgerEntries: [{ ...ask("human"), completionStatus, completionReply: "synthetic receipt" }] };
      return [joinAskLedgerEntries(input)[0], joinAskLedgerEntries({ ...input, bindings: [binding] })[0]];
    })],
    then: ["the binding alone closes the human ask", pairs => {
      for (const [unbound, bound] of pairs) {
        expect(unbound).toMatchObject({ status: "unbound", open: true });
        expect(bound).toMatchObject({ status: "bound", open: false, binding, reply: "synthetic receipt" });
      }
    }],
  });
  component("bindings close canonical asks but ordinary unresolved states remain unchanged without one", {
    when: ["joining every ordinary status and a canonical bound ask", () => ({
      rows: ["open", "working", "partial", "needs-you", "delegate", "unverified"].map(status => joinAskLedgerEntries({
        ledgerEntries: [ask(status)], liveEntries: [{ agent: "test", pane: 0, prompt: "synthetic task", tsMs: Date.parse(at), status, open: true }],
      })[0]),
      bound: conversationAskEntries({ asks: [ask("human")], posts: [] }, { bindings: [binding] })[0],
    })],
    then: ["no answer classifier changes and the bound ask is closed", ({ rows, bound }) => {
      expect(rows.map(row => row.status)).toEqual(["open", "working", "partial", "needs-you", "delegate", "unverified"]);
      expect(rows.every(row => row.open)).toBe(true);
      expect(bound).toMatchObject({ status: "bound", open: false });
    }],
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-binding-"));
  const previous = Object.fromEntries(["AMUX_ASK_LEDGER_PATH", "AMUX_ASK_BINDINGS_PATH", "AMUX_AGENT_NAME", "AMUX_PANE"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { AMUX_ASK_LEDGER_PATH: join(root, "asks.jsonl"), AMUX_ASK_BINDINGS_PATH: join(root, "bindings.jsonl"), AMUX_AGENT_NAME: "test", AMUX_PANE: "0" });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/TASKS.md"), "| # | Outcome |\n| --- | --- |\n| 71 | Synthetic task |\n");
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q"]); git(["add", "docs/TASKS.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "synthetic fixture"]);
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, `test:\n  dir: ${root}\n  panes:\n    - cmd: codex\n`);
  for (const id of ["one", "two"]) {
    appendAskLedger({ ...ask(id), ts: Date.now() - 60000 });
    appendPost({ agent: "test", pane: 0, channelId: "test", via: "cli", kind: "reply", payload: "synthetic answer" });
  }
  const output = [];
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  return { root, previous, output, git, path: process.env.AMUX_ASK_BINDINGS_PATH, ctx: { configPath, cwd: root } };
}
function cleanup(fx) {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(fx.previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(fx.root, { recursive: true, force: true });
}

feature("asks bind validates an entire bulk command before append", () => {
  component("an unbound answer persists once and a later binding never rewrites earlier evidence", {
    given: ["two exact ids and an observed provider answer", fixture],
    when: ["persisting the derived unbound state, binding, then trying an invalid batch", async fx => {
      const ledgerEntries = readAskLedger();
      const joinedEntries = joinAskLedgerEntries({ ledgerEntries, liveEntries: [{ agent: "test", pane: 0, prompt: "synthetic task",
        tsMs: Date.parse(ledgerEntries[0].ts), status: "done", open: false, reply: "synthetic receipt", jsonlFile: "/synthetic/session.jsonl" }] });
      persistAskCompletionEvidence({ ledgerEntries, joinedEntries });
      expect(readAskLedger()[0].completionStatus).toBe("done");
      await dispatch(["asks", "bind", "one", "--row", "71"], fx.ctx);
      const prior = readFileSync(fx.path, "utf8");
      await expect(dispatch(["asks", "bind", "two", "absent", "--row", "71"], fx.ctx)).rejects.toThrow("Unknown ask id");
      expect(readFileSync(fx.path, "utf8")).toBe(prior);
      await dispatch(["asks", "bind", "two", "--close", "synthetic non-task"], fx.ctx);
      expect(readFileSync(fx.path, "utf8").startsWith(prior)).toBe(true);
      return fx;
    }],
    then: ["both bindings are readable without altering the stored answer", fx => {
      expect(readAskBindings().map(row => row.ledgerId)).toEqual(["one", "two"]);
      expect(readAskLedger()[0]).toMatchObject({ completionStatus: "done", completionReply: "synthetic receipt" });
    }], cleanup,
  });
  component("unidentified caller and unreadable binding evidence fail closed", {
    given: ["the temporary configured caller", fixture],
    when: ["losing identity and then encountering a torn binding", async fx => {
      delete process.env.AMUX_AGENT_NAME;
      const tmux = process.env.TMUX;
      delete process.env.TMUX;
      try { await expect(dispatch(["asks", "bind", "one", "--row", "71"], fx.ctx)).rejects.toThrow("configured agent:pane"); }
      finally { if (tmux !== undefined) process.env.TMUX = tmux; }
      expect(existsSync(fx.path)).toBe(false);
      process.env.AMUX_AGENT_NAME = "test";
      writeFileSync(fx.path, '{"ledgerId":');
      await expect(dispatch(["asks", "bind", "one", "--row", "71"], fx.ctx)).rejects.toThrow();
      return fx;
    }],
    then: ["the damaged evidence was not extended or replaced", fx => expect(readFileSync(fx.path, "utf8")).toBe('{"ledgerId":')], cleanup,
  });
  for (const kind of ["row", "commit", "close"]) component(`CLI bulk ${kind} binding closes both exact ids`, {
    given: ["a real temporary repo, configured caller and synthetic ledger", fixture],
    when: ["binding both ids then listing unresolved asks", async fx => {
      const ref = kind === "row" ? "71" : kind === "commit" ? "HEAD" : "synthetic non-task";
      await dispatch(["asks", "bind", "one", "two", `--${kind}`, ref], fx.ctx);
      await dispatch(["asks", "--open", "--list"], fx.ctx);
      return fx;
    }],
    then: ["one append-only file records the exact provenance and --open is empty", fx => {
      const rows = readFileSync(fx.path, "utf8").trim().split("\n").map(JSON.parse);
      expect(rows.map(row => row.ledgerId)).toEqual(["one", "two"]);
      expect(rows.every(row => row.kind === kind && row.by === "test:0" && Number.isFinite(Date.parse(row.ts)))).toBe(true);
      if (kind === "commit") expect(rows[0].ref).toBe(`${fx.root}@${fx.git(["rev-parse", "HEAD"])}`);
      if (kind === "row") expect(rows[0].ref).toBe(`${fx.root}/docs/TASKS.md:71`);
      if (kind === "close") expect(rows[0].ref).toBe("synthetic non-task");
      expect(fx.output.at(-1)).toBe("(no asks match)");
    }], cleanup,
  });
  for (const args of [["one", "absent", "--row", "71"], ["one", "--row", "72"], ["one", "--commit", "missing"], ["one"], ["one", "--close", ""], ["one", "--row", "71", "--close", "why"]]) {
    component(`invalid binding writes nothing: ${args.join(" ")}`, {
      given: ["the temporary repo and synthetic ledger", fixture],
      when: ["attempting the invalid command", async fx => { await expect(dispatch(["asks", "bind", ...args], fx.ctx)).rejects.toThrow(); return fx; }],
      then: ["the binding file was never created", fx => expect(existsSync(fx.path)).toBe(false)], cleanup,
    });
  }
});
