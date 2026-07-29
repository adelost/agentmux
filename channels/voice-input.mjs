import { paneForChannel, phoneTargetChannels } from "./audio-targets.mjs";
import { transcribeVoiceBuffer } from "../core/voice-transcriber.mjs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
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
    return paneForChannel(loadAgents(), target);
  }

  async function transcribe(body) {
    if (typeof body.text === "string" && body.text.trim()) {
      return { text: body.text, transcript: null };
    }
    if (typeof body.audio !== "string" || body.audio.length === 0) {
      throw Object.assign(new Error("body must contain either 'text' or 'audio' (base64)"), { status: 400 });
    }
    return transcribeVoiceBuffer({
      audioBuffer: Buffer.from(body.audio, "base64"),
      filename: body.filename || "voice.webm",
      language: body.lang || "sv",
      run,
      transcribeScript,
    });
  }

  async function deliver(res, { name, pane, body, phoneTarget = null }) {
    let parsed;
    try {
      parsed = await transcribe(body);
    } catch (error) {
      return json(res, error.status || 400, { error: error.message });
    }
    // Correlate the eventual pane response with this exact phone turn. The
    // marker changes no response policy (and notably does not request voice),
    // but prevents repeated prompts such as "status" from returning an older
    // structured response.
    const deliveryText = phoneTarget
      ? `${parsed.text}\n\n[amux-phone-turn:${body.idempotencyKey}]`
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
      try { await mirror.send(channelId, `[voice-pwa] ${parsed.text}`); }
      catch (error) { console.warn(`voice-pwa mirror ${name}:${pane}: ${error.message}`); }
    }

    return json(res, 200, {
      sent: parsed.text,
      replyPrompt: phoneTarget ? deliveryText : null,
      transcript: parsed.transcript,
      queued: Boolean(deliveryBroker),
      destination: { agent: name, pane },
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
    const target = String(body.audioTarget || body.target || "").trim();
    // Any explicitly listed phone channel is addressable; the primary target
    // stays first in discovery. Unknown channels keep the hard refusal.
    if (!phoneTargetChannels(audioDiscovery).includes(target)) {
      return json(res, 403, { error: "PTT target is not a configured audio inbox" });
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
