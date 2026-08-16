/** WHAT: Returns whether an attachment download can succeed on another CDN attempt. WHY: Keeps retry policy identical for durable staging and legacy direct handling. */
export function retryableDiscordDownload(error) {
  return error?.retryable === true
    || /(?:Download failed:\s*(?:408|429|5\d\d)|fetch failed|ECONN|ETIMEDOUT|timeout)/iu
      .test(String(error?.message || error));
}

/**
 * WHAT: Fetches one Discord attachment through bounded CDN/proxy retries.
 * WHY: Keeps transient signed-URL failures from discarding user evidence.
 */
export async function downloadDiscordAttachment(att, {
  downloadBuffer,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const urls = [...new Set([att?.url, att?.proxyUrl].filter(Boolean))];
  let lastError = new Error("attachment has no download URL");
  const permanentlyFailed = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidates = urls.filter((url) => !permanentlyFailed.has(url));
    if (!candidates.length) break;
    const url = candidates[attempt % candidates.length];
    try { return await downloadBuffer(url); }
    catch (error) {
      lastError = error;
      if (!retryableDiscordDownload(error)) permanentlyFailed.add(url);
      if (attempt < 2 && urls.some((candidate) => !permanentlyFailed.has(candidate))) {
        await sleep(attempt === 0 ? 200 : 600);
      }
    }
  }
  throw lastError;
}
