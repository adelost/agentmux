import { describe, expect, it, vi } from "vitest";
import { collectDiscordHistory, findDiscordNonce } from "./discord-history.mjs";

const item = (id, { bot = false, createdTimestamp = Number(id) } = {}) => ({
  id: String(id), createdTimestamp, author: { bot },
});

describe("Discord outage history", () => {
  it("paginates back to the durable cursor and returns human input in source order", async () => {
    const pages = new Map([
      ["latest", [item(109), item(108, { bot: true }), item(107)]],
      ["107", [item(106), item(105), item(104)]],
      ["104", [item(103), item(102), item(100)]],
    ]);
    const fetchPage = vi.fn(async ({ before = "latest" }) =>
      new Map(pages.get(before).map((message) => [message.id, message])));

    const result = await collectDiscordHistory({ fetchPage, afterId: "100", limit: 3 });

    expect(result.messages.map(({ id }) => id)).toEqual(["102", "103", "104", "105", "106", "107", "109"]);
    expect(result.newestId).toBe("109");
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("bounds an initial migration scan by lookback without using bot messages as input", async () => {
    const fetchPage = vi.fn(async () => new Map([
      ["30", item(30, { bot: true, createdTimestamp: 30_000 })],
      ["20", item(20, { createdTimestamp: 20_000 })],
      ["10", item(10, { createdTimestamp: 1_000 })],
    ]));

    const result = await collectDiscordHistory({
      fetchPage, limit: 100, maxAgeMs: 15_000, now: () => 30_000,
    });

    expect(result.messages.map(({ id }) => id)).toEqual(["20"]);
    expect(result.newestId).toBe("30");
  });

  it("reconciles a transcript nonce across pages after its source message", async () => {
    const pages = new Map([
      ["latest", [item(330), item(320)]],
      ["320", [
        { ...item(310), nonce: "stable-nonce", author: { id: "bridge", bot: true } },
        item(300),
      ]],
    ]);
    const fetchPage = vi.fn(async ({ before = "latest" }) =>
      new Map(pages.get(before).map((message) => [message.id, message])));

    await expect(findDiscordNonce({
      fetchPage, nonce: "stable-nonce", afterId: "300", botUserId: "bridge", limit: 2,
    })).resolves.toBe(true);
    await expect(findDiscordNonce({
      fetchPage, nonce: "other", afterId: "300", botUserId: "bridge", limit: 2,
    })).resolves.toBe(false);
  });
});
