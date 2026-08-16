import { createHash } from "crypto";

/** WHAT: Builds one stable Discord nonce for an attachment transcript chunk. WHY: Prevents accepted replies from duplicating or colliding across multiple audio files. */
export function transcriptNonce(identity, attachmentId, index) {
  const hex = createHash("sha256")
    .update(`${identity}:transcript:${attachmentId}:${index}`).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`).toString(10);
}

/** WHAT: Builds the pre-attachment transcript nonce. WHY: Prevents an in-flight earlier journal from duplicating its accepted first reply. */
export function legacyTranscriptNonce(identity, index) {
  const hex = createHash("sha256").update(`${identity}:transcript:${index}`).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`).toString(10);
}

/** WHAT: Wraps transcript text in an idempotent Discord message request. WHY: Keeps crash retries safe across the send/receipt boundary. */
export function transcriptPayload(identity, attachmentId, index, content) {
  return {
    content,
    nonce: transcriptNonce(identity, attachmentId, index),
    enforceNonce: true,
  };
}

/** WHAT: Wraps one legacy first-attachment retry with its original nonce. WHY: Prevents an upgrade retry from changing transport identity after Discord accepted a send. */
export function legacyTranscriptPayload(identity, index, content) {
  return { content, nonce: legacyTranscriptNonce(identity, index), enforceNonce: true };
}
