// WHAT: Places a small launcher before each downloaded Chrome build that drops Playwright's shared-memory flag.
// WHY: That flag writes Chrome's shared memory to the SSD; one video test wrote 66 GB in 12 minutes.

import { closeSync, existsSync, linkSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SYSTEM_CHROME = "/opt/google/chrome/chrome";

// Playwright adds --disable-dev-shm-usage to every Chromium launch for Docker's 64 MB /dev/shm.
// Here /dev/shm holds 27 GB; with the flag Chrome keeps that memory in /tmp files, which the
// kernel writes to the SSD every 30 s. A/B on 2026-10-28, 4K video for 30 s: 508 MB written, 0 MB without it.
/** WHAT: Defines the launcher script placed before each Chrome build. WHY: Keeps Chrome's shared memory in RAM, away from SSD-backed /tmp files. */
export const CHROME_LAUNCHER = `#!/bin/bash
# agentmux keeps Chrome's shared memory in /dev/shm (RAM). The real binary is beside this file as <name>.real.
# Playwright adds --disable-dev-shm-usage to every launch; that flag moves the memory to files in /tmp,
# which the kernel writes to the SSD (2026-10-28: one Chrome playing video wrote 66 GB in 12 minutes).
args=()
for arg in "$@"; do [ "$arg" = --disable-dev-shm-usage ] || args+=("$arg"); done
exec -a "$0" "$(readlink -f "\${BASH_SOURCE[0]}").real" "\${args[@]}"
`;

// Each layout lists the folder patterns from the cache root down to the folder holding the executable.
const BUILD_LAYOUTS = [
  { root: ".cache/ms-playwright", folders: [/^chromium(?:_headless_shell)?-\d+$/u, /^chrome-/u] },
  { root: ".cache/puppeteer", folders: [/^chrome(?:-headless-shell)?$/u, /^linux-/u, /^chrome-/u] },
];
const BUILD_NAMES = ["chrome", "chrome-headless-shell"];

/** WHAT: Collects the Chrome executables Playwright and Puppeteer downloaded. WHY: Keeps new versions, which arrive without the launcher, in view. */
export function downloadedChromeBuilds({ home = homedir(), layouts = BUILD_LAYOUTS } = {}) {
  const builds = [];
  for (const { root, folders } of layouts) {
    let level = [join(home, root)].filter(existsSync);
    for (const pattern of folders) {
      level = level.flatMap((parent) => readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map(({ name }) => join(parent, name)));
    }
    for (const folder of level) builds.push(...BUILD_NAMES.map((name) => join(folder, name)).filter(existsSync));
  }
  return builds;
}

/** WHAT: Tells whether a file starts with the ELF magic. WHY: Separates a real Chrome binary from the launcher script. */
function isBinary(path) {
  const fd = openSync(path, "r"), head = Buffer.alloc(4);
  try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
  return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}

/** WHAT: Replaces a file by renaming a finished copy over it. WHY: A launch during the swap never finds the path missing. */
function replaceAtomically(path, write) {
  const temporary = `${path}.${process.pid}.tmp`;
  write(temporary);
  renameSync(temporary, path);
}

/** WHAT: Stores the launcher at one Chrome build's path, keeping the binary as <path>.real. WHY: Keeps every launcher, ad hoc scripts included, from writing shared memory to the SSD. */
export function guardChromeBuild(path) {
  const real = `${path}.real`;
  if (!isBinary(path)) {
    if (!existsSync(real)) return { path, state: "skipped", reason: "not a binary and no .real beside it" };
    if (readFileSync(path, "utf8") === CHROME_LAUNCHER) return { path, state: "guarded" };
    replaceAtomically(path, (temporary) => writeFileSync(temporary, CHROME_LAUNCHER, { mode: 0o755 }));
    return { path, state: "launcher-updated" };
  }
  // A reinstalled binary replaces an older .real; the hardlink keeps it reachable until the launcher lands.
  replaceAtomically(real, (temporary) => linkSync(path, temporary));
  replaceAtomically(path, (temporary) => writeFileSync(temporary, CHROME_LAUNCHER, { mode: 0o755 }));
  return { path, state: "wrapped" };
}

/** WHAT: Reports whether the system Chrome has the launcher. WHY: Only root can add it; dpkg-divert keeps it across upgrades. */
export function systemChromeState(path = SYSTEM_CHROME) {
  if (!existsSync(path)) return { path, state: "absent" };
  if (!isBinary(path) && existsSync(`${path}.real`)) return { path, state: "guarded" };
  return { path, state: "unguarded", fix: "docs/cli.md, disk guard: the one-time dpkg-divert for the system Chrome" };
}

/** WHAT: Dispatches the launcher to every downloaded Chrome build and reports the system Chrome. WHY: Keeps the shared-memory fix in place after Playwright upgrades. */
export function keepChromeMemoryInRam({ builds = downloadedChromeBuilds(), system = () => systemChromeState() } = {}) {
  const results = builds.map((path) => {
    try { return guardChromeBuild(path); } catch (error) { return { path, state: "refused", error: error.message }; }
  });
  return { builds: results, system: system() };
}
