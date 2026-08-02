import {
  DEFAULT_ANDROID_EMULATOR_CONFIRM_MS,
  DEFAULT_ANDROID_EMULATOR_IDLE_MS,
  ensureAndroidEmulator,
  formatAndroidEmulatorSweep,
  sweepAndroidEmulators,
  touchAndroidEmulator,
} from "../core/android-emulator-lifecycle.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry" || arg === "--json" || arg === "--no-wait") flags[arg.slice(2)] = true;
    else if (["--minutes", "--confirm-minutes", "--port"].includes(arg)) {
      const value = argv[++index];
      if (value == null || !/^\d+$/u.test(value)) throw new Error(`${arg} requires a positive integer`);
      flags[arg.slice(2)] = Number(value);
    } else if (arg === "--avd") {
      const value = argv[++index];
      if (!value || !/^[A-Za-z0-9._-]+$/u.test(value)) throw new Error("--avd requires a valid AVD name");
      flags.avd = value;
    } else if (arg.startsWith("--")) throw new Error(`unknown emulator option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

function usage() {
  return `Usage:
  amux emulator status [--avd NAME] [--minutes N] [--json]
  amux emulator reap [--avd NAME] [--minutes N] [--confirm-minutes N] [--dry] [--json]
  amux emulator ensure <avd> [--port N] [--no-wait]
  amux emulator touch <avd>

The guard only manages headless Android emulators. Reap is graceful and
requires two idle observations; ensure resumes the same AVD data on demand.`;
}

/** WHAT: Routes emulator status, reap and wake actions. WHY: Keeps lifecycle actions from bypassing the durable guard. */
export async function cmdEmulator(argv) {
  const action = argv[0] || "status";
  if (["help", "-h", "--help"].includes(action)) {
    console.log(usage());
    return;
  }
  const { positional, flags } = parseArgs(argv.slice(1));
  const idleMs = (flags.minutes ?? Math.round(DEFAULT_ANDROID_EMULATOR_IDLE_MS / 60_000)) * 60_000;
  const confirmMs = (flags["confirm-minutes"] ?? Math.round(DEFAULT_ANDROID_EMULATOR_CONFIRM_MS / 60_000)) * 60_000;
  if (action === "status" || action === "reap") {
    if (positional.length) throw new Error(`${action} accepts no positional arguments`);
    const result = await sweepAndroidEmulators({
      idleMs,
      confirmMs,
      dryRun: action === "status" || !!flags.dry,
      onlyAvd: flags.avd || null,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatAndroidEmulatorSweep(result));
    return result;
  }
  if (action === "ensure") {
    if (positional.length !== 1) throw new Error("Usage: amux emulator ensure <avd> [--port N] [--no-wait]");
    const result = await ensureAndroidEmulator(positional[0], { port: flags.port, waitForBoot: !flags["no-wait"] });
    console.log(`${result.reused ? "reused" : "started"} ${result.avd} as ${result.serial}; booted=${result.booted}`);
    return result;
  }
  if (action === "touch") {
    if (positional.length !== 1) throw new Error("Usage: amux emulator touch <avd>");
    const result = touchAndroidEmulator(positional[0]);
    console.log(`recorded emulator use for ${result.avd}`);
    return result;
  }
  throw new Error(`unknown emulator action ${action}\n${usage()}`);
}
