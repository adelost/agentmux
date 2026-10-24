import { createHash } from "node:crypto";

/** WHAT: Builds the durable identity of one human notice. WHY: Keeps changing copy from bypassing an explicit delivery identity. */
export function notifyKey(content, userId, channelName, idempotencyKey = null) {
  const identity = idempotencyKey == null ? content : `idempotency:${idempotencyKey}`;
  return createHash("sha256").update(`${userId || ""}\0${channelName || ""}\0${identity}`).digest("hex");
}

/** WHAT: Builds a validated Discord nonce. WHY: Keeps transport retries bound to the same notice identity. */
export function notificationNonce(idempotencyKey) {
  if (idempotencyKey == null) return null;
  if (typeof idempotencyKey !== "string" || Buffer.byteLength(idempotencyKey, "utf8") > 256
      || !/^[a-zA-Z0-9:._/-]+$/u.test(idempotencyKey)) throw new Error("idempotencyKey must be 1-256 safe identity characters");
  return createHash("sha256").update(`notifyuser\0${idempotencyKey}`).digest("hex").slice(0, 25);
}
