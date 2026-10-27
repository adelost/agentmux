import { createHash } from "node:crypto";

const KEY = "claim_guard_v1";
const warning = count => `Källa saknas i ${count} påståenden`;
const digest = text => createHash("sha256").update(text).digest("hex");

/** WHAT: Builds one durable reply hold owner per turn. WHY: Keeps human delivery independent of citation checks, corrections and Discord sends. */
export function createClaimGuard({ state, check, mode = () => "shadow", sendHeld, requestCorrection,
  dropCorrection = () => {}, record = () => {}, log = console.warn }) {
  const humanEpoch = new Map();
  const read = () => state.get(KEY, { pending: {}, turns: {} });
  const save = data => state.set(KEY, data);
  const note = (event, reply, result = {}) => record({ at: new Date().toISOString(), event,
    paneKey: reply.paneKey, channelId: reply.channelId, turnId: reply.turnId,
    textSha256: digest(reply.text), ...result });
  function drop(pending) {
    try { dropCorrection(pending); } catch (error) { log(`claim correction cancellation: ${error.message}`); }
  }
  async function release(turnId) {
    const data = read(), pending = data.pending[turnId];
    if (pending?.status !== "held") return;
    pending.status = "sending"; save(data); drop(pending);
    try {
      await sendHeld({ ...pending, text: `${pending.text}\n\n${warning(pending.count)}` });
      const current = read();
      current.pending[turnId].status = "sent"; save(current);
      note("human-release-sent", pending);
    } catch (error) {
      const current = read();
      current.pending[turnId].status = "unknown"; save(current);
      note("human-release-unknown", pending, { error: error.message });
      log(`claim guard send outcome UNKNOWN for ${pending.paneKey}; no automatic replay`);
    }
  }
  return {
    humanMessage(message) {
      if (message.isBot) return;
      const channelId = String(message.channelId);
      humanEpoch.set(channelId, (humanEpoch.get(channelId) || 0) + 1);
      for (const [turnId, pending] of Object.entries(read().pending)) {
        if (String(pending.channelId) === channelId && pending.status === "held") void release(turnId);
      }
    },
    async assess(reply) {
      const selected = mode();
      if (selected === "off" || !reply.text?.trim()) return { text: reply.text };
      const epoch = humanEpoch.get(String(reply.channelId)) || 0;
      if (selected === "shadow") {
        void Promise.resolve().then(() => check(reply.text)).then(result => note("shadow", reply, result))
          .catch(error => note("check-error", reply, { error: error.message }));
        return { text: reply.text };
      }
      const previous = read();
      if (previous.turns[reply.turnId]) return { held: true };
      let result;
      try { result = await check(reply.text); }
      catch (error) {
        note("check-error", reply, { error: error.message });
        return { text: `${reply.text}\n\nKällkontroll okänd: kontrollen kunde inte slutföras.` };
      }
      note("checked", reply, result);
      const data = read();
      const correctionOf = /\[amux claim-guard correction for ([^\]]+)\]/u.exec(reply.prompt || "")?.[1];
      const prior = correctionOf && data.pending[correctionOf];
      if (prior && prior.paneKey === reply.paneKey) {
        if (prior.status === "held") { drop(prior); prior.status = "superseded"; save(data); }
        return { text: result.verdict === "hold" ? `${reply.text}\n\n${warning(result.sentences.length)}` : reply.text };
      }
      if (result.verdict !== "hold") return { text: reply.text };
      if ((humanEpoch.get(String(reply.channelId)) || 0) !== epoch) {
        return { text: `${reply.text}\n\n${warning(result.sentences.length)}` };
      }
      const pending = { ...reply, count: result.sentences.length, status: "held" };
      data.pending[reply.turnId] = pending;
      data.turns = Object.fromEntries(Object.entries({ ...data.turns, [reply.turnId]: "held" }).slice(-1000));
      save(data);
      try {
        const request = requestCorrection(pending, result.sentences);
        const current = read();
        current.pending[reply.turnId].requestId = request?.id || null; save(current);
      } catch (error) {
        note("correction-error", reply, { error: error.message });
        // The saved original is released, never silently stranded by a failed correction enqueue.
        void release(reply.turnId);
      }
      note("held", reply, { count: pending.count });
      return { held: true };
    },
  };
}
