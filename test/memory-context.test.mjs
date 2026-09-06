import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitMemoryContext, readMemoryContext } from "../core/memory-context.mjs";

const roots = [];
const now = new Date("2026-09-06T06:00:00Z");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-memory-context-"));
  roots.push(root);
  const memory = join(root, "memory");
  mkdirSync(memory);
  const file = join(memory, "2026-09-06.md");
  writeFileSync(file, "# Another pane's private matter\nDO_NOT_INJECT_PRIVATE_CONTENT\n" + "å".repeat(70000));
  const stateDir = join(root, "state");
  const output = [];
  return { root, file, output, options: { workspace: root, stateDir, now, emit: (text) => output.push(text) }, stateDir };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded memory references", () => {
  it("retains dated source/hash pointers but never injects private diary text", () => {
    const f = fixture();
    const before = readFileSync(f.file);
    const result = readMemoryContext(f.root, { now, pane: "example:3" });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(2048);
    expect(result.text).not.toContain("DO_NOT_INJECT_PRIVATE_CONTENT");
    expect(result.text).not.toContain("Another pane");
    expect(result.text).toContain(f.file);
    expect(result.text).toContain(result.files[0].sha256);
    expect(result.text).toContain("amux log example -p 3 -n 3");
    expect(result.files[1].status).toBe("missing");
    expect(readFileSync(f.file)).toEqual(before);
  });

  it("refreshes at the next real turn only when memory changes, without changing source or session", () => {
    const f = fixture();
    const turn = { hook_event_name: "UserPromptSubmit", session_id: "session-one" };
    expect(emitMemoryContext(turn, "example:3", f.options)).toBe(true);
    expect(emitMemoryContext(turn, "example:3", f.options)).toBe(false);
    writeFileSync(f.file, "# Later correction\nA task was already finished.\n");
    expect(emitMemoryContext(turn, "example:3", f.options)).toBe(true);
    expect(f.output).toHaveLength(2);
    expect(f.output[1]).not.toEqual(f.output[0]);
    expect(f.output.join("")).not.toContain("A task was already finished");
    expect(readdirSync(f.stateDir)).toHaveLength(1);
  });

  it("resends a pointer after compact and keeps pane/session identities independent", () => {
    const f = fixture();
    const turn = { hook_event_name: "UserPromptSubmit", session_id: "session-one" };
    emitMemoryContext(turn, "example:3", f.options);
    expect(emitMemoryContext({ ...turn, hook_event_name: "SessionStart", source: "compact" }, "example:3", f.options)).toBe(true);
    expect(emitMemoryContext({ ...turn, session_id: "session-two" }, "example:3", f.options)).toBe(true);
    expect(emitMemoryContext(turn, "example:4", f.options)).toBe(true);
    expect(readdirSync(f.stateDir)).toHaveLength(3);
    expect(emitMemoryContext({ ...turn, hook_event_name: "Stop" }, "example:3", f.options)).toBe(false);
    expect(emitMemoryContext({ ...turn, session_id: "" }, "example:3", f.options)).toBe(false);
  });

  it("reports a large file honestly and does not suppress a hint whose emission failed", () => {
    const f = fixture();
    writeFileSync(f.file, "x".repeat(1024 * 1024 + 1));
    const result = readMemoryContext(f.root, { now });
    expect(result.files[0].status).toBe("reference-only-large-file");
    expect(result.files[0].sha256).toBeUndefined();
    const turn = { hook_event_name: "UserPromptSubmit", session_id: "session-one" };
    expect(() => emitMemoryContext(turn, "example:3", { ...f.options, emit: () => { throw new Error("closed output"); } })).toThrow("closed output");
    expect(emitMemoryContext(turn, "example:3", f.options)).toBe(true);
  });
});
