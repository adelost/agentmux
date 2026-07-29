import { component, expect, feature } from "bdd-vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createVoiceBufferTranscriber,
  transcribeVoiceBuffer,
} from "./voice-transcriber.mjs";

feature("shared voice transcriber", () => {
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
});
