// Progress timer for long-running agent turns: streams completed text
// segments to Discord + emits periodic "working (Ns)" heartbeats during
// silence. Used by /peek follow mode in handlers.

import { extractActivity, formatDuration } from "../lib.mjs";

const POLL_INTERVAL_MS = 3000;
const SILENT_THRESHOLD_S = 30;

/**
 * Create a progress timer that polls for new text segments and emits
 * streaming updates to a `send` function.
 *
 * Dependencies are injected so this module stays testable in isolation:
 *   send(text)              — async function to send a message
 *   getSegments()           — async function returning current text segments
 *   capturePane()           — async function returning raw pane text
 *
 * Returns { timer, sentCount: () => number }. Caller clears the timer when
 * the turn completes.
 */
export function startProgressTimer({ send, getSegments, capturePane }, { streaming = false } = {}) {
  const start = Date.now();
  let sentCount = 0;
  let lastNewAt = Date.now();
  let lastActivityMsg = "";

  const timer = setInterval(async () => {
    try {
      const segments = await getSegments();

      if (streaming && segments.length > 1 && sentCount < segments.length - 1) {
        while (sentCount < segments.length - 1) {
          send(segments[sentCount]).catch((err) =>
            console.warn(`progress: send segment failed: ${err.message}`));
          sentCount++;
        }
        lastNewAt = Date.now();
        return;
      }

      const silent = (Date.now() - lastNewAt) / 1000;
      if (silent >= SILENT_THRESHOLD_S) {
        const label = formatDuration(Math.floor((Date.now() - start) / 1000));
        const raw = await capturePane();
        const activity = raw ? extractActivity(raw) : null;
        const msg = activity ? `working (${label}) — ${activity}` : `working (${label})`;
        if (msg !== lastActivityMsg) {
          send(msg).catch((err) =>
            console.warn(`progress: send heartbeat failed: ${err.message}`));
          lastActivityMsg = msg;
          lastNewAt = Date.now();
        }
      }
    } catch (err) {
      console.warn(`progress: tick failed: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  return { timer, sentCount: () => sentCount };
}
