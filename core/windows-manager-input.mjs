import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VOICE_FLAG = 1 << 13;
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const DISCORD_MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** WHAT: Builds one authorized Discord input plan. WHY: Keeps voice and text in one explicit input seam. */
export function classifyManagerInput(message) {
  const text = String(message?.content || "").trim();
  if (text.startsWith("//")) return { kind: "skip", reason: "restarter-command" };
  if (text) return { kind: "text", text };
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const voice = (Number(message?.flags) & VOICE_FLAG) === VOICE_FLAG;
  if (!voice || attachments.length !== 1) return { kind: "skip", reason: "empty-or-unsupported" };
  const attachment = attachments[0];
  const size = Number(attachment?.size);
  let url;
  try { url = new URL(String(attachment?.url || "")); } catch { return { kind: "skip", reason: "voice-url-invalid" }; }
  if (url.protocol !== "https:" || !DISCORD_MEDIA_HOSTS.has(url.hostname)) {
    return { kind: "skip", reason: "voice-url-untrusted" };
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VOICE_BYTES) {
    return { kind: "skip", reason: "voice-size-invalid" };
  }
  if (!String(attachment?.content_type || "").startsWith("audio/")) {
    return { kind: "skip", reason: "voice-type-invalid" };
  }
  return { kind: "voice", attachment: { url: url.href, size } };
}

function runTranscriber(file, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const timedOut = Boolean(error) && (error.killed === true || error.code === "ETIMEDOUT");
      resolvePromise({ ok: !error, timedOut, stdout: String(stdout || "").trim() });
    });
  });
}

/** WHAT: Builds a bounded Discord voice transcriber. WHY: Keeps voice rescue independent from WSL. */
export function createVoiceTranscriber({ config, rootDir, scriptPath, fetchImpl = fetch, runImpl = runTranscriber }) {
  const spec = config.transcription || {};
  if (spec.kind !== "faster-whisper" || !spec.pythonPath || !spec.modelPath) {
    return async () => ({ ok: false, reason: "not-configured" });
  }
  const transcribeBytes = createAudioBytesTranscriber({ config, rootDir, scriptPath, runImpl });
  return async ({ attachment }) => {
    let response;
    try {
      response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(30_000) });
    } catch {
      return { ok: false, reason: "download-failed" };
    }
    if (!response.ok) return { ok: false, reason: `download-http-${response.status}` };
    const announced = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(announced) && announced > attachment.size) return { ok: false, reason: "download-size-mismatch" };
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch { return { ok: false, reason: "download-failed" }; }
    if (!bytes.length || bytes.length > MAX_VOICE_BYTES || bytes.length > attachment.size) {
      return { ok: false, reason: "download-size-mismatch" };
    }
    return transcribeBytes({ bytes, filename: "discord.ogg" });
  };
}

/** WHAT: Builds the shared bounded byte-to-text seam. WHY: Lets Discord and the tailnet phone endpoint use one offline transcription contract. */
export function createAudioBytesTranscriber({ config, rootDir, scriptPath, runImpl = runTranscriber }) {
  return async ({ bytes, filename = "voice.m4a" }) => {
    const spec = config.transcription || {};
    if (spec.kind !== "faster-whisper" || !spec.pythonPath || !spec.modelPath) {
      return { ok: false, reason: "not-configured" };
    }
    const input = Buffer.from(bytes || []);
    if (!input.length || input.length > MAX_VOICE_BYTES) return { ok: false, reason: "audio-size-invalid" };
    const extension = String(filename).split(".").at(-1)?.toLowerCase().replace(/[^a-z0-9]/gu, "") || "m4a";
    const tempDir = join(rootDir, "tmp");
    const inputPath = join(tempDir, `voice_${process.pid}_${Date.now()}.${extension}`);
    try {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(inputPath, input, { flag: "wx" });
      const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs) || 90_000, 10_000), 180_000);
      const result = await runImpl(spec.pythonPath, [scriptPath, "--model", spec.modelPath, inputPath], timeoutMs);
      if (result.timedOut) return { ok: false, reason: "timeout" };
      const text = String(result.stdout || "").replace(/[\r\n]+/gu, " ").trim();
      if (!result.ok) return { ok: false, reason: "engine-failed" };
      if (!text) return { ok: false, reason: "empty" };
      return { ok: true, text: text.slice(0, 4000) };
    } finally {
      rmSync(inputPath, { force: true });
    }
  };
}

/** WHAT: Builds a process-held singleton pipe. WHY: Prevents a second manager from consuming the same Discord turn. */
export function claimManagerSingleton(pipePath = "\\\\.\\pipe\\agentmux-windows-manager-v1") {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (error) => rejectPromise(new Error(error?.code === "EADDRINUSE" ? "manager-already-running" : "manager-singleton-failed")));
    server.listen(pipePath, () => {
      server.unref();
      resolvePromise(server);
    });
  });
}
