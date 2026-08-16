import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachmentHandler } from "../attachments.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";
import { createInboundReconciler, formatRecoveredNotice } from "./inbound-reconciler.mjs";
import { mergeInboundTarget } from "./inbound-target.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "amux-discord-inbound-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function message(id, channelId, {
  text = `message-${id}`,
  attachments = [],
  bot = false,
  createdTimestamp = Number(id),
} = {}) {
  return {
    id: String(id), channelId, text, attachments, isBot: bot,
    authorId: bot ? "bot" : "human", createdTimestamp,
  };
}

function fakeChannel(histories) {
  const transcriptReplies = [];
  const sends = [];
  const all = (channelId) => histories[channelId] || [];
  return {
    transcriptReplies,
    sends,
    async fetchMissed(channelId, afterId) {
      const messages = all(channelId).filter((item) => !afterId || BigInt(item.id) > BigInt(afterId));
      return { messages, newestId: all(channelId).at(-1)?.id || afterId || null };
    },
    async fetchMessage(channelId, messageId) {
      return all(channelId).find((item) => item.id === messageId) || null;
    },
    async replyTo(channelId, messageId, content) {
      transcriptReplies.push({ channelId, messageId, content });
    },
    async findMessageByNonce() {
      return false;
    },
    async send(channelId, content) {
      sends.push({ channelId, content });
    },
    async sendTyping() {},
  };
}

function state(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get: (key, fallback) => Object.hasOwn(data, key) ? data[key] : fallback,
    set: (key, value) => { data[key] = value; },
  };
}

const target = (msg) => ({
  agentName: msg.channelId === "100" ? "skybar" : "lsrc",
  pane: msg.channelId === "100" ? 3 : 5,
  dir: `/repo/${msg.channelId}`,
});

