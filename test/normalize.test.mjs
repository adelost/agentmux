import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { normalizeDiscordMessage } from "../channels/normalize.mjs";

// --- Helpers ---

/**
 * Build a minimal discord.js Message-like object that normalize.mjs can
 * consume. Attachments is a Map-like structure (discord.js uses Collection
 * which extends Map); we fake it with a real Map so .values() works.
 */
function fakeDiscordMsg({
  id = "msg1",
  channelId = "ch1",
  content = "hello",
  authorId = "user1",
  isBot = false,
  attachments = [],
} = {}) {
  const replies = [];
  const sends = [];
  const typings = [];

  const attMap = new Map(attachments.map((a) => [a.id, a]));

  return {
    id,
    channelId,
    content,
    author: { id: authorId, bot: isBot },
    attachments: attMap,
    reply: vi.fn(async (text) => { replies.push(text); return { id: "r1" }; }),
    channel: {
      send: vi.fn(async (text) => { sends.push(text); return { id: "s1" }; }),
      sendTyping: vi.fn(async () => { typings.push(Date.now()); }),
    },
    _replies: replies,
    _sends: sends,
    _typings: typings,
  };
}

// --- Basic field mapping ---

feature("normalizeDiscordMessage: field mapping", () => {
  unit("copies id, channelId, text, authorId, isBot", {
    when: ["normalizing a plain message", () => normalizeDiscordMessage(fakeDiscordMsg({
      id: "m1",
      channelId: "ch42",
      content: "hej claw",
      authorId: "u99",
      isBot: false,
    }))],
    then: ["all top-level fields map through", (n) => {
      expect(n.id).toBe("m1");
      expect(n.channelId).toBe("ch42");
      expect(n.text).toBe("hej claw");
      expect(n.authorId).toBe("u99");
      expect(n.isBot).toBe(false);
    }],
  });

  unit("isBot reflects the author.bot flag", {
    when: ["normalizing a bot message", () => normalizeDiscordMessage(fakeDiscordMsg({ isBot: true }))],
    then: ["isBot is true", (n) => {
      expect(n.isBot).toBe(true);
    }],
  });

  unit("empty attachments map produces an empty array", {
    when: ["normalizing a message with no attachments",
      () => normalizeDiscordMessage(fakeDiscordMsg({ attachments: [] }))],
    then: ["[]", (n) => {
      expect(n.attachments).toEqual([]);
    }],
  });
});

// --- Attachment collection → array ---

feature("normalizeDiscordMessage: attachments", () => {
  unit("maps a single attachment to the channel-agnostic shape", {
    when: ["normalizing a message with a voice note", () => normalizeDiscordMessage(fakeDiscordMsg({
      attachments: [
        { id: "a1", name: "voice.ogg", url: "https://cdn/voice.ogg", contentType: "audio/ogg" },
      ],
    }))],
    then: ["one attachment with id/name/url/contentType", (n) => {
      expect(n.attachments).toHaveLength(1);
      expect(n.attachments[0]).toEqual({
        id: "a1",
        name: "voice.ogg",
        url: "https://cdn/voice.ogg",
        contentType: "audio/ogg",
      });
    }],
  });

  unit("preserves order across multiple attachments", {
    when: ["normalizing a message with an image and a voice note",
      () => normalizeDiscordMessage(fakeDiscordMsg({
        attachments: [
          { id: "a1", name: "photo.png", url: "u1", contentType: "image/png" },
          { id: "a2", name: "voice.ogg", url: "u2", contentType: "audio/ogg" },
        ],
      }))],
    then: ["image first, voice second", (n) => {
      expect(n.attachments.map((a) => a.id)).toEqual(["a1", "a2"]);
    }],
  });
});

// --- Behavior: reply / send / startTyping ---

feature("normalizeDiscordMessage: behavior wrappers", () => {
  unit("reply() delegates to the underlying Discord message", {
    given: ["a normalized message", () => {
      const raw = fakeDiscordMsg();
      return { raw, normalized: normalizeDiscordMessage(raw) };
    }],
    when: ["calling reply", async ({ normalized }) => normalized.reply("pong")],
    then: ["underlying msg.reply gets the text", (_, { raw }) => {
      expect(raw.reply).toHaveBeenCalledWith("pong");
    }],
  });

  unit("send() delegates to msg.channel.send", {
    given: ["a normalized message", () => {
      const raw = fakeDiscordMsg();
      return { raw, normalized: normalizeDiscordMessage(raw) };
    }],
    when: ["calling send", async ({ normalized }) => normalized.send("chunk one")],
    then: ["underlying channel.send gets the text", (_, { raw }) => {
      expect(raw.channel.send).toHaveBeenCalledWith("chunk one");
    }],
  });

  unit("startTyping() returns a stop function that clears the interval", {
    given: ["a normalized message", () => {
      vi.useFakeTimers();
      const raw = fakeDiscordMsg();
      return { raw, normalized: normalizeDiscordMessage(raw) };
    }],
    when: ["starting typing then stopping after 30s",
      async ({ normalized }) => {
        const stop = normalized.startTyping();
        // Initial immediate call + interval ticks every 8s
        vi.advanceTimersByTime(24_000);
        stop();
        // After stop, no more ticks
        vi.advanceTimersByTime(24_000);
        return stop;
      }],
    then: ["sendTyping called 4 times (1 initial + 3 ticks), then stopped",
      (_, { raw }) => {
        // 1 initial + floor(24000/8000)=3 ticks = 4 calls before stop
        expect(raw.channel.sendTyping).toHaveBeenCalledTimes(4);
        vi.useRealTimers();
      }],
  });
});
