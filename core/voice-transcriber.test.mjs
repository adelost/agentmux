import { component, expect, feature } from "bdd-vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createVoiceBufferTranscriber,
  transcribeVoiceBuffer,
} from "./voice-transcriber.mjs";
import { createPaneReplyReader } from "./pane-latest-reply.mjs";

feature("shared voice transcriber", () => {
  for (const outcome of ["no_speech", "unknown", "refused"]) component(`terminal ${outcome} cannot become a PTT prompt`, {
    when: ["the script returns its terminal result", async () => {
      try {
        return await transcribeVoiceBuffer({ audioBuffer: Buffer.from("audio"), filename: "voice.wav", transcribeScript: "/stub",
          run: async () => {
            if (outcome !== "no_speech") throw Object.assign(new Error("terminal"), { code: outcome === "unknown" ? 22 : 23 });
            return { stdout: "[stt:no_speech]" };
          } });
      } catch (error) { return error; }
    }],
    then: ["the caller receives terminal semantics without content", result => {
      expect(result.code).toBe(outcome); expect(result.status).toBe(422);
      expect(result.text).toBeUndefined();
    }],
  });
  component("one buffer becomes the same prefixed transcript for every host", {
    given: ["a local script runner and audio bytes", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "amux-transcriber-"));
      let observedPath = "";
      return {
        tempDir,
        transcribe: createVoiceBufferTranscriber({
          tempDir,
          transcribeScript: "/opt/transcribe",
          run: async (command, timeoutMs) => {
            observedPath = command.match(/'([^']+\.m4a)'/)?.[1] || "";
            expect(timeoutMs).toBe(60_000);
            expect(readFileSync(observedPath, "utf8")).toBe("VOICE");
            expect(statSync(observedPath).mode & 0o777).toBe(0o600);
            return { stdout: "live från klockan\n" };
          },
        }),
        observedPath: () => observedPath,
      };
    }],
    when: ["transcribing the buffer", async (ctx) => ({
      result: await ctx.transcribe(Buffer.from("VOICE"), "capture.m4a"),
      ctx,
    })],
    then: ["the warning is present and the temporary bytes are removed", ({ result, ctx }) => {
      expect(result).toContain("[transcribed voice, may contain speech-to-text errors; interpret intent]");
      expect(result).toContain("live från klockan");
      expect(existsSync(ctx.observedPath())).toBe(false);
      rmSync(ctx.tempDir, { recursive: true, force: true });
    }],
  });

  component("silent transcription fails explicitly and still cleans up", {
    given: ["a runner returning no words", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "amux-transcriber-empty-"));
      return { tempDir };
    }],
    when: ["transcribing", async (ctx) => {
      try {
        await transcribeVoiceBuffer({
          audioBuffer: Buffer.from("VOICE"),
          filename: "capture.webm",
          run: async () => ({ stdout: "" }),
          transcribeScript: "/opt/transcribe",
          tempDir: ctx.tempDir,
        });
        return { ok: true, ctx };
      } catch (error) {
        return { error, ctx };
      }
    }],
    then: ["the error is truthful and no temporary file remains", ({ error, ctx }) => {
      expect(error.status).toBe(422);
      expect(error.message).toContain("transcription empty");
      expect(readdirSync(ctx.tempDir)).toEqual([]);
      rmSync(ctx.tempDir, { recursive: true, force: true });
    }],
  });
  for (const [pane, expected] of [[3, "Är det en porslinshand?"], [4, undefined]]) {
    component(`the buffer transcriber for lsrc:${pane} ${expected ? "passes that pane's latest reply" : "passes no V1D_CONTEXT, since the pane has no reply"}`, {
      given: ["a reader where only lsrc:3 has replied", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "amux-transcriber-context-"));
        const envs = [];
        const transcribe = createVoiceBufferTranscriber({
          tempDir, transcribeScript: "/opt/transcribe",
          run: async (_command, _timeoutMs, env) => { envs.push(env || {}); return { stdout: "porslinshand" }; },
          paneReply: createPaneReplyReader("/fake/agents.yaml", {
            loadAgents: () => [{ name: "lsrc", dir: "/fake/lsrc", panes: [{}, {}, {}, {}, {}] }],
            readTurns: (_agent, index) => (index === 3 ? { turns: [{ items: [{ type: "text", content: "Är det en porslinshand?" }] }] } : null),
          }),
        });
        return { tempDir, envs, transcribe };
      }],
      when: ["transcribing for the pane", async (ctx) => ctx.transcribe(Buffer.from("VOICE"), "capture.m4a", { name: "lsrc", pane })],
      then: ["the transcriber's environment holds exactly that reply", (_text, ctx) => {
        expect(ctx.envs[0].V1D_CONTEXT).toBe(expected);
        if (!expected) expect(Object.hasOwn(ctx.envs[0], "V1D_CONTEXT")).toBe(false);
        rmSync(ctx.tempDir, { recursive: true, force: true });
      }],
    });
  }
});
