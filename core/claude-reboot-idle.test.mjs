import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../agent.mjs";
import { createContextMaintenance } from "./context-maintenance.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const idle = "Claude Code\n────────────────────\n❯ \n────────────────────\n  bypass permissions on";

function fixture({ screen = idle, afterBoot = false, onCapture = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-reboot-idle-")); roots.push(root);
  vi.stubEnv("HOME", root);
  const dir = join(root, "project"), pane = join(dir, ".agents/1"), proc = join(root, "proc");
  const journalDir = join(root, ".claude/projects", pane.replace(/[/.]/g, "-"));
  mkdirSync(journalDir, { recursive: true }); mkdirSync(proc);
  writeFileSync(join(proc, "stat"), "cpu 1\nbtime 1792258800\n"); // 2026-10-17 17:40Z
  const path = join(journalDir, "6b153c93-0f4d-4456-ba1a-52aecf8a8173.jsonl");
  const timestamp = afterBoot ? "2026-10-17T18:10:00Z" : "2026-10-17T17:18:09Z";
  const append = row => appendFileSync(path, JSON.stringify({ timestamp, ...row }) + "\n");
  append({ type: "user", message: { content: "Continue the movement work" } });
  append({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash" }] } });
  append({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] } });
  // Resume bookkeeping touches the file after boot, but does not resume the turn.
  append({ type: "pr-link", timestamp: "2026-10-17T19:19:05Z" });
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, `fixture:\n  dir: ${dir}\n  panes:\n    - cmd: bash\n    - cmd: claude\n`);
  const calls = [];
  const tmuxExec = async command => {
    calls.push(command);
    if (command.includes("capture-pane")) { onCapture(append); return { stdout: screen }; }
    if (command.includes("pane_current_command")) return { stdout: "claude" };
    return { stdout: "0" };
  };
  return { agent: createAgent({ configPath, tmuxSocket: "/tmp/fake.sock", tmuxExec, procRoot: proc }), calls, proc, root, path, dir: pane, append };
}

describe("delivery and compact activity after a host reboot", () => {
  it("recognizes an interrupted pre-boot tool turn at the live empty composer", async () => {
    // Given the captured crash lifecycle, when inspecting the live pane, then both gates can proceed.
    const { agent, calls } = fixture();
    expect(await agent.isBusy("fixture", 1)).toBe(false);
    expect(await agent.promptTransportState("fixture", 1, "")).toMatchObject({ state: "empty-idle", busy: false });
    expect(calls.some(command => /send-keys|respawn|kill-/u.test(command))).toBe(false);
  });

  it.each([
    ["a turn started after boot", { afterBoot: true }],
    ["an active tool footer", { screen: idle + "\nWorking… (esc to interrupt)" }],
    ["a human draft", { screen: idle.replace("❯ ", "❯ my unsent draft") }],
    ["a collapsed paste", { screen: idle.replace("❯ ", "❯ [Pasted text #1 +2 lines]") }],
    ["clipboard lookup", { screen: idle.replace("bypass permissions on", "Pasting…") }],
    ["an unreadable screen", { screen: "" }],
  ])("keeps %s busy", async (_label, options) => {
    // Given conflicting live evidence, then a pre-boot journal cannot authorize input.
    expect(await fixture(options).agent.isBusy("fixture", 1)).toBe(true);
  });

  it("retains the hold when work arrives during the live observation", async () => {
    // Given post-boot work between reads, then do not authorize compact or delivery.
    const { agent } = fixture({ onCapture: append => append({ type: "user", timestamp: "2026-10-17T19:20:00Z", message: { content: "New work" } }) });
    expect(await agent.isBusy("fixture", 1)).toBe(true);
  });

  it("does not infer a reboot when kernel evidence is absent", async () => {
    // Given unreadable boot evidence, then retain the existing journal guard.
    const { agent, proc } = fixture(); rmSync(proc, { recursive: true });
    expect(await agent.isBusy("fixture", 1)).toBe(true);
  });

  it("compacts a large resumed context and delivers the existing queue identity once", async () => {
    // Given the real activity adapter and durable broker, stand in only for compact and typing.
    const f = fixture(), values = {}, sent = [], compacted = [];
    const state = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } };
    const queue = createDeliveryQueue({ rootDir: join(f.root, "queue"), recordAsk: () => {} });
    const job = queue.enqueue({ agentName: "fixture", pane: 1, text: "Recover the interrupted work", source: "cli" });
    const agent = { ...f.agent, getContext: async () => ({ tokens: 245672 }),
      dismissBlockingPrompt: async () => {},
      sendOnly: async (_name, text, _pane, options) => {
        await options.onPasteStarted?.(); await options.onDrafted?.(); await options.onSubmitting?.();
        sent.push(text); f.append({ type: "user", timestamp: new Date().toISOString(), message: { content: text } });
        await options.onSubmitted?.();
      },
    };
    const maintenance = createContextMaintenance({ agent, queue, state,
      resolveTarget: () => ({ engine: "claude", dir: f.dir }),
      activityFor: () => Date.parse("2026-10-17T17:18:09Z"),
      compactFor: () => async () => { compacted.push("/compact"); return { ok: true }; },
    });
    const broker = createDeliveryBroker({ agent, queue, costAdmission: maintenance.beforeWork, notify: async () => {}, settleMs: 0 });
    // When the pending note retries normally, then verified compact releases it, without replacing its id.
    await broker.kickTarget("fixture", 1); await broker.kickTarget("fixture", 1);
    expect(queue.read("fixture", 1, job.id).status).toBe("acknowledged");
    expect(queue.list("fixture", 1)).toHaveLength(1);
    expect(compacted).toEqual(["/compact"]); expect(sent).toHaveLength(1);
  });
});
