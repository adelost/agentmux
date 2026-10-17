import { describe, it, expect, vi } from "vitest";
import { createDiscordChannel } from "./discord.mjs";
describe("temporary Discord row cleanup", () => {
  it("deletes a bot-owned row and refuses another author's message", async () => {
    const remove = vi.fn(async () => {}); let owner = "bot";
    const client = { user: { id: "bot" }, channels: { fetch: async () => ({ messages: { fetch: async () => ({ author: { id: owner }, delete: remove }) } }) } };
    const channel = createDiscordChannel({ token: "unused", client });
    await channel.deleteMessage("channel", "own-row"); owner = "human";
    await expect(channel.deleteMessage("channel", "human-row")).rejects.toThrow("another author");
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
