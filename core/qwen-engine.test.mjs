import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { buildQwenLaunchCommand } from "./agent-launch-command.mjs";
import { createQwenAgentRuntime } from "./qwen-agent-runtime.mjs";
import {
  captureQwenPromptEchoCursor,
  extractFromQwenJsonl,
  getContextFromQwenJsonl,
  isBusyFromQwenJsonl,
  isPromptInQwenJsonl,
  prepareQwenRuntimeFiles,
  publishQwenRuntime,
  readLastTurnsQwen,
  submitQwenPrompt,
} from "./qwen-jsonl-reader.mjs";
import { generateAgentsYaml, generateChannelNames, parseConfig } from "../sync.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";

function source({ qwen = false } = {}) {
  return `
guild: "1"
agents:
  demo:
    dir: /tmp/demo
    claude: 1
    codex: 1
    kimi: 1
    services:
      - npm run dev
    shells: 1
${qwen ? "    qwen: 1\n    qwenModel: qwen3.8-max\n" : ""}`;
}

feature("Qwen source pane plan", () => {
  unit("keeps Claude and Codex fixed while grouping one Kimi and one Qwen before utility panes", {
    given: ["the same mixed category before and after Qwen is enabled", () => {
      const before = parseConfig(source()).agents;
      const after = parseConfig(source({ qwen: true })).agents;
      const ids = new Map([["demo", "demo-id"]]);
      return {
        before: yaml.load(generateAgentsYaml(before, new Map(), ids)).demo.panes,
        after: yaml.load(generateAgentsYaml(after, new Map(), ids)).demo.panes,
        channels: generateChannelNames(after),
      };
    }],
    when: ["the runtime pane plan is generated", (fixture) => fixture],
    then: ["the coding engines are contiguous and only service/shell indices move", ({ before, after, channels }) => {
      expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
      expect(after[3]).toMatchObject({ name: "qwen", engine: "qwen", model: "qwen3.8-max" });
      expect(after[4]).toEqual(before[3]);
      expect(after[5]).toEqual(before[4]);
      expect(after[3].cmd).toContain("qwen");
      expect(channels).toContainEqual(expect.objectContaining({
        agentName: "demo", pane: 3, dialect: "qwen", channelName: "demo-3-qwen",
      }));
    }],
  });

  unit("rejects Qwen on native backends until that runtime supports it", {
    when: ["parsing an unsupported native Qwen pane", () => () => parseConfig(`
agents:
  demo:
    dir: /tmp/demo
    backend: native
    claude: 1
    qwen: 1
`)],
    then: ["configuration fails instead of silently changing engines", (parse) => {
      expect(parse).toThrow("cannot define Qwen tmux panes");
    }],
  });
});

