import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createVoicePWA } from "./voice.mjs";
import { createAudioOutbox } from "../core/audio-outbox.mjs";

// --- Helpers ---------------------------------------------------------------

const AGENTS_YAML = `
claw:
  dir: /tmp/claw
  discord:
    "chan-0": 0
    "chan-1": 1
  panes:
    - name: claude
      cmd: claude --continue
      label: orchestration driver
    - name: claude-2
      cmd: claude --continue
    - name: shell-1
      cmd: bash
ai:
  dir: /tmp/ai
  panes:
    - name: claude
      cmd: claude
`;

function setupServer(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "voice-pwa-test-"));
  const agentsYamlPath = join(root, "agents.yaml");
  writeFileSync(agentsYamlPath, opts.agentsYaml || AGENTS_YAML);

  // Fake agent with recordable calls
  const calls = { sendOnly: [], isBusy: [], getResponse: [] };
  const agent = {
    sendOnly: async (name, text, pane) => { calls.sendOnly.push({ name, text, pane }); },
    isBusy: async (name, pane) => {
      calls.isBusy.push({ name, pane });
      return opts.busyFunction ? opts.busyFunction() : (opts.busy ?? false);
    },
    getResponse: async (name, pane) => { calls.getResponse.push({ name, pane }); return opts.response ?? "the answer"; },
    hasResponseForPrompt: () => opts.responseReady
      ? opts.responseReady()
      : Boolean(opts.responseForPrompt),
    getResponseStreamWithRaw: async () => ({
      items: opts.responseItems
        || [{ type: "text", content: opts.responseForPrompt || "the exact answer" }],
    }),
  };

  // Fake run() that returns canned transcription/tts output
  const runCalls = [];
  const run = async (cmd) => {
    runCalls.push(cmd);
    if (cmd.includes("edge-tts")) {
      // Simulate writing an MP3 to the tmp path mentioned after --write-media
      const m = cmd.match(/--write-media '([^']+)'/);
      if (m) writeFileSync(m[1], Buffer.from("FAKE-MP3-BYTES"));
      return { stdout: "", stderr: "" };
    }
    // transcribe script: last arg is lang, second-to-last is path
    return { stdout: opts.transcription ?? "hej claw", stderr: "" };
  };

  const mirror = opts.mirror ? { send: async (channelId, text) => { opts.mirror.calls.push({ channelId, text }); } } : null;
  const reactivePoke = opts.reactivePoke
    ? async (info) => { opts.reactivePoke.calls.push(info); }
    : null;

  const pwa = createVoicePWA({
    port: 0, // ephemeral
    host: "127.0.0.1",
    token: "test-token",
    agent,
    agentsYamlPath,
    transcribeScript: "/fake/transcribe.sh",
    run,
    mirror,
    reactivePoke,
    deliveryBroker: opts.deliveryBroker || null,
    audioOutbox: opts.audioOutbox || null,
    audioDiscovery: opts.audioDiscovery,
  });

  return {
    pwa, agent, run, calls, runCalls, agentsYamlPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function request(url, opts = {}) {
  const res = await fetch(url, opts);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json()
    : ct.includes("audio") ? Buffer.from(await res.arrayBuffer())
    : await res.text();
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

// --- /api/agents -----------------------------------------------------------

feature("GET /api/agents", () => {
  component("returns sorted list with panes + labels", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["authed GET", async ({ url }) =>
      request(`${url}/api/agents`, { headers: { authorization: "Bearer test-token" } })],
    then: ["ai then claw, with correct panes + labels", async (r, { s }) => {
      expect(r.status).toBe(200);
      expect(r.body.agents.map((a) => a.name)).toEqual(["ai", "claw"]);
      const claw = r.body.agents.find((a) => a.name === "claw");
      expect(claw.panes.length).toBe(3);
      expect(claw.panes[0].label).toBe("orchestration driver");
      expect(claw.panes[1].label).toBeNull();
      expect(claw.panes[0].command).toBe("claude");
      await s.pwa.stop(); s.cleanup();
    }],
  });
});

// --- /api/send (text) ------------------------------------------------------

feature("POST /api/send: text path", () => {
  component("valid text → agent.sendOnly called, 200", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST text", async ({ url }) =>
      request(`${url}/api/send/claw/1`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "hello there" }),
      })],
    then: ["200 + agent got the text at correct pane", async (r, { s }) => {
      expect(r.status).toBe(200);
      expect(r.body.sent).toBe("hello there");
      expect(s.calls.sendOnly).toEqual([{ name: "claw", text: "hello there", pane: 1 }]);
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("pane out of bounds → 400 with helpful error", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST to pane 99", async ({ url }) =>
      request(`${url}/api/send/claw/99`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      })],
    then: ["400 with bound info, agent not called", async (r, { s }) => {
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("pane 99 does not exist");
      expect(r.body.error).toContain("claw");
      expect(r.body.error).toContain("0-2");
      expect(s.calls.sendOnly).toEqual([]);
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("unknown agent → 400 listing known agents", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST to ghost/0", async ({ url }) =>
      request(`${url}/api/send/ghost/0`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      })],
    then: ["400 with known agents list", async (r, { s }) => {
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("unknown agent 'ghost'");
      expect(r.body.error).toContain("ai");
      expect(r.body.error).toContain("claw");
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("missing text + missing audio → 400", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST empty body", async ({ url }) =>
      request(`${url}/api/send/claw/0`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      })],
    then: ["400 with clear guidance", async (r, { s }) => {
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/text.*audio|audio.*text/i);
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("Discord mirror fires when pane has a binding", {
    given: ["server + mirror sink", async () => {
      const mirror = { calls: [] };
      const s = setupServer({ mirror });
      const { url } = await s.pwa.start();
      return { s, url, mirror };
    }],
    when: ["POST text to claw/0 (bound to chan-0)", async ({ url }) =>
      request(`${url}/api/send/claw/0`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "hej bilen" }),
      })],
    then: ["mirror got the same text with source tag", async (r, { s, mirror }) => {
      expect(r.status).toBe(200);
      expect(mirror.calls).toEqual([{ channelId: "chan-0", text: "[voice-pwa] hej bilen" }]);
      await s.pwa.stop(); s.cleanup();
    }],
  });
});

