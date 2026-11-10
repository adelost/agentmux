// WSL boot watch for the Windows manager: notices a WSL restart the manager did
// not order (a manual wsl --shutdown, a Windows reboot, a crash) and says so
// once in the rescue channel. It never enters a WSL that is not already running.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { planBootNotice } from "./windows-manager-commands.mjs";
import { deliverReply } from "./windows-manager-discord.mjs";
import { trackManagerBootId } from "./windows-manager.mjs";

const BOOT_WATCH_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const BOOT_ID_TIMEOUT = Object.freeze({ ok: false, reason: "boot-id-timeout" });
const BOOT_ID_PENDING = Object.freeze({ ok: false, reason: "boot-id-pending" });
const WSL_IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/u;
const BOOT_ID = /^[0-9a-f-]{36}$/u;

/** WHAT: Resolves with the promise's value, or with onTimeout when timeoutMs passes first. WHY: Frees the turn lane without ending the work behind the promise. */
function settleWithin(promise, timeoutMs, onTimeout) {
  let timer;
  const deadline = new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(onTimeout), timeoutMs); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function toBootObservation(text) {
  const bootId = String(text).trim();
  return BOOT_ID.test(bootId) ? { ok: true, running: true, bootId } : { ok: false, reason: "boot-id-unreadable" };
}

/** WHAT: Reads a Windows path as text. WHY: The boot id comes through WSL's 9p share, a file read on the Windows side. */
const readWindowsText = (path) => readFile(path, "utf8");

/** WHAT: Builds a reader for the WSL boot id that only runs while the distro is up. WHY: Prevents the boot watch from starting a WSL the human shut down. */
export function createRunningBootReader({ rootDir, run, readJson, readText = readWindowsText, log = () => {},
  systemRoot = process.env.SystemRoot || "C:\\Windows" }) {
  const wslExe = join(systemRoot, "System32", "wsl.exe");
  let slowRead = null;
  return async () => {
    if (slowRead) return BOOT_ID_PENDING;
    const restarter = readJson(join(rootDir, "config.json"));
    if (!WSL_IDENTIFIER.test(restarter?.distro || "")) {
      return { ok: false, reason: "restarter-config-missing-distro" };
    }
    // wsl.exe lists in UTF-16LE. A failed list reads as not running: only a listed distro is ever entered.
    const listed = await run(wslExe, ["--list", "--running", "--quiet"], PROBE_TIMEOUT_MS);
    const names = listed.stdout.replace(/[\0\uFEFF\uFFFD]/gu, "").split(/\r?\n/u).map((line) => line.trim());
    if (!names.includes(restarter.distro)) return { ok: true, running: false };
    // The id is read through WSL's 9p share, never by `wsl.exe -- cat`: a wsl.exe started a Linux process whose relay waits with no limit
    // once wsl.exe goes, whether it was killed (95 of 101 relays, 28 to 30 Oct) or gave up by itself after 30 s (5 of 6 slow reads,
    // 10 Nov 11:38-11:55Z; row 123). A slow read is waited out alone; only the turn is released at the deadline.
    const startedAt = performance.now();
    const read = Promise.resolve(readText(`\\\\wsl.localhost\\${restarter.distro}\\proc\\sys\\kernel\\random\\boot_id`))
      .then(toBootObservation, (error) => ({ ok: false, reason: `boot-id-unreadable: ${error?.code || error?.message || error}` }));
    const first = await settleWithin(read, PROBE_TIMEOUT_MS, BOOT_ID_TIMEOUT);
    if (first === BOOT_ID_TIMEOUT) {
      slowRead = read
        .then((late) => (late.ok ? "ok" : late.reason), (error) => `failed: ${error?.message || error}`)
        .then((outcome) => {
          slowRead = null;
          log(`boot watch slow read finished after ${Math.round((performance.now() - startedAt) / 1000)}s: ${outcome}`);
        });
    }
    return first;
  };
}

/** WHAT: Tracks an observed boot id and posts the boot change line when one is due. WHY: Keeps manual restarts, reboots and crashes visible in the rescue channel. */
export async function noteBootObservation(state, observation, { deps, observer }) {
  const fromBootId = state.lastBootId || null;
  trackManagerBootId(state, observation);
  if (state.lastBootId === fromBootId) return false;
  const notice = planBootNotice({ fromBootId, toBootId: state.lastBootId, orders: state.managerOrders, nowMs: deps.nowMs(), observer });
  if (notice) await deliverReply(state, deps, notice);
  return true;
}

/** WHAT: Dispatches one boot watch tick. WHY: Prevents a WSL restart outside the manager from going unannounced. */
export async function watchWslBoot({ state, deps }) {
  const boot = await deps.readRunningBootId();
  if (!boot?.ok) {
    // A slow read logged its boot-id-timeout once and logs again when it finishes.
    if (boot?.reason !== BOOT_ID_PENDING.reason) deps.log?.(`boot watch skipped: ${boot?.reason || "unknown"}`);
    return false;
  }
  if (!boot.running) return false;
  const changed = await noteBootObservation(state, { bootId: boot.bootId }, { deps, observer: "watch" });
  if (changed) deps.saveState(state);
  return changed;
}

/** WHAT: Schedules the boot watch on the serial turn lane. WHY: Keeps a tick from observing WSL in the middle of a manager restart. */
export function startWslBootWatch({ state, deps, serializeTurn, log }) {
  const tick = async () => {
    await serializeTurn(() => watchWslBoot({ state, deps })).catch((error) => log(`boot watch failed: ${error?.message || error}`));
    setTimeout(tick, BOOT_WATCH_MS);
  };
  void tick();
}
