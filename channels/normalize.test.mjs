import { unit, feature, expect } from "bdd-vitest";
import { vi } from "vitest";
import { normalizeDiscordMessage } from "./normalize.mjs";

function fakeDiscordMsg(overrides = {}) {
  return {
    channelId: "ch-123",
    content: "fix the bug",
    author: { id: "user-456", bot: false },
    id: "msg-789",
    attachments: new Map(),
    channel: {
      send: vi.fn(() => Promise.resolve()),
      sendTyping: vi.fn(() => Promise.resolve()),
    },
    reply: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

feature("normalizeDiscordMessage", () => {
  unit("extracts text and metadata", {
    given: ["a Discord message", () => fakeDiscordMsg()],
    when: ["normalizing", (msg) => normalizeDiscordMessage(msg)],
    then: ["has channelId, text, authorId, isBot, id", (m) => {
      expect(m.channelId).toBe("ch-123");
      expect(m.text).toBe("fix the bug");
      expect(m.authorId).toBe("user-456");
      expect(m.isBot).toBe(false);
      expect(m.id).toBe("msg-789");
    }],
  });

  unit("marks bot messages", {
    given: ["a bot message", () => fakeDiscordMsg({ author: { id: "bot-1", bot: true } })],
    when: ["normalizing", (msg) => normalizeDiscordMessage(msg)],
    then: ["isBot is true", (m) => expect(m.isBot).toBe(true)],
  });

  unit("flattens attachments from Map to array", {
    given: ["a message with two attachments", () => fakeDiscordMsg({
      attachments: new Map([
        ["a1", { id: "a1", name: "photo.jpg", url: "http://cdn/photo.jpg", contentType: "image/jpeg" }],
        ["a2", { id: "a2", name: "log.txt", url: "http://cdn/log.txt", contentType: "text/plain" }],
      ]),
    })],
    when: ["normalizing", (msg) => normalizeDiscordMessage(msg)],
    then: ["attachments is a plain array with correct fields", (m) => {
      expect(m.attachments).toEqual([
        { id: "a1", name: "photo.jpg", url: "http://cdn/photo.jpg", contentType: "image/jpeg" },
        { id: "a2", name: "log.txt", url: "http://cdn/log.txt", contentType: "text/plain" },
      ]);
    }],
  });

  unit("empty attachments yields empty array", {
    given: ["a message with no attachments", () => fakeDiscordMsg()],
    when: ["normalizing", (msg) => normalizeDiscordMessage(msg)],
    then: ["attachments is empty array", (m) => expect(m.attachments).toEqual([])],
  });

  unit("reply delegates to Discord msg.reply", {
    given: ["a Discord message", () => fakeDiscordMsg()],
    when: ["calling reply on normalized message", async (msg) => {
      const norm = normalizeDiscordMessage(msg);
      await norm.reply("hello");
      return msg;
    }],
    then: ["original msg.reply was called", (msg) => {
      expect(msg.reply).toHaveBeenCalledWith("hello");
    }],
  });

  unit("send delegates to Discord channel.send", {
    given: ["a Discord message", () => fakeDiscordMsg()],
    when: ["calling send on normalized message", async (msg) => {
      const norm = normalizeDiscordMessage(msg);
      await norm.send("progress update");
      return msg;
    }],
    then: ["original channel.send was called", (msg) => {
      expect(msg.channel.send).toHaveBeenCalledWith("progress update");
    }],
  });

  unit("send passes objects through (for files)", {
    given: ["a Discord message", () => fakeDiscordMsg()],
    when: ["calling send with file object", async (msg) => {
      const norm = normalizeDiscordMessage(msg);
      await norm.send({ files: ["/tmp/audio.mp3"] });
      return msg;
    }],
    then: ["channel.send receives the object", (msg) => {
      expect(msg.channel.send).toHaveBeenCalledWith({ files: ["/tmp/audio.mp3"] });
    }],
  });

  unit("startTyping returns a stop function", {
    given: ["a Discord message", () => fakeDiscordMsg()],
    when: ["starting typing", (msg) => normalizeDiscordMessage(msg).startTyping()],
    then: ["returns a function", (stop) => {
      expect(typeof stop).toBe("function");
      stop();
    }],
  });

  unit("startTyping calls sendTyping immediately", {
    given: ["a Discord message", () => fakeDiscordMsg()],
    when: ["starting typing", (msg) => {
      normalizeDiscordMessage(msg).startTyping();
      return msg;
    }],
    then: ["sendTyping was called", (msg) => {
      expect(msg.channel.sendTyping).toHaveBeenCalled();
    }],
  });

  unit("onSent fires after reply, with channelId", {
    given: ["message + onSent spy", () => ({
      msg: fakeDiscordMsg(),
      onSent: vi.fn(),
    })],
    when: ["replying via normalized msg", async ({ msg, onSent }) => {
      const norm = normalizeDiscordMessage(msg, { onSent });
      await norm.reply("hi");
      return { msg, onSent };
    }],
    then: ["onSent called with the channelId", ({ onSent }) => {
      expect(onSent).toHaveBeenCalledWith("ch-123");
      expect(onSent).toHaveBeenCalledTimes(1);
    }],
  });

  unit("onSent fires after send, with channelId", {
    given: ["message + onSent spy", () => ({
      msg: fakeDiscordMsg(),
      onSent: vi.fn(),
    })],
    when: ["sending via normalized msg", async ({ msg, onSent }) => {
      await normalizeDiscordMessage(msg, { onSent }).send("progress");
      return onSent;
    }],
    then: ["onSent called with the channelId", (onSent) => {
      expect(onSent).toHaveBeenCalledWith("ch-123");
    }],
  });

  unit("onSent failure doesn't break delivery", {
    given: ["message + onSent that throws", () => ({
      msg: fakeDiscordMsg(),
      onSent: vi.fn(() => { throw new Error("boom"); }),
    })],
    when: ["replying", async ({ msg, onSent }) => {
      const norm = normalizeDiscordMessage(msg, { onSent });
      await norm.reply("still goes through");
      return msg;
    }],
    then: ["original msg.reply still called, no throw propagates", (msg) => {
      expect(msg.reply).toHaveBeenCalledWith("still goes through");
    }],
  });
});