// --- /api/poke (reactive watcher trigger) ---------------------------------

feature("POST /api/poke: reactive watcher trigger", () => {
  component("disabled by default → 404 and no watcher trigger", {
    given: ["server without reactivePoke wiring", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST poke to claw/1", async ({ url }) =>
      request(`${url}/api/poke/claw/1`, { method: "POST" })],
    then: ["route is unavailable", async (r, { s }) => {
      expect(r.status).toBe(404);
      expect(r.body.error).toContain("disabled");
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("enabled wiring pokes exactly one pane with its configured dir", {
    given: ["server with reactivePoke sink", async () => {
      const reactivePoke = { calls: [] };
      const s = setupServer({ reactivePoke });
      const { url } = await s.pwa.start();
      return { s, url, reactivePoke };
    }],
    when: ["POST poke to claw/1", async ({ url }) =>
      request(`${url}/api/poke/claw/1`, { method: "POST" })],
    then: ["only claw:1 is sent to the watcher adapter", async (r, { s, reactivePoke }) => {
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, agent: "claw", pane: 1 });
      expect(reactivePoke.calls).toEqual([{ name: "claw", pane: 1, dir: "/tmp/claw" }]);
      await s.pwa.stop(); s.cleanup();
    }],
  });
});

// --- /api/send (audio) -----------------------------------------------------

feature("POST /api/send: audio path", () => {
  component("base64 audio → transcription → prefixed text → sendOnly", {
    given: ["server + canned transcription", async () => {
      const s = setupServer({ transcription: "hej claw hur mår du" });
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST audio blob", async ({ url }) => {
      const audio = Buffer.from("FAKE-AUDIO-BYTES").toString("base64");
      return request(`${url}/api/send/claw/0`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ audio, filename: "voice.webm", lang: "sv" }),
      });
    }],
    then: ["transcript prefixed with disclaimer and sent to pane", async (r, { s }) => {
      expect(r.status).toBe(200);
      expect(r.body.sent).toMatch(/^\[transcribed voice,.*interpret intent\] hej claw hur mår du$/);
      expect(s.calls.sendOnly.length).toBe(1);
      expect(s.calls.sendOnly[0].text).toContain("interpret intent");
      expect(s.calls.sendOnly[0].text).toContain("hej claw hur mår du");
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("empty transcription → 422 (not 200 with empty send)", {
    given: ["server that transcribes to empty string", async () => {
      const s = setupServer({ transcription: "" });
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST audio", async ({ url }) => {
      const audio = Buffer.from("SILENT").toString("base64");
      return request(`${url}/api/send/claw/0`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ audio }),
      });
    }],
    then: ["422 and no pane write", async (r, { s }) => {
      expect(r.status).toBe(422);
      expect(s.calls.sendOnly).toEqual([]);
      await s.pwa.stop(); s.cleanup();
    }],
  });
});

