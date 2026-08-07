// Pre-seeds Kimi Code's workspace-trust store so a fleet pane restart never
// meets the "Trust this folder?" startup modal.
//
// WHY THIS EXISTS (root cause, measured 2026-08-07): kimi-code persists the
// choice correctly — this is NOT an upstream data-loss bug. The store is
// `$KIMI_CODE_HOME/workspace-trust/<workdir-key>` and five live pane approvals
// were verified on disk with matching mtimes. The modal re-blocked restarts
// because approvals were given per-pane by hand, so every NEW or resumed pane
// directory that lacked a doc blocked on startup, and the cache-hint dialog
// then blocked the first delivery. Pre-seeding the pane's own launch
// directory is the declarative fix: the product remembers; we write the
// memory before launch instead of answering the prompt afterwards.
//
// FORMAT NOTE: the store layout is not covered by kimi-code's public docs.
// The key derivation and document shape below are mirrored field-for-field
// from the 0.34.0 binary (agent-core/src/session/store/workdir-key.ts,
// agent-core/src/utils/workdir-slug.ts, agent-core-v2 workspaceTrustService)
// and golden-tested against the five live filenames on this host. If a future
// kimi-code changes the format, the modal simply returns — and the dialect
// modal recognition plus the delivery-path answerer keep it visible and
// answered instead of silent. Fail here must never block a launch.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";

const WORKDIR_KEY_PREFIX = "wd_";
const WORKDIR_KEY_HASH_LENGTH = 12;
const MAX_WORKDIR_SLUG_LENGTH = 40;

/** WHAT: Mirrors kimi-code's slugifyWorkDirName exactly. WHY: The trust doc filename must equal the one the TUI computes. */
export function slugifyKimiWorkDirName(name) {
  const slug = String(name)
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug === "." || slug === ".." ? "workspace" : slug;
}

/** WHAT: Mirrors kimi-code's normalizeWorkDir. WHY: Trust identity is keyed on the normalized absolute path. */
export function normalizeKimiWorkDir(workDir) {
  const value = String(workDir);
  if (/^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/u.test(value)) {
    return win32.resolve(value).replaceAll("\\", "/");
  }
  return resolve(value);
}

/** WHAT: The exact workspace key kimi-code derives (`wd_<slug>_<sha256[:12]>`). */
export function kimiWorkDirKey(workDir) {
  const normalized = normalizeKimiWorkDir(workDir);
  const slug = slugifyKimiWorkDirName(basename(normalized));
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, WORKDIR_KEY_HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

export function kimiTrustDocPath(kimiHome, workDir) {
  return join(kimiHome, "workspace-trust", kimiWorkDirKey(workDir));
}

/**
 * WHAT: Ensures kimi-code's trust doc for `workDir` exists under `kimiHome`.
 * WHY: A pane launched into an already-trusted directory never sees the
 * startup modal. Idempotent: an existing valid doc for the same root is left
 * untouched (trustedAt preserved). A corrupt or wrong-root doc is rewritten —
 * kimi's own writer uses the same last-writer-wins JSON shape. Never throws:
 * a pre-seed failure reports { status: "error" } and the launch proceeds;
 * the modal answerer in the runtime is the backstop.
 */
export function ensureKimiWorkspaceTrusted({ kimiHome, workDir, now = Date.now() } = {}) {
  try {
    if (!kimiHome || !workDir) throw new Error("kimiHome and workDir are required");
    // kimi reads process.cwd(), which is always the PHYSICAL path; realpath
    // the pane dir so a symlinked config path still lands on the same key.
    let physical = workDir;
    try { physical = realpathSync(workDir); } catch {}
    const root = normalizeKimiWorkDir(physical);
    const docPath = kimiTrustDocPath(kimiHome, root);
    try {
      const existing = JSON.parse(readFileSync(docPath, "utf-8"));
      if (existing && existing.root === root && Number.isFinite(existing.trustedAt)) {
        return { status: "present", path: docPath, key: kimiWorkDirKey(root) };
      }
    } catch {}
    const storeDir = join(kimiHome, "workspace-trust");
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    try { chmodSync(storeDir, 0o700); } catch {}
    const temporary = `${docPath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ root, trustedAt: now }), { mode: 0o600 });
    renameSync(temporary, docPath);
    return { status: "seeded", path: docPath, key: kimiWorkDirKey(root) };
  } catch (error) {
    return { status: "error", error: String(error?.message || error) };
  }
}

/** WHAT: The kimi home a launch will actually use (profile override beats env beats default). */
export function effectiveKimiHome({ profileHome = null, env = process.env } = {}) {
  return profileHome || env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}
