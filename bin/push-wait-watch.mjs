#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveConfigSources } from "../core/config-sources.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";
import { pollPushWaitOnce, pushWaitVerdict, readPushWaitCommits, readPushWaitUnlanded } from "../core/push-wait-watch.mjs";
import { notifyUser } from "../cli/send-notify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args[0] !== "poll" || args.some((a, i) => i > 0 && !["--dry-run", "--now"].includes(a) && args[i - 1] !== "--now"))
  throw new Error("Usage: push-wait-watch.mjs poll [--dry-run --now ISO]");
const dry = args.includes("--dry-run"), nowAt = args.indexOf("--now");
if (nowAt !== -1 && (!dry || !args[nowAt + 1] || !Number.isFinite(Date.parse(args[nowAt + 1])))) throw new Error("--now requires --dry-run and an ISO date");
const now = nowAt < 0 ? Date.now() : Date.parse(args[nowAt + 1]);
const configPath = resolveConfigSources({ packageDir: root }).agentmuxYaml.path;
const config = yaml.load(readFileSync(configPath, "utf8"))?.push_wait_watch ?? { repos: ["~/lsrc/cutkit"], tell: "sandman:0" };
if (!Array.isArray(config.repos) || !/^[-a-z0-9]+:\d+$/u.test(config.tell)) throw new Error("invalid push_wait_watch config");
const repos = config.repos.map(path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path));
if (dry) {
  for (const repo of repos) console.log(JSON.stringify({ repo, ...pushWaitVerdict(readPushWaitCommits(repo, now), now) }));
} else {
  loadRuntimeEnv({ packageRoot: root });
  const path = join(homedir(), ".agentmux/push-wait-watch.json");
  const readState = () => { try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; } };
  const writeState = value => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, path);
  };
  const [agentName, pane] = config.tell.split(":");
  const queue = createDeliveryQueue();
  const send = (text, { idempotencyKey }) => queue.enqueue({ agentName, pane: Number(pane), source: "delivery-recovery", text, idempotencyKey });
  const results = await pollPushWaitOnce({ repos, readCommits: readPushWaitCommits, readUnlanded: readPushWaitUnlanded, readState, writeState, send, notify: notifyUser, tell: config.tell, now: Date.now });
  console.log(JSON.stringify(results));
}
