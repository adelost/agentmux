import { feature, component, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { GEMINI_FORBIDDEN_ENV } from "./gemini-launch.mjs";
import { prepareGeminiRuntimeFiles, publishGeminiRuntime } from "./gemini-pane-files.mjs";
import { captureGeminiPromptEchoCursor, extractFromGeminiJsonl, getContextFromGeminiJsonl,
  isBusyFromGeminiJsonl, isPromptInGeminiJsonl, readLastTurnsGemini } from "./gemini-jsonl-reader.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSession = "22222222-2222-4222-8222-222222222222";
const row = value => `${JSON.stringify(value)}\n`;
const user = (content, id = "user-1") => ({ id, type: "user", content: [{ text: content }], timestamp: "2026-10-27T18:00:01Z" });
const answer = (content, extra = {}) => ({ id: "answer-1", type: "gemini", content,
  model: "gemini-2.5-pro", timestamp: "2026-10-27T18:00:02Z", ...extra });
const before = (prompt = "Hej åäö", extra = {}) => ({ hook_event_name: "BeforeAgent", session_id: sessionId,
  generation: "g1", prompt, ...extra });
const after = (extra = {}) => ({ ...before(), hook_event_name: "AfterAgent", prompt_response: "PUBLIC", ...extra });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-gemini-reader-"));
  const pane = join(root, "pane");
  const options = { stateRoot: join(root, "state") };
  function create(generation = "g1") {
    const files = prepareGeminiRuntimeFiles(pane, { ...options, sessionId, profileHome: join(root, "profile"), generation });
    const path = join(files.profileHome, ".gemini", "tmp", "pane", "chats", "session-2026-10-27T18-00-11111111.jsonl");
    appendFileSync(files.eventsPath, row({ hook_event_name: "SessionStart", session_id: sessionId,
      generation, cwd: pane, transcript_path: path,
      environment: Object.fromEntries(GEMINI_FORBIDDEN_ENV.map(name => [name, false])) }));
    publishGeminiRuntime(files);
    return { ...files, path };
  }
  const files = create();
  mkdirSync(dirname(files.path), { recursive: true });
  writeFileSync(files.path, row({ sessionId, kind: "main", projectHash: "fixture" }));
  const append = (...records) => appendFileSync(files.path, records.map(row).join(""));
  const hooks = (...records) => appendFileSync(files.eventsPath, records.map(row).join(""));
  return { root, pane, options, files, create, append, hooks };
}
const cleanup = ctx => rmSync(ctx.root, { recursive: true, force: true });

