/**
 * WHAT: Builds the explicit-audio SSE and receipt route handlers.
 * WHY: Keeps durable phone delivery separate from pane-response streaming.
 */
export function createAudioFeedHandlers({
  audioOutbox,
  json,
  parseJsonBody,
  pollIntervalMs,
}) {
  async function receipts(req, res, eventId) {
    if (!audioOutbox) return json(res, 503, { error: "audio outbox disabled" });
    try {
      const body = await parseJsonBody(req, 16 * 1024);
      const result = audioOutbox.receipt({
        eventId,
        consumerId: body.consumerId,
        state: body.state,
        detail: body.detail,
      });
      return json(res, result.duplicate ? 200 : 201, result);
    } catch (error) {
      const status = error.message === "audio event not found" ? 404 : 409;
      return json(res, status, { error: error.message });
    }
  }

  async function receiptHistory(_req, res, eventId, url) {
    if (!audioOutbox) return json(res, 503, { error: "audio outbox disabled" });
    try {
      return json(res, 200, {
        eventId,
        receipts: audioOutbox.receiptsFor({
          eventId,
          consumerId: url.searchParams.get("consumerId"),
        }),
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  async function events(req, res, url) {
    if (!audioOutbox) return json(res, 503, { error: "audio outbox disabled" });
    const consumerId = url.searchParams.get("consumerId");
    const target = url.searchParams.get("target");
    const limit = url.searchParams.get("limit");
    try {
      audioOutbox.listPending({ consumerId, target, limit });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (event, data, id = null) => {
      if (id) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    write("open", {
      schemaVersion: 1,
      consumerId,
      target,
      replayLimit: Math.min(100, Math.max(1, Number(limit) || 100)),
      lastEventId: req.headers["last-event-id"] || null,
    });

    let closed = false;
    let lastHeartbeatAt = Date.now();
    const sent = new Set();
    req.on("close", () => { closed = true; });
    while (!closed) {
      try {
        for (const event of audioOutbox.listPending({ consumerId, target, limit })) {
          if (sent.has(event.eventId)) continue;
          write("audio", event, event.eventId);
          sent.add(event.eventId);
        }
      } catch (error) {
        write("error", { message: error.message });
        break;
      }
      if (Date.now() - lastHeartbeatAt >= 15_000) {
        write("heartbeat", { at: new Date().toISOString() });
        lastHeartbeatAt = Date.now();
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, Math.min(pollIntervalMs, 1000)));
    }
    if (!res.writableEnded) res.end();
  }

  return { events, receipts, receiptHistory };
}
