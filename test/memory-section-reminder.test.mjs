import { expect, feature, integration } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MEMORY_SECTION_REMINDER_CMD } from "../bin/install-hooks.mjs";
import { localDateKey } from "../core/memory-policy.mjs";

const bullets = (count, label) => Array.from({ length: count }, (_, index) => `- ${label} ${index + 1}`).join("\n");

/** A home with a memory workspace whose today's note holds one short section. */
function workspace() {
  const home = mkdtempSync(join(tmpdir(), "amux-memory-reminder-"));
  const memory = join(home, "ws", "memory");
  mkdirSync(memory, { recursive: true });
  const note = join(memory, `${localDateKey()}.md`);
  writeFileSync(note, `# ${localDateKey()}\n\n## Kort (api:1, 09:00)\n${bullets(3, "kort")}\n`);
  return { home, note };
}

/** Runs the exact command the installer registers, shell pre-filter included. */
function hook(home, payload) {
  const result = spawnSync("bash", ["-c", MEMORY_SECTION_REMINDER_CMD], {
    input: JSON.stringify({ session_id: "s1", cwd: home, ...payload }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}

const reminderOf = (out) => out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";

feature("daily memory section reminder", () => {
  integration("project index reminders reach Edit, MultiEdit and Bash without treating UTF-8 bytes as characters", {
    given: ["a project index containing 6000 Unicode codepoints", () => {
      const ws = workspace();
      const index = join(ws.home, "ws", "memory", "MEMORY.md");
      writeFileSync(index, "😀".repeat(6000));
      return { ...ws, index };
    }],
    when: ["checking the boundary and writing one more character through each supported tool", ({ home, index }) => {
      const atLimit = hook(home, { tool_name: "Write", tool_input: { file_path: index } });
      appendFileSync(index, "x");
      const tools = [
        ["Edit", { file_path: index, new_string: "x" }],
        ["MultiEdit", { file_path: index, edits: [{ new_string: "x" }] }],
        ["Bash", { command: `printf x >> ${index}` }],
      ];
      return { atLimit, writes: tools.map(([tool_name, tool_input]) => hook(home, {
        session_id: tool_name, tool_name, tool_input,
      })) };
    }],
    then: ["6000 characters stays silent and every actual hook tool reaches the advisory check", ({ atLimit, writes }, { home }) => {
      expect(atLimit.out).toBe("");
      for (const result of writes) {
        expect(result.status, result.err).toBe(0);
        expect(reminderOf(result.out)).toContain("MEMORY.md är 6001 tecken, taket är 6 000.");
      }
      rmSync(home, { recursive: true, force: true });
    }],
  });

  integration("a 6001-character project index warns once per session and file, but 6000 stays silent", {
    given: ["two independent project memory indexes under a temporary home", () => {
      const ws = workspace();
      const index = join(ws.home, "ws", "memory", "MEMORY.md");
      const other = join(ws.home, "other", "memory", "MEMORY.md");
      mkdirSync(join(other, ".."), { recursive: true });
      return { ...ws, index, other };
    }],
    when: ["writing at the limit, above it, again, in another file and session", ({ home, index, other }) => {
      const write = (file, session_id = "s1") => hook(home, {
        session_id, tool_name: "Write", tool_input: { file_path: file },
      });
      writeFileSync(index, "å".repeat(6000));
      const atLimit = write(index);
      writeFileSync(index, "å".repeat(6001));
      const over = write(index);
      const again = write(index);
      writeFileSync(other, "å".repeat(6001));
      return { atLimit, over, again, other: write(other), newSession: write(index, "s2") };
    }],
    then: ["only new over-limit session/file pairs get nonblocking Swedish context", (results, { home }) => {
      const text = "MEMORY.md är 6001 tecken, taket är 6 000. Lägg minnet i rätt index-*.md och lämna högst ett krokord här.";
      for (const result of Object.values(results)) expect(result.status, result.err).toBe(0);
      expect(results.atLimit.out).toBe("");
      expect(results.again.out).toBe("");
      for (const key of ["over", "other", "newSession"]) expect(reminderOf(results[key].out)).toBe(text);
      rmSync(home, { recursive: true, force: true });
    }],
  });

  integration("daily-file writes never prompt a worker to keep or compact a manual diary", {
    given: ["today's long manual section, retained as history", () => {
      const ws = workspace();
      appendFileSync(ws.note, `\n## Old long section\n${bullets(20, "old")}\n`);
      return ws;
    }],
    when: ["the real registered hook observes each writing tool", ({ home, note }) => [
      ["Write", { file_path: note }],
      ["Edit", { file_path: note, new_string: "old" }],
      ["MultiEdit", { file_path: note, edits: [{ new_string: "old" }] }],
      ["Bash", { command: `cat >> ${note}` }],
    ].map(([tool_name, tool_input]) => hook(home, { session_id: tool_name, tool_name, tool_input }))],
    then: ["automatic conversation logging and Dream need no manual daily reminder", (results, { home }) => {
      for (const result of results) { expect(result.status, result.err).toBe(0); expect(result.out).toBe(""); }
      rmSync(home, { recursive: true, force: true });
    }],
  });
});