feature("POST /api/audio/send: native phone PTT", () => {
  component("configured channel routes one transcript without synthesizing the user's own voice", {
    given: ["audio inbox target, broker and durable outbox", async () => {
      const root = mkdtempSync(join(tmpdir(), "voice-ptt-test-"));
      const journalPath = join(root, "audio.jsonl");
      const outbox = createAudioOutbox({ journalPath });
      const enqueued = [];
      const s = setupServer({
        transcription: "starta om bryggan",
        audioOutbox: outbox,
        audioDiscovery: { serverId: "test", target: "chan-0" },
        deliveryBroker: { enqueue: (job) => enqueued.push(job) },
      });
      const { url } = await s.pwa.start();
      return { s, url, outbox, enqueued, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }],
    when: ["same phone turn is posted twice after an ambiguous HTTP result", async ({ url }) => {
      const body = JSON.stringify({
        audio: Buffer.from("PHONE-AUDIO").toString("base64"),
        filename: "ptt.m4a",
        lang: "sv",
        target: "chan-0",
        idempotencyKey: "turn-phone-1",
      });
      return Promise.all([
        request(`${url}/api/audio/send`, { method: "POST", headers: { "content-type": "application/json" }, body }),
        request(`${url}/api/audio/send`, { method: "POST", headers: { "content-type": "application/json" }, body }),
      ]);
    }],
    then: ["route is bound, broker key is stable and only the agent reply enters audio", async (responses, ctx) => {
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses[0].body).toMatchObject({ transcript: "starta om bryggan" });
      expect(responses[0].body).not.toHaveProperty("echoQueued");
      expect(ctx.enqueued).toHaveLength(2);
      expect(ctx.enqueued.every((job) => job.agentName === "claw" && job.pane === 0)).toBe(true);
      expect(ctx.enqueued.every((job) => job.idempotencyKey === "turn-phone-1")).toBe(true);
      expect(ctx.enqueued[0].text).not.toContain("amux say");
      expect(ctx.enqueued[0].text).toContain("[amux-phone-turn:turn-phone-1]");
      expect(responses[0].body.replyPrompt).toBe(ctx.enqueued[0].text);
      expect(responses[0].body.destination).toEqual({ agent: "claw", pane: 0 });
      expect(ctx.outbox.listPending({ consumerId: "phone", target: "chan-0" })).toEqual([]);
      await ctx.s.pwa.stop(); ctx.s.cleanup(); ctx.cleanup();
    }],
  });

  component("unconfigured target is rejected before transcription or delivery", {
    given: ["server configured for another channel", async () => {
      const root = mkdtempSync(join(tmpdir(), "voice-ptt-reject-"));
      const s = setupServer({
        audioOutbox: createAudioOutbox({ journalPath: join(root, "audio.jsonl") }),
        audioDiscovery: { serverId: "test", target: "chan-1" },
      });
      const { url } = await s.pwa.start();
      return { s, url, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }],
    when: ["phone requests another target", async ({ url }) => request(`${url}/api/audio/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio: "YQ==", target: "chan-0", idempotencyKey: "turn-wrong" }),
    })],
    then: ["request is refused without a pane write", async (response, ctx) => {
      expect(response.status).toBe(403);
      expect(ctx.s.calls.sendOnly).toEqual([]);
      await ctx.s.pwa.stop(); ctx.s.cleanup(); ctx.cleanup();
    }],
  });

  component("every listed phone target is discoverable and routes to its own pane", {
    given: ["a server listing two snowflake phone targets", async () => {
      const root = mkdtempSync(join(tmpdir(), "voice-ptt-multi-"));
      const enqueued = [];
      const s = setupServer({
        agentsYaml: `
claw:
  dir: /tmp/claw
  discord:
    "11111111111111111111": 0
    "22222222222222222222": 1
  panes:
    - name: claude
      cmd: claude --continue
      label: orchestration driver
    - name: claude-2
      cmd: claude --continue
`,
        audioOutbox: createAudioOutbox({ journalPath: join(root, "audio.jsonl") }),
        audioDiscovery: { serverId: "test", target: "11111111111111111111", targets: ["11111111111111111111", "22222222222222222222"] },
        deliveryBroker: { enqueue: (job) => enqueued.push(job) },
      });
      const { url } = await s.pwa.start();
      return { s, url, enqueued, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }],
    when: ["discovery is fetched and a turn targets the secondary channel", async ({ url }) => {
      const config = await request(`${url}/api/audio/config`);
      const sent = await request(`${url}/api/audio/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hej lsrc:10", target: "22222222222222222222", idempotencyKey: "turn-multi-1" }),
      });
      return { config, sent };
    }],
    then: ["both panes are targets, the primary is favorite, and pane 1 receives the turn", async ({ config, sent }, ctx) => {
      expect(config.status).toBe(200);
      expect(config.body.targets).toHaveLength(2);
      expect(config.body.targets[0]).toMatchObject({ id: "claw:0", agent: "claw", pane: 0, audioTarget: "11111111111111111111", favorite: true });
      expect(config.body.targets[1]).toMatchObject({ id: "claw:1", agent: "claw", pane: 1, audioTarget: "22222222222222222222", favorite: false });
      expect(sent.status).toBe(200);
      expect(sent.body.destination).toEqual({ agent: "claw", pane: 1 });
      expect(ctx.enqueued).toHaveLength(1);
      expect(ctx.enqueued[0]).toMatchObject({ agentName: "claw", pane: 1 });
      await ctx.s.pwa.stop(); ctx.s.cleanup(); ctx.cleanup();
    }],
  });
});