describe("Discord inbound reconciliation", () => {
  it("formats one batch-level recovery notice", () => {
    expect([formatRecoveredNotice(1), formatRecoveredNotice(2)]).toEqual([
      "ℹ Recovered 1 message missed during reconnect.",
      "ℹ Recovered 2 messages missed during reconnect.",
    ]);
  });

  it("persists identity and target before attachment download or handler work", async () => {
    const root = tempRoot();
    let releaseDownload;
    const downloadStarted = new Promise((resolve) => { releaseDownload = resolve; });
    const store = createDiscordInboundStore({
      rootDir: root,
      downloadBuffer: async () => {
        await downloadStarted;
        return Buffer.from("image");
      },
    });
    const onMessage = vi.fn(async () => ({ delivered: true }));
    const reconciler = createInboundReconciler({ onMessage, state: state(), store,
      resolveTarget: target });
    const channel = fakeChannel({});
    const incoming = message("101", "100", {
      text: "inspect",
      attachments: [{ id: "501", name: "proof.png", url: "cdn", contentType: "image/png" }],
    });

    const pending = reconciler.enqueue(incoming, channel);
    expect(store.read("100", "101")).toMatchObject({
      identity: "discord:100:101",
      text: "inspect",
      target: { agentName: "skybar", pane: 3 },
      status: "observed",
      attachments: [{ id: "501", name: "proof.png", durablePath: null }],
    });
    expect(onMessage).not.toHaveBeenCalled();
    releaseDownload();
    await pending;
    expect(store.read("100", "101")).toMatchObject({ status: "completed" });
  });

  it("keeps the cursor behind a message that could not be durably observed", async () => {
    const root = tempRoot();
    const store = createDiscordInboundStore({ rootDir: root,
      downloadBuffer: async () => Buffer.alloc(0) });
    store.advanceCursor("100", "100");
    const original = store.observe;
    store.observe = vi.fn((msg, resolved) => {
      if (msg.id === "102") throw new Error("disk-full");
      return original(msg, resolved);
    });
    const reconciler = createInboundReconciler({
      onMessage: async () => ({ delivered: true }), state: state(), store, resolveTarget: target,
    });
    const channel = fakeChannel({ "100": [message("101", "100"), message("102", "100")] });
    await expect(reconciler.reconcile(channel, "100")).rejects.toThrow("disk-full");
    expect(store.cursor("100")).toBe("100");
  });

  it("keeps the cursor behind attachment bytes that could not be made durable", async () => {
    const root = tempRoot();
    let releaseSlow;
    const slowDownload = new Promise((resolve) => { releaseSlow = resolve; });
    let failureSeen;
    const laterFailed = new Promise((resolve) => { failureSeen = resolve; });
    const store = createDiscordInboundStore({
      rootDir: root,
      downloadBuffer: async (url) => {
        if (url === "slow-cdn") {
          await slowDownload;
          return Buffer.from("durable-first");
        }
        failureSeen();
        throw new Error("cdn-offline");
      },
      sleep: async () => {},
    });
    store.advanceCursor("100", "100");
    const reconciler = createInboundReconciler({
      onMessage: async () => ({ delivered: true }), state: state(), store, resolveTarget: target,
    });
    const channel = fakeChannel({ "100": [
      message("102", "100", {
        attachments: [{ id: "502", name: "slow.png", url: "slow-cdn",
          contentType: "image/png" }],
      }),
      message("103", "100", {
        attachments: [{ id: "503", name: "proof.png", url: "bad-cdn",
          contentType: "image/png" }],
      }),
    ] });
    const failure = reconciler.reconcile(channel, "100").catch((error) => error);
    await laterFailed;
    expect(store.cursor("100")).toBe("100");
    releaseSlow();
    expect((await failure).message).toBe("cdn-offline");
    expect(store.read("100", "103")).toMatchObject({ status: "observed" });
  });

  it("observes a queued attachment failure only when its channel turn runs", async () => {
    const root = tempRoot();
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    let firstStarted;
    const firstEntered = new Promise((resolve) => { firstStarted = resolve; });
    const store = createDiscordInboundStore({
      rootDir: root,
      downloadBuffer: async () => { throw new Error("permanent-cdn-failure"); },
      sleep: async () => {},
    });
    const reconciler = createInboundReconciler({
      onMessage: async (msg) => {
        if (msg.id === "108") {
          firstStarted();
          await firstBlocked;
        }
        return { delivered: true };
      },
      state: state(), store, resolveTarget: target,
    });
    const channel = fakeChannel({});
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const first = reconciler.enqueue(message("108", "100"), channel);
      await firstEntered;
      const second = reconciler.enqueue(message("109", "100", {
        attachments: [{ id: "509", name: "proof.png", url: "bad-cdn",
          contentType: "image/png" }],
      }), channel);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      releaseFirst();
      await first;
      await expect(second).rejects.toThrow("permanent-cdn-failure");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the first resolved target when configuration changes during a retry", () => {
    const root = tempRoot();
    const store = createDiscordInboundStore({ rootDir: root,
      downloadBuffer: async () => Buffer.alloc(0) });
    store.observe(message("104", "100"), { agentName: "skybar", pane: 3, dir: "/first" });
    store.observe(message("104", "100", { text: "same Discord observation" }),
      { agentName: "other", pane: 9, dir: "/later" });
    expect(store.read("100", "104").target).toEqual({
      agentName: "skybar", pane: 3, dir: "/first",
    });
    expect(mergeInboundTarget(
      { name: "later", pane: 1, dir: "/live", channelId: "100" },
      store.read("100", "104").target,
    )).toEqual({ name: "skybar", pane: 3, dir: "/first", channelId: "100" });
    expect(mergeInboundTarget(null, store.read("100", "104").target)).toEqual({
      name: "skybar", pane: 3, dir: "/first",
    });
  });

  it("seeds a newly configured channel without replaying its prior history", async () => {
    const root = tempRoot();
    const store = createDiscordInboundStore({ rootDir: root,
      downloadBuffer: async () => Buffer.alloc(0) });
    const onMessage = vi.fn(async () => ({ delivered: true }));
    const reconciler = createInboundReconciler({ onMessage, state: state(), store,
      resolveTarget: target });
    const channel = fakeChannel({ "100": [message("105", "100"), message("106", "100")] });

    expect(await reconciler.reconcile(channel, "100")).toEqual({ replayed: 0, pending: 0 });
    expect(store.cursor("100")).toBe("106");
    expect(store.list("100")).toEqual([]);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drains a persisted target after its live channel mapping disappears", async () => {
    const root = tempRoot();
    const store = createDiscordInboundStore({ rootDir: root,
      downloadBuffer: async () => Buffer.alloc(0) });
    store.observe(message("107", "100", { text: "survive config removal" }), {
      agentName: "skybar", pane: 3, dir: null,
    });
    const accepted = [];
    const reconciler = createInboundReconciler({
      onMessage: async (msg) => { accepted.push(msg.resolvedTarget); return { delivered: true }; },
      state: state(),
      store,
      resolveTarget: () => null,
    });

    expect(store.channelIds()).toContain("100");
    expect(await reconciler.drain(fakeChannel({ "100": [] }), "100"))
      .toEqual({ replayed: 1, pending: 0 });
    expect(accepted).toEqual([{ agentName: "skybar", pane: 3, dir: null }]);
    expect(store.read("100", "107")).toMatchObject({ status: "completed" });
  });

  it("retries a transcript with the same Discord nonce after an accepted send loses its acknowledgement", async () => {
    const root = tempRoot();
    let clock = 1_000;
    const store = createDiscordInboundStore({
      rootDir: root,
      downloadBuffer: async (url) => Buffer.from(`bytes:${url}`),
      now: () => clock,
    });
    store.advanceCursor("200", "200");
    const voice = message("210", "200", {
      text: "",
      attachments: [{ id: "610", name: "voice.ogg", url: "voice-bytes",
        contentType: "audio/ogg" }],
    });
    const channel = fakeChannel({ "200": [voice] });
    const accepted = new Map();
    let replyAttempts = 0;
    channel.replyTo = async (_channelId, _messageId, payload) => {
      replyAttempts++;
      if (!accepted.has(payload.nonce)) accepted.set(payload.nonce, payload);
      if (replyAttempts === 1) throw new Error("connection reset after Discord accepted send");
      return accepted.get(payload.nonce);
    };
    channel.findMessageByNonce = async (_channelId, nonce) => accepted.has(nonce);
    const transcribe = vi.fn()
      .mockResolvedValueOnce({ stdout: "FIRST transcript", stderr: "" })
      .mockResolvedValueOnce({ stdout: "SECOND transcript", stderr: "" });
    const attachmentHandler = createAttachmentHandler({
      run: transcribe,
      transcribeScript: "/transcribe",
      downloadBuffer: async () => { throw new Error("durable cache was bypassed"); },
    });
    const prompts = [];
    const onMessage = async (msg) => {
      prompts.push(await attachmentHandler.buildPrompt(msg, []));
      return { delivered: true };
    };
    const reconciler = createInboundReconciler({ onMessage, state: state(), store,
      resolveTarget: target });

    await expect(reconciler.reconcile(channel, "200"))
      .rejects.toThrow("connection reset after Discord accepted send");
    expect(accepted).toHaveLength(1);
    expect(store.read("200", "210")).toMatchObject({
      status: "assets_ready",
      effects: { "transcript-reply": { status: "sending", attempts: 1 } },
      attachments: [{ id: "610", transcript: "FIRST transcript" }],
    });

    clock += 31_000;
    expect(await reconciler.reconcile(channel, "200")).toEqual({ replayed: 0, pending: 0 });
    expect(replyAttempts).toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("FIRST transcript");
    expect(prompts[0]).not.toContain("SECOND transcript");
    expect(store.read("200", "210")).toMatchObject({
      status: "completed",
      effects: { "transcript-reply": { status: "sent", attempts: 2 } },
    });
  });

  it("recovers text, image, and audio across channels once, then a second restart is a no-op", async () => {
    const root = tempRoot();
    const queueRoot = tempRoot();
    const histories = {
      "100": [
        message("110", "100", { text: "plain request", createdTimestamp: 1_000 }),
        message("111", "100", {
          text: "image request", createdTimestamp: 1_100,
          attachments: [{ id: "511", name: "frame.png", url: "image-bytes",
            contentType: "image/png" }],
        }),
      ],
      "200": [message("210", "200", {
        text: "", createdTimestamp: 1_200,
        attachments: [{ id: "610", name: "voice.ogg", url: "voice-bytes",
          contentType: "audio/ogg" }],
      })],
    };
    const channel = fakeChannel(histories);
    const queue = createDeliveryQueue({ rootDir: queueRoot, now: () => 2_000 });
    const echoed = new Set();
    const paneSends = [];
    const agent = {
      capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
      waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
      dismissBlockingPrompt: async () => null,
      capturePane: async () => "› ",
      sendEnter: async () => {},
      sendOnly: async (name, text, pane, options = {}) => {
        paneSends.push({ name, pane, text });
        await options.onPasteStarted?.();
        await options.onDrafted?.();
        await options.onSubmitting?.();
        await options.onSubmitted?.();
        echoed.add(text);
        return { submitted: true, queued: false };
      },
    };
    const broker = createDeliveryBroker({ agent, queue, now: () => 2_000,
      notify: async () => {} });
    const transcribe = vi.fn(async () => ({ stdout: "track the deployment", stderr: "" }));
    const attachmentHandler = createAttachmentHandler({
      run: transcribe,
      transcribeScript: "/transcribe",
      downloadBuffer: async () => { throw new Error("durable cache was bypassed"); },
    });
    const prompts = [];
    const onMessage = async (msg) => {
      const prompt = await attachmentHandler.buildPrompt(msg, []);
      const job = broker.enqueue({
        agentName: msg.resolvedTarget.agentName,
        pane: msg.resolvedTarget.pane,
        text: prompt,
        source: "discord",
        idempotencyKey: `discord:${msg.channelId}:${msg.id}`,
        createdAt: msg.createdTimestamp,
      });
      prompts.push({ identity: job.idempotencyKey, prompt });
      return { delivered: true, jobId: job.id };
    };
    const makeStore = () => createDiscordInboundStore({
      rootDir: root,
      downloadBuffer: async (url) => Buffer.from(`bytes:${url}`),
      now: () => 2_000,
    });

    const firstStore = makeStore();
    firstStore.advanceCursor("100", "100");
    firstStore.advanceCursor("200", "200");
    const first = createInboundReconciler({ onMessage, state: state(), store: firstStore,
      resolveTarget: target });
    expect(await first.reconcile(channel, "100")).toMatchObject({ replayed: 2, pending: 0 });
    expect(await first.reconcile(channel, "200")).toMatchObject({ replayed: 1, pending: 0 });
    expect(prompts).toHaveLength(3);
    expect(prompts[1].prompt).toMatch(/\[image attached: .*511\.png\]/u);
    expect(prompts[2].prompt).toContain("[transcribed voice");
    expect(channel.transcriptReplies).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(firstStore.cursor("100")).toBe("111");
    expect(firstStore.cursor("200")).toBe("210");
    await broker.kickTarget("skybar", 3);
    await broker.kickTarget("lsrc", 5);
    expect(queue.list("skybar", 3).map(({ status }) => status))
      .toEqual(["acknowledged", "acknowledged"]);
    expect(queue.list("lsrc", 5).map(({ status }) => status)).toEqual(["acknowledged"]);
    expect(paneSends).toHaveLength(3);

    // A fresh process sees the same REST history and the same journal. Stable
    // Discord identities suppress pane jobs, STT, and transcript replies.
    const secondStore = makeStore();
    const second = createInboundReconciler({ onMessage, state: state(), store: secondStore,
      resolveTarget: target });
    expect(await second.reconcile(channel, "100")).toMatchObject({ replayed: 0, pending: 0 });
    expect(await second.reconcile(channel, "200")).toMatchObject({ replayed: 0, pending: 0 });
    expect(prompts).toHaveLength(3);
    expect(channel.transcriptReplies).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(queue.list("skybar", 3)).toHaveLength(2);
    expect(queue.list("lsrc", 5)).toHaveLength(1);
    await broker.kickTarget("skybar", 3);
    await broker.kickTarget("lsrc", 5);
    expect(paneSends).toHaveLength(3);
  });
});
