import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { commitDreamProduct } from "../cli/dream.mjs";
import { concurrentNotesJudge, concurrentNotesVerdict, readToolCallTextsSince, toolCallTexts } from "../core/dream-memory-race.mjs";

// 2026-10-08 04:01:42: lsrc:0 logged its E211 note with `cat >>` while claw:1
// curated. The commit refused and that night's digest was lost.
const before = "# 2026-10-08\n\nTidigare anteckning.\n";
const note = "\n## lsrc:0 E211 UI-utlösning (04:0x), e212-first-cut b34b241e\n- KLART lokalt, prov grönt på exakt pin.\n";
const heredoc = `cat >> /ws/memory/2026-10-08.md <<'EOF'\n${note}EOF`;
const curatorSummary = "> Kuraterad av claw:1 efter verifierad kompaktering · run `r`.\n- KLART";

feature("Dream commit beside fleet notes", () => {
  unit("accepts the 15 October insertion under another pane's existing heading", {
    given: ["the controller's file and another pane's bounded patch", () => ({
      before: "# 2026-10-15\n\n## lsrc:8\n- Existing decision.\n\n## claw:0\n- Existing release.\n",
      patch: "*** Update File: /ws/memory/2026-10-15.md\n@@\n - Existing decision.\n+- Follow-up verified.\n",
    })],
    when: ["a new bullet appears in the middle while the curator writes only its summary", (fx) =>
      concurrentNotesVerdict(fx.before, fx.before.replace("- Existing decision.", "- Existing decision.\n- Follow-up verified."),
        { ownerTexts: [curatorSummary], otherTexts: [fx.patch], memPath: "/ws/memory/2026-10-15.md" })],
    then: ["the independent note is not an edited-memory failure", (verdict) => expect(verdict.ok).toBe(true)],
  });
  unit("refuses a curator memory edit even if a later writer restored all original bytes", {
    when: ["judging an unchanged daily file after a curator write", () =>
      concurrentNotesVerdict(before, before, { memPath: "/ws/memory/2026-10-08.md",
        ownerTexts: [JSON.stringify({ tool: "Edit", input: { file_path: "/ws/memory/2026-10-08.md", old_string: "Tidigare", new_string: "Ändrad" } })], otherTexts: [] })],
    then: ["restoring bytes does not erase the prohibited action", (verdict) => expect(verdict.reason).toBe("curator-wrote")],
  });
  unit("refuses a relative shell write after changing into the memory directory", {
    when: ["the curator appends from inside memory rather than naming an absolute target", () =>
      concurrentNotesVerdict(before, before, { memPath: "/ws/memory/2026-10-08.md", ownerTexts: [
        JSON.stringify({ tool: "Bash", input: { command: "cd /ws/memory && cat >> 2026-10-08.md <<'EOF'\nChanged by curator.\nEOF" } }),
      ] })],
    then: ["relative targets cannot bypass the same write boundary", verdict => expect(verdict.reason).toBe("curator-wrote")],
  });
  unit("refuses relative memory paths and the long-term memory index in native write tools", {
    when: ["the curator names a memory target without the daily file's absolute prefix", () =>
      ["../../memory/2026-10-08.md", "/ws/MEMORY.md"].map(file_path => concurrentNotesVerdict(before, before,
        { memPath: "/ws/memory/2026-10-08.md", ownerTexts: [JSON.stringify({ tool: "Write", input: { file_path, content: "Changed by curator." } })] }).reason)],
    then: ["both target forms share the same restriction", reasons => expect(reasons).toEqual(["curator-wrote", "curator-wrote"])],
  });
  unit("keeps the real 13 October quoted awk comparison read-only, including scripted Codex calls", {
    when: ["auditing the native read and a nested shell write", () => {
      const command = "cd /ws/memory && grep -n '^#' 2026-10-12.md | awk -F: '$1>540' | head -n 200";
      const nested = cmd => `text(await tools.exec_command({cmd: ${JSON.stringify(cmd)}}));`;
      return [
        { tool: "Bash", input: { command } },
        { tool: "functions.exec", input: nested(command) },
        { tool: "functions.exec", input: nested("cd /ws/memory && echo changed >> 2026-10-08.md") },
      ].map(call => concurrentNotesVerdict(before, before, { memPath: "/ws/memory/2026-10-08.md", ownerTexts: [JSON.stringify(call)] }).ok);
    }],
    then: ["quoted comparisons stay reads and a real nested redirect stays forbidden", accepted => expect(accepted).toEqual([true, true, false])],
  });
  unit("audits native Codex arguments and patch destinations rather than summary contents", {
    when: ["the summary mentions memory but only a real memory destination is forbidden", () => {
      const patch = path => `*** Begin Patch\n*** Add File: ${path}\n+- See memory/references/work.md\n*** End Patch`;
      const script = input => `await tools.apply_patch(${JSON.stringify(input)});`;
      return [
        { type: "custom_tool_call", name: "apply_patch", input: patch("/ws/output/summary.md") },
        { type: "custom_tool_call", name: "functions.exec", input: script(patch("/ws/output/summary.md")) },
        { type: "custom_tool_call", name: "functions.exec", input: script(patch("/ws/memory/day.md")) },
        { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "echo changed>day.md", workdir: "/ws/memory" }) },
      ].map(payload => concurrentNotesVerdict(before, before, { memPath: "/ws/memory/2026-10-08.md",
        ownerTexts: toolCallTexts({ type: "response_item", payload }, { includeCalls: true }) }).ok);
    }],
    then: ["the actual patch or command targets decide the verdict", accepted => expect(accepted).toEqual([true, true, false, false])],
  });
  unit("refuses edits, deletion and malformed boundaries of a protected Dream block", {
    given: ["a daily file with its protected block", () => before + "<!-- amux-dream-summary:2026-10-08 -->\nVerified original.\n<!-- /amux-dream-summary:2026-10-08 -->\n"],
    when: ["another writer changes the block, removes it or breaks its ending", (memory) => [
      memory.replace("Verified original", "Changed claim"), before, memory.replace("<!-- /amux-dream-summary:2026-10-08 -->", ""),
    ].map(current => concurrentNotesVerdict(memory, current, { memPath: "/ws/memory/2026-10-08.md", ownerTexts: [] }).ok)],
    then: ["none can be accepted as an unrelated note", (accepted) => expect(accepted).toEqual([false, false, false])],
  });
  unit("accepts a note another pane appended in its own tool call", {
    when: ["judging the 04:01 append", () =>
      concurrentNotesVerdict(before, before + note, { ownerTexts: [curatorSummary], otherTexts: [heredoc] })],
    then: ["it is the fleet's note", (verdict) => expect(verdict).toEqual({ ok: true, lines: 2 })],
  });
  unit("refuses curator notes and Dream markers but allows other edits without a fleet-wide attribution gate", {
    when: ["judging each change", () => [
      concurrentNotesVerdict(before, before + note, { ownerTexts: [heredoc], otherTexts: [heredoc] }),
      concurrentNotesVerdict(before, before + note, { ownerTexts: [], otherTexts: [] }),
      concurrentNotesVerdict(before, before.replace("Tidigare", "Ändrad") + note, { ownerTexts: [], otherTexts: [heredoc] }),
      concurrentNotesVerdict(before, `${before}<!-- amux-dream-summary:2026-10-08 -->\n`,
        { ownerTexts: [], otherTexts: ["<!-- amux-dream-summary:2026-10-08 -->"] }),
    ].map((verdict) => verdict.reason || "accepted")],
    then: ["the refusal says which", (reasons) =>
      expect(reasons).toEqual(["curator-wrote", "accepted", "accepted", "dream-marker"])],
  });
  unit("counts only text typed into tools, from Claude and Codex journals", {
    given: ["three journals written after the controller read the file", () => {
      const root = mkdtempSync(join(tmpdir(), "dream-race-"));
      const at = "2026-10-08T02:01:42.000Z", early = "2026-10-08T01:59:00.000Z";
      const quoted = "- Mattias: \"behåll texten\"";
      const claude = join(root, "claude.jsonl"), reader = join(root, "reader.jsonl"), codex = join(root, "codex.jsonl");
      writeFileSync(claude, [
        { type: "assistant", timestamp: early, message: { content: [{ type: "tool_use", input: { command: "echo old" } }] } },
        { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", input: { command: heredoc } }] } },
      ].map((event) => JSON.stringify(event)).join("\n"));
      writeFileSync(reader, JSON.stringify({ type: "user", timestamp: at,
        message: { content: [{ type: "tool_result", content: note }] } }));
      writeFileSync(codex, JSON.stringify({ type: "response_item", timestamp: at,
        payload: { type: "function_call", arguments: JSON.stringify({ cmd: `printf '%s\\n' '${quoted}' >> daily.md` }) } }));
      return { root, claude, reader, codex, quoted, since: Date.parse("2026-10-08T02:00:55.000Z") };
    }],
    when: ["reading each since the read", (fx) => {
      try {
        return { claude: readToolCallTextsSince(fx.claude, fx.since), reader: readToolCallTextsSince(fx.reader, fx.since),
          codex: readToolCallTextsSince(fx.codex, fx.since), quoted: fx.quoted };
      } finally { rmSync(fx.root, { recursive: true, force: true }); }
    }],
    then: ["the writer's command counts, a pane that only read the file does not", (texts) => {
      expect(texts.claude).toEqual([heredoc]);
      expect(texts.reader).toEqual([]);
      expect(texts.codex.some((text) => text.includes(texts.quoted))).toBe(true);
    }],
  });
  unit("needs the curator's exact session before it accepts anything", {
    when: ["the curator pane now runs another session", () => concurrentNotesJudge({
      agents: [{ name: "claw", dir: "/ws", panes: [{ cmd: "claude" }, { cmd: "claude" }] },
        { name: "lsrc", dir: "/lsrc", panes: [{ cmd: "claude" }] }],
      owner: { agent: "claw", pane: 1 }, ownerSessionId: "curated", sinceMs: 0,
      identityFor: (_engine, dir) => ({ sessionId: dir === "/ws/.agents/1" ? "newer" : "other", path: dir }),
      readTexts: () => [heredoc],
    })(before, before + note)],
    then: ["it refuses", (verdict) => expect(verdict).toEqual({ ok: false, reason: "curator-journal-unknown" })],
  });
  component("writes the night's digest beside a note the fleet logged meanwhile", {
    given: ["a curated product and a daily file lsrc:0 appended to while claw:1 worked", () => {
      const home = mkdtempSync(join(tmpdir(), "dream-race-commit-"));
      const dateKey = "2026-10-08", runId = "4e1c60e1-ef50-4802-8410-3f823f9d5b44";
      const memPath = join(home, "workspace", "memory", `${dateKey}.md`);
      mkdirSync(join(home, "workspace", "memory"), { recursive: true });
      const sha = createHash("sha256").update("input").digest("hex");
      const content = `> Kuraterad av claw:1 efter verifierad kompaktering · run \`${runId}\` · source \`${sha}\`.\n- Nattens sammanfattning.`;
      writeFileSync(memPath, before + note);
      return { home, memPath, dateKey, content, recordReceipts: vi.fn() };
    }],
    when: ["the controller commits with the fleet journals as judge", (fx) => {
      try {
        commitDreamProduct({ memPath: fx.memPath, memoryBefore: before, dateKey: fx.dateKey,
          product: { content: fx.content }, included: [{}], omitted: [], receipts: {},
          now: new Date("2026-10-08T02:04:09Z"), recordReceipts: fx.recordReceipts,
          judgeConcurrentNotes: (memoryBefore, current) => concurrentNotesVerdict(memoryBefore, current,
            { ownerTexts: [fx.content], otherTexts: [heredoc] }) });
        return { daily: readFileSync(fx.memPath, "utf8"), receipts: fx.recordReceipts.mock.calls.length };
      } finally { rmSync(fx.home, { recursive: true, force: true }); }
    }],
    then: ["the note stays and the digest is linked once", ({ daily, receipts }) => {
      expect(daily).toContain("## lsrc:0 E211 UI-utlösning");
      expect(daily.match(/<!-- amux-dream-summary:2026-10-08 -->/gu)).toHaveLength(1);
      expect(receipts).toBe(1);
    }],
  });
});