feature("Qwen exact-session launch", () => {
  unit("starts a fresh named session with structured AMUX channels", {
    when: ["building the first Qwen pane launch", () => buildQwenLaunchCommand({
      executable: "/home/test/.local/bin/qwen",
      model: "qwen3.8-max",
      sessionId,
      eventPath: "/state/events.jsonl",
      inputPath: "/state/input.jsonl",
      allowFreshBootstrap: true,
    })],
    then: ["the command pins model, session and dual-output paths", (command) => {
      expect(command).toContain("--session-id '11111111-1111-4111-8111-111111111111'");
      expect(command).toContain("--model 'qwen3.8-max'");
      expect(command).toContain("--json-file '/state/events.jsonl'");
      expect(command).toContain("--input-file '/state/input.jsonl'");
      expect(command).toContain("--approval-mode yolo");
      expect(command).toContain("--exclude-tools ask_user_question");
    }],
  });

  unit("resumes only the exact pane-owned session", {
    when: ["building a resumed Qwen pane launch", () => buildQwenLaunchCommand({
      executable: "/home/test/.local/bin/qwen",
      model: "qwen3.8-max",
      sessionId,
      resume: true,
      eventPath: "/state/events.jsonl",
      inputPath: "/state/input.jsonl",
    })],
    then: ["resume never falls back to latest or continue", (command) => {
      expect(command).toContain("--resume '11111111-1111-4111-8111-111111111111'");
      expect(command).not.toContain("--session-id");
      expect(command).not.toContain("--continue");
    }],
  });

  unit("the persistent pane resumes the same Qwen session after a process restart", {
    given: ["an empty pane and a fake Qwen TUI that writes its real protocol handshake", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-qwen-runtime-"));
      const repo = join(root, "repo");
      const pane = join(repo, ".agents", "4");
      const stateRoot = join(root, "state");
      const commands = [];
      const runtime = createQwenAgentRuntime({
        t: {
          runShell: async (_target, command) => {
            commands.push(command);
            const eventsPath = /--json-file '([^']+)'/u.exec(command)?.[1];
            const exact = /--(?:session-id|resume) '([^']+)'/u.exec(command)?.[1];
            writeFileSync(eventsPath, `${JSON.stringify({
              type: "system", subtype: "session_start", session_id: exact,
              data: { session_id: exact, cwd: pane, protocol_version: 2 },
            })}\n`);
          },
          currentCommand: async () => "node",
          sendKeys: async () => {},
          respawnPane: async () => {},
        },
        wait: async () => {},
        paneDir: () => pane,
        agentConfig: () => ({ dir: repo, panes: [{}, {}, {}, {}, { model: "qwen3.8-max" }] }),
        isBusy: async () => false,
        isPaneDead: async () => false,
        respawnPane: async () => {},
        isAlreadyRunning: async () => false,
        isShellProcess: () => true,
        captureScreen: async () => "> Type your message or @path/to/file",
        stateRoot,
      });
      return { root, runtime, commands };
    }],
    when: ["starting, stopping and starting the same pane again", async (fixture) => {
      const first = await fixture.runtime.startQwen("demo", "demo:.4", "/repo", 4);
      const second = await fixture.runtime.startQwen("demo", "demo:.4", "/repo", 4);
      return { ...fixture, first, second };
    }],
    then: ["the second launch uses exact --resume with the first UUID", (fixture) => {
      expect(fixture.first.identity.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(fixture.commands).toHaveLength(2);
      expect(fixture.commands[0]).toContain(`--session-id '${fixture.first.identity.sessionId}'`);
      expect(fixture.commands[1]).toContain(`--resume '${fixture.first.identity.sessionId}'`);
      expect(fixture.second.identity.sessionId).toBe(fixture.first.identity.sessionId);
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});

feature("Qwen structured pane receipts", () => {
  unit("reads timestamped native Qwen history while hiding private reasoning", {
    given: ["a published pane and Qwen Code's real chat-recording shape", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-qwen-history-"));
      const paneDir = join(root, "pane");
      const stateRoot = join(root, "state");
      const qwenHome = join(root, ".qwen");
      const chats = join(qwenHome, "projects", "fixture", "chats");
      const files = prepareQwenRuntimeFiles(paneDir, {
        stateRoot, sessionId, model: "qwen3.8-max", generation: "history",
      });
      writeFileSync(files.eventsPath, `${JSON.stringify({
        type: "system", subtype: "session_start", session_id: sessionId,
        data: { session_id: sessionId, cwd: paneDir, protocol_version: 2 },
      })}\n`);
      publishQwenRuntime(files);
      mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, `${sessionId}.jsonl`), [
        { type: "user", sessionId, timestamp: "2026-09-22T03:24:14.067Z",
          message: { role: "user", parts: [{ text: "HISTORY_TEST" }] } },
        { type: "assistant", sessionId, timestamp: "2026-09-22T03:24:19.863Z", model: "qwen3.8-max",
          message: { role: "model", parts: [{ text: "private chain", thought: true }, { text: "PUBLIC_OK" }] },
          usageMetadata: { totalTokenCount: 35727 } },
      ].map(JSON.stringify).join("\n") + "\n");
      return { root, paneDir, stateRoot, qwenHome };
    }],
    when: ["AMUX reads the pane history", (fixture) => ({ ...fixture,
      history: readLastTurnsQwen(fixture.paneDir, { stateRoot: fixture.stateRoot, qwenHome: fixture.qwenHome }),
    })],
    then: ["the public answer has stable time and private thought stays private", (fixture) => {
      expect(fixture.history.turns[0]).toMatchObject({
        timestamp: "2026-09-22T03:24:14.067Z",
        endTimestamp: "2026-09-22T03:24:19.863Z",
        userPrompt: "HISTORY_TEST",
        isComplete: true,
      });
      expect(fixture.history.turns[0].items).toEqual([expect.objectContaining({ content: "PUBLIC_OK" })]);
      expect(JSON.stringify(fixture.history)).not.toContain("private chain");
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });

  unit("proves prompt intake, model, completion and exact response without TUI scraping", {
    given: ["a private pane runtime and one completed Qwen turn", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-qwen-pane-"));
      const paneDir = join(root, "repo", ".agents", "9");
      const stateRoot = join(root, "state");
      const files = prepareQwenRuntimeFiles(paneDir, {
        stateRoot, sessionId, model: "qwen3.8-max", generation: "g1",
      });
      writeFileSync(files.eventsPath, [
        { type: "system", subtype: "session_start", session_id: sessionId,
          data: { session_id: sessionId, cwd: paneDir, protocol_version: 2 } },
      ].map(JSON.stringify).join("\n") + "\n");
      publishQwenRuntime(files);
      const cursor = captureQwenPromptEchoCursor(paneDir, "AMUX_QWEN_TEST", { stateRoot });
      const events = [
        { type: "user", session_id: sessionId,
          message: { role: "user", content: [{ type: "text", text: "AMUX_QWEN_TEST" }] } },
        { type: "assistant", session_id: sessionId, model: "qwen3.8-max",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }],
            usage: { input_tokens: 100, output_tokens: 10 } } },
        { type: "assistant", session_id: sessionId, model: "qwen3.8-max",
          message: { role: "assistant", content: [{ type: "text", text: "QWEN_AMUX_OK" }],
            usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112 } } },
      ];
      writeFileSync(files.eventsPath,
        `${readFileSync(files.eventsPath, "utf8")}${events.map(JSON.stringify).join("\n")}\n`);
      return { root, paneDir, stateRoot, files, cursor };
    }],
    when: ["AMUX reads the structured sidecar", (fixture) => ({
      ...fixture,
      accepted: isPromptInQwenJsonl(fixture.paneDir, "AMUX_QWEN_TEST", {
        stateRoot: fixture.stateRoot, cursor: fixture.cursor,
      }),
      busy: isBusyFromQwenJsonl(fixture.paneDir, { stateRoot: fixture.stateRoot }),
      response: extractFromQwenJsonl(fixture.paneDir, "AMUX_QWEN_TEST", { stateRoot: fixture.stateRoot }),
      context: getContextFromQwenJsonl(fixture.paneDir, { stateRoot: fixture.stateRoot }),
    })],
    then: ["the receipt is exact and the private thinking is not returned", (fixture) => {
      expect(fixture.accepted).toBe(true);
      expect(fixture.busy).toBe(false);
      expect(fixture.response).toMatchObject({ source: "qwen-dual-output", model: "qwen3.8-max" });
      expect(fixture.response.items).toEqual([expect.objectContaining({ type: "text", content: "QWEN_AMUX_OK" })]);
      expect(JSON.stringify(fixture.response)).not.toContain("private");
      expect(fixture.context).toMatchObject({ model: "qwen3.8-max", tokens: 112, sessionId });
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });

  unit("appends one exact submit command to the pane-owned input file", {
    given: ["a published Qwen pane runtime", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-qwen-input-"));
      const paneDir = join(root, "pane");
      const stateRoot = join(root, "state");
      const files = prepareQwenRuntimeFiles(paneDir, {
        stateRoot, sessionId, model: "qwen3.8-max", generation: "g2",
      });
      writeFileSync(files.eventsPath, `${JSON.stringify({
        type: "system", subtype: "session_start", session_id: sessionId,
        data: { session_id: sessionId, cwd: paneDir, protocol_version: 2 },
      })}\n`);
      publishQwenRuntime(files);
      return { root, paneDir, stateRoot, files };
    }],
    when: ["the broker submits one prompt", async (fixture) => {
      await submitQwenPrompt(fixture.paneDir, "Hej åäö", { stateRoot: fixture.stateRoot });
      return fixture;
    }],
    then: ["the input protocol contains exactly one UTF-8 submit row", (fixture) => {
      expect(readFileSync(fixture.files.inputPath, "utf8")).toBe(
        `${JSON.stringify({ type: "submit", text: "Hej åäö" })}\n`,
      );
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});
