import http from "node:http";

const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 4_000;
const MAX_RECEIPTS = 50;
const TURN_ID = /^[A-Za-z0-9_.:@-]{1,120}$/u;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload-too-large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("invalid-json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function decodeAudio(value) {
  if (typeof value !== "string" || !value.length) return null;
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error("audio-size-invalid"), { status: 400 });
  }
  return bytes;
}

function remember(state, turnId, receipt) {
  const turns = state.phoneTurns && typeof state.phoneTurns === "object" ? state.phoneTurns : {};
  turns[turnId] = receipt;
  const retained = Object.entries(turns)
    .sort(([, left], [, right]) => Number(left.updatedAtMs || 0) - Number(right.updatedAtMs || 0))
    .slice(-MAX_RECEIPTS);
  state.phoneTurns = Object.fromEntries(retained);
}

/** WHAT: Builds the Windows-native tailnet phone endpoint. WHY: Keeps rescue chat reachable when WSL and tmux are completely offline. */
export function createWindowsManagerPhoneServer({
  host,
  port = 8081,
  serverId = "abyss-windows",
  state,
  saveState,
  processTurn,
  transcribeAudio,
  nowMs = () => Date.now(),
  onError = () => {},
} = {}) {
  if (!host || typeof saveState !== "function" || typeof processTurn !== "function") {
    throw new Error("phone server needs host, state, saveState and processTurn");
  }

  async function send(req, res) {
    const body = await readJson(req);
    const turnId = String(body.idempotencyKey || "").trim();
    if (!TURN_ID.test(turnId)) return json(res, 400, { error: "idempotencyKey-required" });
    const previous = state.phoneTurns?.[turnId];
    if (previous?.status === "completed") return json(res, 200, { ...previous.result, replayed: true });
    if (previous) return json(res, 409, { error: `turn-${previous.status}`, replayed: true });

    let transcript = "";
    let text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length > MAX_TEXT_CHARS) return json(res, 400, { error: "text-too-large" });
    const audio = decodeAudio(body.audio);
    if (!text && audio) {
      const result = await transcribeAudio({ bytes: audio, filename: body.filename || "ptt.m4a" });
      if (!result?.ok) return json(res, 422, { error: `transcription-${result?.reason || "failed"}` });
      transcript = result.text;
      text = result.text;
    }
    if (!text) return json(res, 400, { error: "text-or-audio-required" });

    remember(state, turnId, { status: "started", updatedAtMs: nowMs() });
    saveState(state);
    try {
      const result = await processTurn({ text, turnId });
      const response = {
        sent: text,
        transcript,
        answer: String(result.answer || "").trim(),
        outcome: result.outcome || "ANSWERED",
        destination: { manager: "windows" },
      };
      if (!response.answer) throw new Error("manager-answer-empty");
      remember(state, turnId, { status: "completed", updatedAtMs: nowMs(), result: response });
      saveState(state);
      return json(res, 200, response);
    } catch (error) {
      remember(state, turnId, { status: "failed", updatedAtMs: nowMs(), reason: error.message });
      saveState(state);
      return json(res, 500, { error: "manager-turn-failed" });
    }
  }

  async function handler(req, res) {
    const path = new URL(req.url, "http://windows-manager").pathname;
    if (req.method === "GET" && path === "/api/audio/config") {
      return json(res, 200, {
        service: "agentmux-windows-manager-audio",
        schemaVersion: 1,
        serverId,
        targets: [{ id: "windows", label: "Windows rescue", kind: "manager", favorite: true }],
      });
    }
    if (req.method === "POST" && path === "/api/audio/send") {
      try { return await send(req, res); }
      catch (error) { return json(res, error.status || 500, { error: error.message || "internal-error" }); }
    }
    return json(res, 404, { error: "route-not-found" });
  }

  let server;
  return {
    start: () => new Promise((resolve, reject) => {
      server = http.createServer(handler);
      const startError = (error) => reject(error);
      server.once("error", startError);
      server.listen(port, host, () => {
        server.removeListener("error", startError);
        server.on("error", onError);
        resolve(server.address());
      });
    }),
    close: () => new Promise((resolve) => server ? server.close(resolve) : resolve()),
    handler,
  };
}
