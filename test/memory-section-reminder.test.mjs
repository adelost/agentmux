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
  integration("an append that grows a section past the rule is named once per session", {
    given: ["today's note and a pane appending 18 lines through the shell", workspace],
    when: ["the append, a short append, and the long section growing again", ({ home, note }) => {
      appendFileSync(note, `\n## Lång (api:0, 10:00)\n${bullets(18, "lång")}\n`);
      const command = `cat >> ${note} <<'EOF'\n...\nEOF`;
      const first = hook(home, { tool_name: "Bash", tool_input: { command } });
      const again = hook(home, { tool_name: "Bash", tool_input: { command } });
      appendFileSync(note, `\n## Ny kort (api:2, 11:00)\n${bullets(4, "ny")}\n`);
      const short = hook(home, { tool_name: "Bash", tool_input: { command } });
      return { first, again, short };
    }],
    then: ["the first names the section and its size, the repeat and the short one stay silent", ({ first, again, short }, { home }) => {
      expect(first.status, first.err).toBe(0);
      expect(reminderOf(first.out)).toContain('"Lång (api:0, 10:00)" (18 rader)');
      expect(reminderOf(first.out)).toContain("memory/references/");
      expect(again.out).toBe("");
      expect(short.out).toBe("");
      rmSync(home, { recursive: true, force: true });
    }],
  });

  integration("an edit is judged by the section its new text landed in, not the last one", {
    given: ["today's note with a long section followed by a short one", () => {
      const ws = workspace();
      appendFileSync(ws.note, `\n## Gammal lång (lsrc:0, 08:00)\n${bullets(17, "gammal")}\n\n## Sist (api:1, 12:00)\n- en rad\n`);
      return ws;
    }],
    when: ["an Edit adds a line inside the long section, then one inside the short one", ({ home, note }) => ({
      long: hook(home, { tool_name: "Edit", tool_input: { file_path: note, old_string: "- gammal 17", new_string: "- gammal 17" } }),
      short: hook(home, { tool_name: "Edit", tool_input: { file_path: note, old_string: "- en rad", new_string: "- en rad" } }),
    })],
    then: ["only the edit inside the long section is reminded", ({ long, short }, { home }) => {
      expect(reminderOf(long.out)).toContain('"Gammal lång (lsrc:0, 08:00)" (17 rader)');
      expect(short.out).toBe("");
      rmSync(home, { recursive: true, force: true });
    }],
  });

  integration("writes outside today's or yesterday's daily note stay silent", {
    given: ["a long section in an ordinary markdown file and in an old daily note", () => {
      const ws = workspace();
      const other = join(ws.home, "notes.md");
      writeFileSync(other, `## Lång\n${bullets(20, "x")}\n`);
      const old = join(ws.home, "ws", "memory", "2020-01-01.md");
      writeFileSync(old, `## Lång\n${bullets(20, "x")}\n`);
      return { ...ws, other, old };
    }],
    when: ["writing each of them", ({ home, other, old }) => ({
      other: hook(home, { tool_name: "Write", tool_input: { file_path: other, content: "" } }),
      old: hook(home, { tool_name: "Write", tool_input: { file_path: old, content: "" } }),
      unreadable: spawnSync("bash", ["-c", MEMORY_SECTION_REMINDER_CMD], {
        input: "not json memory/2026", env: { ...process.env, HOME: home }, encoding: "utf8",
      }),
    })],
    then: ["nothing is said and nothing fails", ({ other, old, unreadable }, { home }) => {
      expect(other.out).toBe("");
      expect(old.out).toBe("");
      expect(unreadable.status).toBe(0);
      expect(unreadable.stdout).toBe("");
      rmSync(home, { recursive: true, force: true });
    }],
  });
});
