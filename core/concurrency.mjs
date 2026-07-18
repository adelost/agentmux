/** WHAT: Maps items through a bounded async worker pool.
 *  WHY: Prevents fleet startup from saturating the host with simultaneous TUI resumes. */
export async function mapWithConcurrency(items, limit, mapper) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("concurrency limit must be a positive integer");
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