feature("Gemini exact root journal and receipts", () => {
  component("native context setup never appears as an addressed user turn", {
    given: ["real0.65 record shapes and one public turn", () => {
      const ctx = fixture();
      ctx.append(user("<session_context>PRIVATE SETUP</session_context>", "setup"),
        { $set: { lastUpdated: "2026-10-27T18:00:01Z" } }, user("Hej åäö"),
        answer("PUBLIC", { thoughts: [{ text: "PRIVATE THOUGHT" }], tokens: { input: 100, output: 12, cached: 30, total: 112 } }));
      ctx.hooks(before(), after());
      return ctx;
    }],
    when: ["history, extraction and context are read", ctx => ({
      history: readLastTurnsGemini(ctx.pane, ctx.options), response: extractFromGeminiJsonl(ctx.pane, "Hej åäö", ctx.options),
      context: getContextFromGeminiJsonl(ctx.pane, ctx.options),
    })],
    then: ["only the actual user and public answer survive", ({ history, response, context }) => {
      expect(history.turns).toHaveLength(1);
      expect(history.turns[0]).toMatchObject({ userPrompt: "Hej åäö", sessionId, isComplete: true });
      expect(response.raw).toBe("PUBLIC");
      expect(JSON.stringify(history)).not.toContain("PRIVATE");
      expect(context).toMatchObject({ model: "gemini-2.5-pro", tokens: 112, sessionId, max: null, percent: null });
    }], cleanup,
  });

  component("updated records replace their own content without duplicating text or item IDs", {
    given: ["the CLI appends the same message again when its tokens arrive", () => {
      const ctx = fixture();
      ctx.append(user("Hej åäö"), answer("old"), answer([{ text: "first" }, { text: "second" }]),
        answer([{ text: "first" }, { text: "second" }], { tokens: { total: 12 } }));
      return ctx;
    }],
    when: ["extracting twice", ctx => [extractFromGeminiJsonl(ctx.pane, null, ctx.options), extractFromGeminiJsonl(ctx.pane, null, ctx.options)]],
    then: ["the two distinct public blocks have stable distinct IDs", ([first, second]) => {
      expect(first.items.map(item => item.content)).toEqual(["first", "second"]);
      expect(new Set(first.items.map(item => item.id)).size).toBe(2);
      expect(second.items.map(item => item.id)).toEqual(first.items.map(item => item.id));
    }], cleanup,
  });

  component("a tool result is not a new user prompt or a final answer", {
    given: ["one user, tool invocation and tool-result record", () => {
      const ctx = fixture();
      ctx.append(user("Hej åäö"), answer("", { toolCalls: [{ id: "tool-1", name: "run_shell_command", args: { command: "pwd" }, status: "executing" }] }),
        { id: "result", type: "user", content: [{ functionResponse: { name: "run_shell_command", response: { output: "PRIVATE TOOL RESULT" } } }] });
      ctx.hooks(before());
      return ctx;
    }],
    when: ["reading the active turn", ctx => readLastTurnsGemini(ctx.pane, ctx.options)],
    then: ["the public tool belongs to the original incomplete turn", history => {
      expect(history.turns).toHaveLength(1);
      expect(history.turns[0].isComplete).toBe(false);
      expect(history.turns[0].items[0].type).toBe("tool");
      expect(JSON.stringify(history)).not.toContain("PRIVATE TOOL RESULT");
    }], cleanup,
  });

  for (const kind of ["foreign-session", "foreign-generation", "child"]) component(`${kind} cannot acknowledge the root prompt`, {
    given: ["an exact captured prompt cursor", () => {
      const ctx = fixture();
      ctx.cursor = captureGeminiPromptEchoCursor(ctx.pane, "Hej åäö", ctx.options);
      return ctx;
    }],
    when: ["the wrong identity appends the same text", ctx => {
      ctx.hooks(before("Hej åäö", kind === "foreign-session" ? { session_id: otherSession }
        : kind === "foreign-generation" ? { generation: "old" } : { parent_tool_use_id: "child" }));
      return isPromptInGeminiJsonl(ctx.pane, "Hej åäö", { ...ctx.options, cursor: ctx.cursor });
    }], then: ["no receipt", accepted => expect(accepted).toBe(false)], cleanup,
  });

  component("identical prompts need a new append after the cursor", {
    given: ["one old matching prompt", () => {
      const ctx = fixture(); ctx.hooks(before());
      ctx.cursor = captureGeminiPromptEchoCursor(ctx.pane, "Hej åäö", ctx.options); return ctx;
    }],
    when: ["checking before and after a new intake", ctx => {
      const old = isPromptInGeminiJsonl(ctx.pane, "Hej åäö", { ...ctx.options, cursor: ctx.cursor });
      ctx.hooks(before());
      return [old, isPromptInGeminiJsonl(ctx.pane, "Hej åäö", { ...ctx.options, cursor: ctx.cursor })];
    }], then: ["only the new intake acknowledges", values => expect(values).toEqual([false, true])], cleanup,
  });

  component("a replacement generation cannot acknowledge an older delivery, but its original receipt can", {
    given: ["a cursor from a process that is then replaced", () => {
      const ctx = fixture(); ctx.cursor = captureGeminiPromptEchoCursor(ctx.pane, "Hej åäö", ctx.options);
      ctx.next = ctx.create("g2"); return ctx;
    }],
    when: ["the replacement and then original process append", ctx => {
      appendFileSync(ctx.next.eventsPath, row(before("Hej åäö", { generation: "g2" })));
      const replacement = isPromptInGeminiJsonl(ctx.pane, "Hej åäö", { ...ctx.options, cursor: ctx.cursor });
      ctx.hooks(before());
      return [replacement, isPromptInGeminiJsonl(ctx.pane, "Hej åäö", { ...ctx.options, cursor: ctx.cursor })];
    }], then: ["receipt ownership survives restart without crossing generations", result => expect(result).toEqual([false, true])], cleanup,
  });

  component("missing AfterAgent returns unknown so the live dialect decides busy", {
    given: ["a prompt with no completion hook", () => { const ctx = fixture(); ctx.hooks(before()); return ctx; }],
    when: ["checking activity before and after an exact completion", ctx => {
      const missing = isBusyFromGeminiJsonl(ctx.pane, ctx.options); ctx.hooks(after());
      return [missing, isBusyFromGeminiJsonl(ctx.pane, ctx.options)];
    }], then: ["an absent hook never traps a cancelled pane as busy", result => expect(result).toEqual([null, false])], cleanup,
  });

  for (const problem of ["wrong-header", "subagent-header"]) component(`${problem} never becomes root history`, {
    given: ["a transcript with an untrusted header", () => {
      const ctx = fixture();
      writeFileSync(ctx.files.path, row({ sessionId: problem === "wrong-header" ? otherSession : sessionId,
        kind: problem === "subagent-header" ? "subagent" : "main" }));
      ctx.append(user("Hej åäö"), answer("NOT ROOT")); return ctx;
    }], when: ["reading history", ctx => readLastTurnsGemini(ctx.pane, ctx.options)],
    then: ["root output is absent", result => expect(result).toBeNull()], cleanup,
  });

  component("a long native journal retains its UTF-8 tail and declares truncation", {
    given: ["a large record followed by a tiny newest turn", () => {
      const ctx = fixture(); ctx.append({ $set: { padding: "å".repeat(3000) } }, user("Hej åäö"), answer("Svar åäö")); return ctx;
    }], when: ["reading a bounded tail", ctx => readLastTurnsGemini(ctx.pane, { ...ctx.options, tailBytes: 1024 })],
    then: ["large history is a window rather than an empty pane", history => {
      expect(history.truncated).toBe(true); expect(history.turns[0].items[0].content).toBe("Svar åäö");
    }], cleanup,
  });
});
