// WSL boot watch for the Windows manager: notices a WSL restart the manager did
// not order (a manual wsl --shutdown, a Windows reboot, a crash) and says so
// once in the rescue channel. It never enters a WSL that is not already running.

import { join } from "node:path";
import { planBootNotice } from "./windows-manager-commands.mjs";
import { deliverReply } from "./windows-manager-discord.mjs";
import { trackManagerBootId } from "./windows-manager.mjs";

const BOOT_WATCH_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const WSL_IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/u;
const BOOT_ID = /^[0-9a-f-]{36}$/u;

/** WHAT: Builds a reader for the WSL boot id that only runs while the distro is up. WHY: Prevents the boot watch from starting a WSL the human shut down. */
export function createRunningBootReader({ rootDir, run, readJson, systemRoot = process.env.SystemRoot || "C:\\Windows" }) {
  const wslExe = join(systemRoot, "System32", "wsl.exe");
  return async () => {
    const restarter = readJson(join(rootDir, "config.json"));
    if (!WSL_IDENTIFIER.test(restarter?.distro || "") || !WSL_IDENTIFIER.test(restarter?.linuxUser || "")) {
      return { ok: false, reason: "restarter-config-missing-distro" };
    }
    // wsl.exe lists in UTF-16LE. A failed list reads as not running: only a listed distro is ever entered.
    const listed = await run(wslExe, ["--list", "--running", "--quiet"], PROBE_TIMEOUT_MS);
    const names = listed.stdout.replace(/[\0\uFEFF\uFFFD]/gu, "").split(/\r?\n/u).map((line) => line.trim());
    if (!names.includes(restarter.distro)) return { ok: true, running: false };
    const read = await run(wslExe, ["-d", restarter.distro, "-u", restarter.linuxUser, "--", "cat", "/proc/sys/kernel/random/boot_id"], PROBE_TIMEOUT_MS);
    const bootId = read.stdout.trim();
    if (read.ok && BOOT_ID.test(bootId)) return { ok: true, running: true, bootId };
    return { ok: false, reason: read.timedOut ? "boot-id-timeout" : "boot-id-unreadable" };
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
    deps.log?.(`boot watch skipped: ${boot?.reason || "unknown"}`);
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
