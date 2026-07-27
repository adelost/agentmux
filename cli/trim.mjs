// Manual storage housekeeping. Deletion and semantic checkpoint trim remain
// distinct so an operator can see exactly which guarantee authorizes each byte.

import { formatJanitorResult, trimAgedSessions, defaultSessionRoots } from "../core/janitor.mjs";
import { formatTrimResult, trimOversizedSessions } from "../core/session-trim.mjs";

/** WHAT: Dispatches aged field trim from the CLI. WHY: Keeps archival memory searchable without touching recent journals. */
export function cmdJanitor(flags = {}) {
  const result = trimAgedSessions({
    dryRun: Boolean(flags.dry),
    ...(flags.days ? { retentionDays: flags.days } : {}),
  });
  console.log(formatJanitorResult(result));
  for (const error of result.errors) console.warn(`  ! ${error}`);
  return result;
}

/** WHAT: Dispatches checkpoint-safe physical trim from the CLI. WHY: Keeps manual reclaim from bypassing provider safety fences. */
export function cmdTrim(flags = {}, { env = process.env } = {}) {
  const result = trimOversizedSessions({
    roots: defaultSessionRoots(env.HOME),
    dryRun: Boolean(flags.dry),
    ...(flags["min-stable-minutes"] != null
      ? { minStableMs: flags["min-stable-minutes"] * 60_000 }
      : {}),
    ...(flags["max-files"] != null ? { maxFiles: flags["max-files"] } : {}),
  });
  console.log(formatTrimResult(result));
  for (const item of result.files.filter((entry) => entry.status === "protected")) {
    console.log(`  keep ${item.provider || "unknown"}: ${item.reason} · ${item.path}`);
  }
  return result;
}
