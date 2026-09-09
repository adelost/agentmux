import { parseDreamSchedule } from "./dream-health.mjs";

/** WHAT: Builds the one cheap missed-night trigger. WHY: Keeps the existing daily schedule and unrelated cron jobs without creating a second time authority. */
export function dreamCatchupCrontab(current, packageRoot) {
  if (!/^\/[a-zA-Z0-9_./-]+$/u.test(packageRoot)) throw new Error("cron package path must be an absolute shell-safe path");
  if (!parseDreamSchedule(current, { timeZone: "UTC" })) throw new Error("configure one daily dream-cron.sh entry first");
  const daily = current.split(/\r?\n/u).find((line) => !line.trim().startsWith("#") && line.includes("/dream-cron.sh"));
  if (!daily.includes(`${packageRoot}/bin/dream-cron.sh`)) throw new Error("run this installer from the same installed package as the daily Dream entry");
  const lines = current.split(/\r?\n/u).filter((line) => !line.endsWith("# amux-dream-catchup"));
  if (lines.some((line) => !line.trim().startsWith("#") && line.includes("/dream-catchup.sh"))) {
    throw new Error("unmanaged Dream catchup entry already exists");
  }
  const entry = `*/10 * * * * ${packageRoot}/bin/dream-catchup.sh >> $HOME/.cache/agentmux-dream.log 2>&1 # amux-dream-catchup`;
  return `${lines.join("\n").trimEnd()}\n${entry}\n`;
}
