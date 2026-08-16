import { createHash } from "crypto";

/** WHAT: Builds one stable Discord nonce for a transcript chunk. WHY: Prevents an accepted reply from duplicating when its transport acknowledgement is lost. */
export function transcriptNonce(identity, index) {
  const hex = createHash("sha256").update(`${identity}:transcript:${index}`).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`).toString(10);
}

/** WHAT: Wraps transcript text in an idempotent Discord message request. WHY: Keeps crash retries safe across the send/receipt boundary. */
export function transcriptPayload(identity, index, content) {
  return {
    content,
    nonce: transcriptNonce(identity, index),
    enforceNonce: true,
  };
}
