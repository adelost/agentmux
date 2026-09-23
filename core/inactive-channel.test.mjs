import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";
import { createInboundReconciler } from "./inbound-reconciler.mjs";
import { inactiveChannelBindings } from "./inactive-channel.mjs";
import { buildMigrationPlan, parseConfig } from "../sync.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-inactive-channel-"));
  roots.push(rootDir);
  const store = createDiscordInboundStore({ rootDir });
  const replies = [];
  const channel = {
    replyTo: async (channelId, messageId, payload) => {
      replies.push({ channelId, messageId, payload });
    },
    findMessageByNonce: async () => false,
  };
  const onMessage = vi.fn(async () => ({ delivered: true }));
  const target = {
    agentName: "claw", pane: 10, kind: "inactive",
    redirectId: "1495818918592249896", channelName: "claw-10-codex",
  };
  const create = () => createInboundReconciler({
    store, channel, onMessage, state: null, resolveTarget: () => target,
  });
  const message = {
    id: "1552352725172232286", channelId: "1502949108418216006",
    text: "/compact", authorId: "human", isBot: false,
    createdTimestamp: Date.now(), attachments: [],
  };
  return { store, replies, channel, onMessage, create, message };
}

it("answers a retired pane in its own channel without running another agent", async () => {
  const { store, replies, channel, onMessage, create, message } = setup();

  await create().enqueue(message, channel);
  await create().enqueue(message, channel);

  expect(onMessage).not.toHaveBeenCalled();
  expect(replies).toHaveLength(1);
  expect(replies[0].messageId).toBe(message.id);
  expect(replies[0].payload.content).toContain("<#1495818918592249896>");
  expect(store.read(message.channelId, message.id)).toMatchObject({ status: "completed" });
});

it("recovers a retired-channel reply after a bridge restart", async () => {
  const { store, replies, channel, onMessage, create, message } = setup();
  store.advanceCursor(message.channelId, "1552352725172232285");
  channel.fetchMissed = async () => ({ messages: [message], newestId: message.id });
  channel.fetchMessage = async () => message;

  await create().reconcile(channel, message.channelId);
  await create().reconcile(channel, message.channelId);

  expect(onMessage).not.toHaveBeenCalled();
  expect(replies).toHaveLength(1);
  expect(store.cursor(message.channelId)).toBe(message.id);
});

it("does not repeat a reply accepted just before its acknowledgement was lost", async () => {
  const { store, replies, channel, create, message } = setup();
  channel.replyTo = async (channelId, messageId, payload) => {
    replies.push({ channelId, messageId, payload });
    throw new Error("reply acknowledgement lost");
  };

  await expect(create().enqueue(message, channel)).rejects.toThrow("reply acknowledgement lost");
  channel.findMessageByNonce = async () => true;
  await create().enqueue(message, channel);

  expect(replies).toHaveLength(1);
  expect(store.read(message.channelId, message.id)).toMatchObject({ status: "completed" });
});

it("identifies the former agent that owns an extra channel", () => {
  const { agents } = parseConfig(`agents:\n  claw:\n    dir: /tmp/claw\n    claude: 3\n    codex: 4\n    kimi: 1\n    qwen: 1\n`);
  const plan = buildMigrationPlan(agents, [
    { name: "claw-10-codex", id: "old-10", lastMessageId: "1552352725172232286" },
    { name: "claw-11-codex", id: "old-11" },
    { name: "general", id: "unrelated" },
  ]);

  expect(plan.extras.map(({ agentName, pane }) => [agentName, pane]))
    .toEqual([["claw", 10], ["claw", 11]]);
  const bindings = inactiveChannelBindings(plan.extras, agents,
    new Map([["claw-3-codex", "1495818918592249896"]]));
  expect(bindings["old-10"]).toMatchObject({
    agentName: "claw", pane: 10, redirectId: "1495818918592249896",
    afterId: "1552352725172232286",
  });
  expect(bindings["old-11"]).toMatchObject({
    agentName: "claw", pane: 11, redirectId: "1495818918592249896",
  });
  expect(bindings.unrelated).toBeUndefined();
});