// --- /api/tts --------------------------------------------------------------

feature("POST /api/tts", () => {
  component("text → audio/mpeg blob", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST tts text", async ({ url }) =>
      request(`${url}/api/tts`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "hej där" }),
      })],
    then: ["200 audio/mpeg with bytes", async (r, { s }) => {
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("audio/mpeg");
      expect(r.body.length).toBeGreaterThan(0);
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("missing text → 400", {
    given: ["server up", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["POST empty", async ({ url }) =>
      request(`${url}/api/tts`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      })],
    then: ["400", async (r, { s }) => {
      expect(r.status).toBe(400);
      await s.pwa.stop(); s.cleanup();
    }],
  });
});

// --- /api/events (SSE) -----------------------------------------------------

feature("GET /api/events: SSE stream", () => {
  component("emits status working → idle → text → done and closes", {
    given: ["server, agent starts busy then idles", async () => {
      // isBusy returns true first N calls, then false, so we see working→idle
      let calls = 0;
      const agent = {
        isBusy: async () => {
          calls++;
          return calls < 2; // first call busy, subsequent idle
        },
        getResponse: async () => "vi gjorde det.",
        sendOnly: async () => {},
      };
      const root = mkdtempSync(join(tmpdir(), "voice-pwa-sse-"));
      const path = join(root, "agents.yaml");
      writeFileSync(path, AGENTS_YAML);
      const pwa = createVoicePWA({
        port: 0, host: "127.0.0.1", token: "t",
        agent, agentsYamlPath: path,
        transcribeScript: "/fake", run: async () => ({ stdout: "", stderr: "" }),
        pollIntervalMs: 50, // fast poll for tests
      });
      const { url } = await pwa.start();
      return { pwa, url, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }],
    when: ["streaming /api/events/claw/0", async ({ url }) => {
      const res = await fetch(`${url}/api/events/claw/0`, {
        headers: { authorization: "Bearer t" },
      });
      // Read until we see `event: done` or 5s pass
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        if (buf.includes("event: done")) break;
      }
      return buf;
    }],
    then: ["stream had status events, text, and done", async (stream, { pwa, cleanup }) => {
      expect(stream).toContain("event: open");
      expect(stream).toContain("event: status");
      expect(stream).toContain("working");
      expect(stream).toContain("idle");
      expect(stream).toContain("event: text");
      expect(stream).toContain("vi gjorde det.");
      expect(stream).toContain("event: done");
      await pwa.stop();
      cleanup();
    }],
  });

  component("invalid pane → 400 (not a stream)", {
    given: ["server", async () => {
      const s = setupServer();
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["GET events for pane 9", async ({ url }) =>
      request(`${url}/api/events/claw/9`, { headers: { authorization: "Bearer test-token" } })],
    then: ["400 with bound error", async (r, { s }) => {
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("pane 9");
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("an exact prompt closes the race when the turn finished before the first busy poll", {
    given: ["an already completed structured reply", async () => {
      const s = setupServer({ responseForPrompt: "reply for this phone turn" });
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["the phone opens the reply stream with the submitted prompt", async ({ url }) => {
      const response = await fetch(`${url}/api/events/claw/0?prompt=${encodeURIComponent("hej exakt")}`);
      return response.text();
    }],
    then: ["the exact response is emitted even though working was never observed", async (stream, { s }) => {
      expect(stream).toContain("reply for this phone turn");
      expect(stream).toContain("event: done");
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("a correlated steered reply returns while the pane continues other work", {
    given: ["a busy pane with structured text for the exact phone prompt", async () => {
      const s = setupServer({
        busy: true,
        responseForPrompt: "reply before the long turn ends",
        responseItems: [
          { type: "text", content: "reply before the long turn ends" },
          { type: "tool", content: "continued unrelated work" },
          { type: "text", content: "later progress from the long turn" },
        ],
      });
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["the phone waits for that reply", async ({ url }) => {
      const response = await fetch(
        `${url}/api/events/claw/0?prompt=${encodeURIComponent("steered phone prompt")}`,
        { signal: AbortSignal.timeout(1_000) },
      );
      return response.text();
    }],
    then: ["the exact text completes without waiting for pane idle", async (stream, { s }) => {
      expect(stream).toContain("reply before the long turn ends");
      expect(stream).not.toContain("later progress from the long turn");
      expect(stream).toContain("event: done");
      await s.pwa.stop(); s.cleanup();
    }],
  });

  component("an unrelated active turn cannot be mistaken for the requested phone reply", {
    given: ["another turn finishes before the requested prompt appears", async () => {
      let busyPoll = 0;
      let responsePoll = 0;
      const s = setupServer({
        responseForPrompt: "only the correlated reply",
        busyFunction: () => busyPoll++ === 0,
        responseReady: () => responsePoll++ >= 2,
      });
      const { url } = await s.pwa.start();
      return { s, url };
    }],
    when: ["the exact reply stream observes both turns", async ({ url }) => {
      const response = await fetch(`${url}/api/events/claw/0?prompt=${encodeURIComponent("phone prompt")}`);
      return response.text();
    }],
    then: ["it waits for exact prompt evidence", async (stream, { s }) => {
      expect(stream).toContain("only the correlated reply");
      await s.pwa.stop(); s.cleanup();
    }],
  });
});

feature("explicit audio phone feed", () => {
  component("discovery returns one verified default target and fails closed when unconfigured", {
    given: ["configured and unconfigured servers", async () => {
      const configured = setupServer({
        audioDiscovery: {
          serverId: "abyss-wsl",
          target: "1502949109491961917",
        },
      });
      const missing = setupServer();
      const configuredAddress = await configured.pwa.start();
      const missingAddress = await missing.pwa.start();
      return { configured, missing, configuredAddress, missingAddress };
    }],
    when: ["the phone requests both discovery documents", async (ctx) => ({
      configured: await request(`${ctx.configuredAddress.url}/api/audio/config`),
      missing: await request(`${ctx.missingAddress.url}/api/audio/config`),
    })],
    then: ["only the explicit versioned configuration is discoverable", async (result, ctx) => {
      expect(result.configured.status).toBe(200);
      expect(result.configured.body).toEqual({
        service: "agentmux-audio-inbox",
        schemaVersion: 2,
        serverId: "abyss-wsl",
        target: "1502949109491961917",
        defaultTarget: null,
        targets: [],
      });
      expect(result.missing.status).toBe(503);
      await ctx.configured.pwa.stop();
      await ctx.missing.pwa.stop();
      ctx.configured.cleanup();
      ctx.missing.cleanup();
    }],
  });

  component("SSE replays one event and receipts keep received distinct from played", {
    given: ["a restarted durable outbox and voice server", async () => {
      const root = mkdtempSync(join(tmpdir(), "voice-audio-feed-test-"));
      const journalPath = join(root, "audio.jsonl");
      const publisher = createAudioOutbox({
        journalPath,
        now: () => new Date("2026-07-20T15:00:00.000Z"),
        id: () => "evt-phone-1",
      });
      publisher.publish({ text: "Hej i lurarna", target: "chan-0" });
      const s = setupServer({
        audioOutbox: createAudioOutbox({
          journalPath,
          now: () => new Date("2026-07-20T15:00:01.000Z"),
        }),
      });
      const { url } = await s.pwa.start();
      return { root, s, url };
    }],
    when: ["the phone receives the SSE item then posts received and queued", async ({ url }) => {
      const controller = new AbortController();
      const response = await fetch(
        `${url}/api/audio/events?consumerId=phone-1&target=chan-0`,
        { signal: controller.signal },
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let stream = "";
      while (!stream.includes("event: audio")) {
        const chunk = await reader.read();
        stream += decoder.decode(chunk.value || new Uint8Array());
      }
      controller.abort();
      const received = await request(`${url}/api/audio/events/evt-phone-1/receipts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumerId: "phone-1", state: "received" }),
      });
      const queued = await request(`${url}/api/audio/events/evt-phone-1/receipts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumerId: "phone-1", state: "queued" }),
      });
      const history = await request(
        `${url}/api/audio/events/evt-phone-1/receipts?consumerId=phone-1`,
      );
      return { stream, received, queued, history };
    }],
    then: ["the event has a stable SSE id and no played receipt was synthesized", async (result, ctx) => {
      expect(result.stream).toContain("id: evt-phone-1");
      expect(result.stream).toContain("Hej i lurarna");
      expect(result.received.status).toBe(201);
      expect(result.queued.status).toBe(201);
      expect(result.history.body.receipts.map((entry) => entry.state))
        .toEqual(["received", "queued"]);
      await ctx.s.pwa.stop();
      ctx.s.cleanup();
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("playback-started makes restart replay-safe and receipt retries are idempotent", {
    given: ["one event with received and queued receipts", async () => {
      const root = mkdtempSync(join(tmpdir(), "voice-audio-receipt-test-"));
      const journalPath = join(root, "audio.jsonl");
      const outbox = createAudioOutbox({
        journalPath,
        now: () => new Date("2026-07-20T15:00:00.000Z"),
        id: () => "evt-phone-2",
      });
      outbox.publish({ text: "En gång", target: "chan-0" });
      outbox.receipt({ eventId: "evt-phone-2", consumerId: "phone-1", state: "received" });
      outbox.receipt({ eventId: "evt-phone-2", consumerId: "phone-1", state: "queued" });
      const s = setupServer({ audioOutbox: createAudioOutbox({ journalPath }) });
      const { url } = await s.pwa.start();
      return { root, journalPath, s, url };
    }],
    when: ["playback-started is posted twice", async ({ url }) => {
      const post = () => request(`${url}/api/audio/events/evt-phone-2/receipts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumerId: "phone-1", state: "playback-started" }),
      });
      return { first: await post(), retry: await post() };
    }],
    then: ["the retry is accepted without a second row and the event is no longer pending", async (result, ctx) => {
      expect(result.first.status).toBe(201);
      expect(result.retry.status).toBe(200);
      expect(result.retry.body.duplicate).toBe(true);
      await ctx.s.pwa.stop();
      ctx.s.cleanup();
      const restarted = createAudioOutbox({ journalPath: ctx.journalPath });
      expect(restarted.listPending({ consumerId: "phone-1", target: "chan-0" })).toEqual([]);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
