import { performance } from 'node:perf_hooks';
import {
  OFFICIAL_ORIGIN, MAX_RESPONSE_BYTES, JevError, buildRequest, parseResponse, shadowReport, validateInput,
} from './contract.mjs';

async function readJson(response, signal) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(contentType)) {
    void response.body?.cancel().catch(() => {});
    throw new JevError('INVALID_RESPONSE', 'Jev did not return JSON.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new JevError('INVALID_RESPONSE', 'Jev returned an empty body.');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new JevError('ABORTED', 'Jev request was stopped.');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new JevError('RESPONSE_TOO_LARGE', 'Jev response exceeded 65536 bytes.');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new JevError('INVALID_RESPONSE', 'Jev returned invalid JSON.'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** WHAT: Creates an opt-in, bounded observer. WHY: No retries, alternate origins or production routing side effects. */
export function createJevObserver({
  enabled = false, allowDataTransfer = false, origin, apiKey,
  maxCalls = 1, timeoutMs = 5_000, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof enabled !== 'boolean' || typeof allowDataTransfer !== 'boolean') {
    throw new JevError('INVALID_CONFIG', 'Enablement and data consent must be explicit booleans.');
  }
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 5
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new JevError('INVALID_CONFIG', 'Use 1..5 calls per observer and a 1..30000 ms timeout.');
  }
  if (enabled) {
    if (allowDataTransfer !== true) throw new JevError('CONSENT_REQUIRED', 'Explicit remote-data consent is required.');
    if (origin !== OFFICIAL_ORIGIN) throw new JevError('ORIGIN_REQUIRED', 'Set the explicit origin to https://api.typesafe.ai.');
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(apiKey)) {
      throw new JevError('KEY_REQUIRED', 'Provide TYPESAFE_API_KEY locally.');
    }
    if (typeof fetchImpl !== 'function') throw new JevError('INVALID_CONFIG', 'A fetch implementation is required.');
  }
  let attempts = 0;
  return {
    stats: () => ({ attempts, remaining: maxCalls - attempts }),
    async observe(input, { signal } = {}) {
      if (!enabled) return { mode: 'disabled', action: 'NO_DISPATCH', attempts: 0 };
      const snapshot = structuredClone(validateInput(input));
      const request = buildRequest(snapshot);
      if (signal != null && !(signal instanceof AbortSignal)) {
        throw new JevError('INVALID_CONFIG', 'Cancellation must use an AbortSignal.');
      }
      if (signal?.aborted) throw new JevError('ABORTED', 'Jev request was stopped before submission.');
      if (attempts >= maxCalls) throw new JevError('CALL_LIMIT', 'Observer call limit reached; no retry was submitted.');
      // Reserve synchronously, before any await. Errors/timeouts still spend this attempt.
      attempts += 1;
      const started = performance.now(), controller = new AbortController();
      let timer, onAbort;
      const stopped = new Promise((_, reject) => {
        const stop = (code, message) => { reject(new JevError(code, message)); controller.abort(); };
        timer = setTimeout(() => stop('TIMEOUT', 'Jev deadline exceeded; outcome may still be billed. No retry.'), timeoutMs);
        onAbort = () => stop('ABORTED', 'Jev request was stopped; outcome may still be billed. No retry.');
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const work = async () => {
        const response = await fetchImpl(`${origin}/v1/systemone`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          const status = Number.isInteger(response.status) ? response.status : 0;
          throw new JevError('HTTP_ERROR', `Jev HTTP ${status}; response body withheld. No retry.`);
        }
        return parseResponse(await readJson(response, controller.signal), request);
      };
      try {
        const observation = await Promise.race([work(), stopped]);
        return shadowReport(snapshot, request, observation, {
          transport: 'live', durationMs: Math.round(performance.now() - started), attempts,
        });
      } catch (error) {
        if (error instanceof JevError) throw error;
        // Fetch errors can embed request headers, text or URL details. Never echo them.
        throw new JevError('NETWORK_ERROR', 'Jev transport failed; details withheld. Outcome may be unknown. No retry.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controller.abort();
      }
    },
  };
}
