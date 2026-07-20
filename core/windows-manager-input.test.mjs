import { expect, feature, unit } from "bdd-vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyManagerInput, claimManagerSingleton, createVoiceTranscriber } from "./windows-manager-input.mjs";

const VOICE = {
  id: "1528902101869006950",
  content: "",
  flags: 8192,
  attachments: [{
    url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
    size: 3,
    content_type: "audio/ogg",
  }],
};

feature("windows manager Discord input", () => {
  unit("text, commands, empty messages, and voice notes classify without guessing", {
    then: ["only one bounded Discord voice attachment becomes voice input", () => {
      expect(classifyManagerInput({ content: " hej " })).toEqual({ kind: "text", text: "hej" });
      expect(classifyManagerInput({ content: "//status" })).toEqual({ kind: "skip", reason: "restarter-command" });
      expect(classifyManagerInput({ content: "", attachments: [] })).toEqual({ kind: "skip", reason: "empty-or-unsupported" });
      expect(classifyManagerInput(VOICE)).toEqual({
        kind: "voice",
        attachment: { url: VOICE.attachments[0].url, size: 3 },
      });
      expect(classifyManagerInput({ ...VOICE, flags: 0 }).kind).toBe("skip");
      expect(classifyManagerInput({ ...VOICE, attachments: [{ ...VOICE.attachments[0], url: "https://evil.test/a.ogg" }] }))
        .toEqual({ kind: "skip", reason: "voice-url-untrusted" });
      expect(classifyManagerInput({ ...VOICE, attachments: [{ ...VOICE.attachments[0], size: 30 * 1024 * 1024 }] }))
        .toEqual({ kind: "skip", reason: "voice-size-invalid" });
    }],
  });

  unit("the transcriber is bounded, local, and deletes its temporary voice file", {
    then: ["download bytes reach the configured Python model exactly once", async () => {
      const runs = [];
      const transcribe = createVoiceTranscriber({
        config: { transcription: { kind: "faster-whisper", pythonPath: "python.exe", modelPath: "C:\\model", timeoutMs: 20_000 } },
        rootDir: "/tmp/amux-windows-voice-test",
        scriptPath: "C:\\manager\\windows-transcribe.py",
        fetchImpl: async () => ({
          ok: true,
          headers: { get: () => "3" },
          arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
        }),
        runImpl: async (file, args, timeoutMs) => {
          runs.push({ file, args, timeoutMs });
          return { ok: true, stdout: " Hallå från mobilen.\n", timedOut: false };
        },
      });
      expect(await transcribe({ attachment: { url: VOICE.attachments[0].url, size: 3 } }))
        .toEqual({ ok: true, text: "Hallå från mobilen." });
      expect(runs).toHaveLength(1);
      expect(runs[0].file).toBe("python.exe");
      expect(runs[0].args.slice(0, 3)).toEqual(["C:\\manager\\windows-transcribe.py", "--model", "C:\\model"]);
      expect(runs[0].timeoutMs).toBe(20_000);
    }],
  });

  unit("transcription failures stay classified and never reach the model", {
    then: ["missing config and oversized downloads fail closed", async () => {
      const missing = createVoiceTranscriber({ config: {}, rootDir: "/tmp/x", scriptPath: "x" });
      expect(await missing({ attachment: VOICE.attachments[0] })).toEqual({ ok: false, reason: "not-configured" });
      const oversized = createVoiceTranscriber({
        config: { transcription: { kind: "faster-whisper", pythonPath: "p", modelPath: "m" } },
        rootDir: "/tmp/x",
        scriptPath: "x",
        fetchImpl: async () => ({ ok: true, headers: { get: () => "4" }, arrayBuffer: async () => new ArrayBuffer(4) }),
      });
      expect(await oversized({ attachment: VOICE.attachments[0] })).toEqual({ ok: false, reason: "download-size-mismatch" });
    }],
  });

  unit("the manager singleton rejects a concurrent consumer and releases after exit", {
    then: ["one process-held pipe owns the Discord cursor at a time", async () => {
      const pipe = join(tmpdir(), `amux_manager_${process.pid}.sock`);
      rmSync(pipe, { force: true });
      const first = await claimManagerSingleton(pipe);
      await expect(claimManagerSingleton(pipe)).rejects.toThrow("manager-already-running");
      await new Promise((resolvePromise) => first.close(resolvePromise));
      const replacement = await claimManagerSingleton(pipe);
      await new Promise((resolvePromise) => replacement.close(resolvePromise));
      rmSync(pipe, { force: true });
    }],
  });
});
