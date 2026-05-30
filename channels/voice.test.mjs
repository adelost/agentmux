import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createVoicePWA } from "./voice.mjs";

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
  writeFileSync(agentsYamlPath, AGENTS_YAML);

  // Fake agent with recordable calls
  const calls = { sendOnly: [], isBusy: [], getResponse: [] };
  const agent = {
    sendOnly: async (name, text, pane) => { calls.sendOnly.push({ name, text, pane }); },
    isBusy: async (name, pane) => { calls.isBusy.push({ name, pane }); return opts.busy ?? false; },
    getResponse: async (name, pane) => { calls.getResponse.push({ name, pane }); return opts.response ?? "the answer"; },
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

  const pwa = createVoicePWA({
    port: 0, // ephemeral
    host: "127.0.0.1",
    token: "test-token",
    agent,
    agentsYamlPath,
    transcribeScript: "/fake/transcribe.sh",
    run,
    mirror,
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
});

