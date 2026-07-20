// Windows-owned Discord rescue listener. It remains outside WSL so a human can
// recover the bridge, or deliberately recycle WSL, from one authenticated channel.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";

const WINDOWS_CWD = "/mnt/c/Windows/System32";

function usage() {
  return `Usage:
  amux restarter install --channel ID --user ID [--distro NAME] [--linux-user NAME]
  amux restarter status
  amux restarter start
  amux restarter start-supervised
  amux restarter stop
  amux restarter rescue-test

Discord commands in the configured channel:
  //status        Report Windows, WSL, bridge, release, and memory truth.
  //logs          Return bounded redacted Windows and WSL logs.
  //start-wsl     Start WSL once without shutting anything down.
  //start-bridge  Open the WSL bridge in a visible Windows terminal.
  //recover       Start only components proven missing; never kills unknown state.
  //restart-wsl --receipt ID
                  One fenced WSL restart after a fresh restart-ready receipt.`;
}

function parse(args) {
  const [action = "status", ...rest] = args;
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument '${token}'`);
    const key = token.slice(2);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    flags[key] = value;
  }
  return { action, flags };
}

function discordToken(bridgeDir) {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  const candidates = [
    process.env.AMUX_DISCORD_ENV,
    resolve(bridgeDir, ".env"),
    resolve(process.env.HOME || "", "lsrc/agentmux/.env"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const token = readFileSync(path, "utf8").match(/^DISCORD_TOKEN=(.+)$/m)?.[1]?.trim();
      if (token) return token;
    } catch {}
  }
  throw new Error("DISCORD_TOKEN is missing; set AMUX_DISCORD_ENV to the bridge .env path");
}

function windowsPath(linuxPath) {
  const result = spawnSync("wslpath", ["-w", linuxPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`could not translate restarter path: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** WHAT: Resolves WSL agents that already consume one Discord channel. WHY: Prevents two bridges from replying in the Windows rescue channel. */
export function rescueChannelOwners(config, channelId) {
  const target = String(channelId);
  return Object.entries(config || {}).flatMap(([name, value]) => {
    if (!value?.dir || !value.discord) return [];
    if (typeof value.discord === "string") {
      return value.discord === target ? [name] : [];
    }
    return Object.hasOwn(value.discord, target) ? [name] : [];
  });
}

async function runPowerShell(script, parameters, { stdin = "" } = {}) {
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", windowsPath(script),
    ...parameters,
  ];
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", args, {
      cwd: WINDOWS_CWD,
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Windows restarter command failed with exit ${code}`));
    });
    child.stdin.end(stdin);
  });
}

/** WHAT: Routes Windows-owned Discord rescue listener commands. WHY: Keeps bridge recovery available when WSL or AMUX is unavailable. */
export async function cmdRestarter(args, { bridgeDir }) {
  const { action, flags } = parse(args);
  if (action === "help" || action === "-h" || action === "--help") {
    console.log(usage());
    return;
  }
  const script = resolve(bridgeDir, "bin/windows-discord-restarter.ps1");

  if (action === "install") {
    const channel = flags.channel;
    const user = flags.user;
    if (!/^\d{17,20}$/u.test(channel || "") || !/^\d{17,20}$/u.test(user || "")) {
      throw new Error("install requires Discord snowflakes via --channel ID --user ID");
    }
    const generatedConfig = process.env.AGENT_CONFIG
      || resolve(process.env.HOME || "", ".config/agent/agents.yaml");
    const owners = rescueChannelOwners(loadConfig(generatedConfig), channel);
    if (owners.length) {
      throw new Error(`Windows rescue channel ${channel} is already mapped to WSL agent(s): ${owners.join(", ")}`);
    }
    const distro = flags.distro || "Ubuntu-22.04";
    const linuxUser = flags["linux-user"] || process.env.USER || "adelost";
    const poll = flags.poll || "3";
    await runPowerShell(script, [
      "-Install",
      "-ChannelId", channel,
      "-AuthorizedUserId", user,
      "-Distro", distro,
      "-LinuxUser", linuxUser,
      "-PollSeconds", poll,
    ], { stdin: discordToken(bridgeDir) });
    return;
  }

  const switches = {
    status: "-Status",
    start: "-Start",
    "start-supervised": "-StartSupervised",
    stop: "-Stop",
    "rescue-test": "-RescueTest",
  };
  const selected = switches[action];
  if (!selected) throw new Error(`${usage()}\n\nUnknown restarter action '${action}'.`);
  await runPowerShell(script, [selected]);
}
