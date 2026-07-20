import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { esc } from "../lib.mjs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPT_PREFIX = "[transcribed voice, may contain speech-to-text errors; interpret intent]";
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,120}$/;

/** WHAT: Builds one delivery path for text, voice and phone PTT input. WHY: Keeps transcription and idempotency identical across the PWA and native app. */
export function createVoiceInput({
  agent,
  audioDiscovery,
  audioOutbox,
  deliveryBroker,
  findChannelIdForPane,
  json,
  loadAgents,
  mirror,
  parseJsonBody,
  run,
  transcribeScript,
  validatePane,
}) {
  function paneForTarget(target) {
    for (const [name, entry] of Object.entries(loadAgents())) {
      const mapping = entry?.discord;
      if (mapping && typeof mapping === "object" && Object.hasOwn(mapping, target)) {
        return { name, pane: Number(mapping[target]) };
      }
    }
    return null;
  }

  async function transcribe(body) {
    if (typeof body.text === "string" && body.text.trim()) {
      return { text: body.text, transcript: null };
    }
    if (typeof body.audio !== "string" || body.audio.length === 0) {
      throw Object.assign(new Error("body must contain either 'text' or 'audio' (base64)"), { status: 400 });
    }
    const ext = (body.filename?.split(".").pop() || "webm")
      .toLowerCase().replace(/[^a-z0-9]/g, "") || "webm";
    const tmpPath = join("/tmp", `voice-pwa-${randomBytes(8).toString("hex")}.${ext}`);
    try {
      writeFileSync(tmpPath, Buffer.from(body.audio, "base64"));
    } catch (error) {
      throw Object.assign(new Error(`invalid base64 audio: ${error.message}`), { status: 400 });
    }
    try {
      const lang = (body.lang || "sv").replace(/[^a-z]/g, "");
      const { stdout } = await run(`'${esc(transcribeScript)}' '${esc(tmpPath)}' '${esc(lang)}'`, 60000);
      const transcript = String(stdout || "").trim();
      if (!transcript) {
        throw Object.assign(new Error("transcription empty; audio may have been silent or unintelligible"), { status: 422 });
      }
      return { text: `${TRANSCRIPT_PREFIX} ${transcript}`, transcript };
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error(`transcription failed: ${error.message}`), { status: 500 });
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }

  async function deliver(res, { name, pane, body, phoneTarget = null }) {
    let parsed;
    try {
      parsed = await transcribe(body);
    } catch (error) {
      return json(res, error.status || 400, { error: error.message });
    }
    const phoneTurn = phoneTarget && parsed.transcript;
    const deliveryText = phoneTurn
      ? `${parsed.text}\n\n[Audio Inbox PTT ${body.idempotencyKey}: answer normally, then send one concise spoken completion with amux say.]`
      : parsed.text;
    try {
      if (deliveryBroker) {
        deliveryBroker.enqueue({
          agentName: name,
          pane,
          text: deliveryText,
          source: "voice-pwa",
          idempotencyKey: body.idempotencyKey || null,
        });
      } else {
        await agent.sendOnly(name, deliveryText, pane);
      }
    } catch (error) {
      return json(res, 500, { error: `send failed: ${error.message}` });
    }

    const channelId = findChannelIdForPane(name, pane);
    if (mirror?.send && channelId) {
      try { await mirror.send(channelId, `[voice-pwa] ${phoneTurn ? parsed.text : deliveryText}`); }
      catch (error) { console.warn(`voice-pwa mirror ${name}:${pane}: ${error.message}`); }
    }

    return json(res, 200, {
      sent: parsed.text,
      transcript: parsed.transcript,
      queued: Boolean(deliveryBroker),
    });
  }

  async function pane(req, res, name, paneString) {
    const paneIndex = Number.parseInt(paneString, 10);
    if (Number.isNaN(paneIndex)) return json(res, 400, { error: "pane must be an integer" });
    const validity = validatePane(name, paneIndex);
    if (!validity.ok) return json(res, 400, { error: validity.error });
    let body;
    try { body = await parseJsonBody(req, MAX_AUDIO_BYTES + 1024 * 1024); }
    catch (error) { return json(res, 400, { error: error.message }); }
    return deliver(res, { name, pane: paneIndex, body });
  }

  async function phone(req, res) {
    if (!audioOutbox) return json(res, 503, { error: "audio outbox disabled" });
    let body;
    try { body = await parseJsonBody(req, MAX_AUDIO_BYTES + 1024 * 1024); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const target = String(body.target || "").trim();
    const configured = String(audioDiscovery?.target || "").trim();
    if (!configured || target !== configured) {
      return json(res, 403, { error: "PTT target is not the configured audio inbox" });
    }
    if (!TURN_ID_PATTERN.test(String(body.idempotencyKey || ""))) {
      return json(res, 400, { error: "PTT idempotencyKey is required" });
    }
    const destination = paneForTarget(target);
    if (!destination) return json(res, 503, { error: "configured PTT pane is unavailable" });
    return deliver(res, { ...destination, body, phoneTarget: target });
  }

  return { pane, phone };
}
