// Discord REST history pagination for reconnect recovery.

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;

function compareId(left, right) {
  const a = BigInt(String(left));
  const b = BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * WHAT: Collects every human Discord message after one durable snowflake cursor.
 * WHY: Gateway reconnects do not replay outage history and one REST page can hide older missed input.
 */
export async function collectDiscordHistory({
  fetchPage,
  afterId = null,
  limit = 100,
  maxAgeMs = DEFAULT_LOOKBACK_MS,
  now = () => Date.now(),
}) {
  const collected = new Map();
  const cutoff = now() - maxAgeMs;
  let before = null;
  let newestId = afterId || null;

  while (true) {
    const batch = await fetchPage(before ? { before, limit } : { limit });
    const page = [...batch.values()].sort((a, b) => compareId(b.id, a.id));
    if (!page.length) break;
    if (!newestId || compareId(page[0].id, newestId) > 0) newestId = page[0].id;

    let reachedBoundary = false;
    for (const message of page) {
      const afterCursor = afterId
        ? compareId(message.id, afterId) > 0
        : Number(message.createdTimestamp) >= cutoff;
      if (!afterCursor) {
        reachedBoundary = true;
        continue;
      }
      if (!message.author?.bot) collected.set(message.id, message);
    }

    const oldest = page[page.length - 1];
    if (reachedBoundary || page.length < limit || oldest.id === before) break;
    before = oldest.id;
  }

  return {
    messages: [...collected.values()].sort((a, b) => compareId(a.id, b.id)),
    newestId,
  };
}

/** WHAT: Returns whether one bot-authored Discord nonce follows its source message. WHY: Prevents a crashed transcript send from duplicating during receipt recovery. */
export async function findDiscordNonce({
  fetchPage,
  nonce,
  afterId,
  botUserId,
  limit = 100,
}) {
  let before = null;
  while (true) {
    const batch = await fetchPage(before ? { before, limit } : { limit });
    const page = [...batch.values()].sort((a, b) => compareId(b.id, a.id));
    if (!page.length) return false;
    let reachedBoundary = false;
    for (const message of page) {
      if (compareId(message.id, afterId) <= 0) {
        reachedBoundary = true;
        continue;
      }
      if (String(message.nonce ?? "") === String(nonce)
          && (!botUserId || String(message.author?.id) === String(botUserId))) return true;
    }
    const oldest = page[page.length - 1];
    if (reachedBoundary || page.length < limit || oldest.id === before) return false;
    before = oldest.id;
  }
}
