import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readStateAgeProjects } from "../core/state-age-projects.mjs";
import { stateAgeDefault, readStateAgeSnapshot, replayStateAge } from "../core/state-age-history.mjs";
import { planStateAge, reserveStateAgeMessages } from "../core/state-age-guard.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createState } from "../core/state.mjs";
import { watchStateAge } from "./state-age-watch.mjs";
import { stateAgeDigests } from "../core/state-age-digests.mjs";

const help = "amux state-age replay --project cutkit --since ISO --until ISO [--output FILE]\namux state-age check|watch [--project ID] [--output FILE] [--send --measurement FILE]\nRead-only by default. Watch checks immediately, then hourly. Sends require Rule v2 probe hits, ten checked state clocks and at most12 recipient messages/day.";
const policyHash = () => createHash("sha256").update(["../core/state-age-guard.mjs", "../core/state-age-history.mjs", "../core/state-age-state-history.mjs", "../core/state-age-rows.mjs", "../core/state-age-digests.mjs", "../core/state-age-projects.mjs", "./state-age.mjs", "./state-age-panes.mjs", "./state-age-watch.mjs"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")).digest("hex");

/** WHAT: Checks a measured state-age activation record. WHY: Prevents a partial history or row count from authorizing excessive messages. */
export function qualifyStateAge(report, project) {
  return report?.policy === policyHash() && report.project === project.id && report.source?.root === project.root
    && report.source?.ledger === project.ledger
    && Object.keys(report.days || {}).length >= 3 && Object.values(report.days).every(day => day.messages <= 12)
    && report.sampleReview?.complete === true && report.sampleReview.reviewed === 10 && report.sampleReview.falseRecentChanges === 0
    && (project.id !== "cutkit" || report.firstFlags?.["533c"] <= "2026-10-27T09:24:00.000Z" && report.firstNamed?.["557a"] < "2026-10-27T00:00:00.000Z");
}

/** WHAT: Reads receipt identities from durable dispatcher jobs. WHY: Prevents a crash between enqueue and local bookkeeping from repeating an unowned-row alert. */
export function stateAgeQueuedReceipts(queue, projects, stored = []) {
  const seen = new Set(stored);
  for (const target of new Set(projects.map(project => project.dispatcher))) {
    const [agent, pane] = target.split(":");
    for (const job of queue.list(agent, Number(pane))) if (job.source === "state-age") {
      for (const key of job.metadata?.receiptKeys || [job.idempotencyKey]) if (typeof key === "string") seen.add(key);
    }
  }
  return seen;
}

/** WHAT: Checks historical or current rows with optional qualified alarms. WHY: Keeps calibration and durable owner delivery on the same policy. */
export async function cmdStateAge(args, ctx = {}, injected = {}) {
  if (args.includes("--help") || !["replay", "check", "watch"].includes(args[0])) { console.log(help); return; }
  if (args[0] === "watch") return watchStateAge(() => cmdStateAge(["check", ...args.slice(1)], ctx, injected));
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--send") { flags.send = true; continue; }
    if (!["--project", "--since", "--until", "--output", "--measurement"].includes(args[i]) || !args[i + 1]) throw Error(`Unknown state-age option ${args[i]}`);
    flags[args[i].slice(2)] = args[++i];
  }
  const allProjects = injected.projects || readStateAgeProjects();
  const projects = allProjects.filter(p => p.dispatcher && (!flags.project || p.id === flags.project));
  if (!projects.length) throw Error("No configured state-age projects");
  let report;
  if (args[0] === "replay") {
    if (projects.length !== 1 || !flags.since || !flags.until || flags.send) throw Error("Replay needs one project and explicit bounds; it never sends");
    report = await (injected.replay || replayStateAge)(projects[0], { since: Date.parse(flags.since), until: Date.parse(flags.until) });
    report.source = { ...report.source, root: projects[0].root, ledger: projects[0].ledger };
    report.policy = policyHash();
    report.eligible = qualifyStateAge(report, projects[0]);
  } else {
    const sourceErrors = [];
    const registrationProjects = await Promise.all(allProjects.map(async p => {
      try { return await readStateAgeSnapshot(p, stateAgeDefault(p).tip); }
      catch (error) {
        if (projects.some(selected => selected.id === p.id)) throw error;
        sourceErrors.push({ project: p.id, root: p.root, ledger: p.ledger, error: error.message }); return { ...p, rows: [] };
      }
    }));
    const snapshots = registrationProjects.filter(p => projects.some(selected => selected.id === p.id));
    const ps = injected.ps || JSON.parse(execFileSync(process.execPath, [new URL("../bin/agent-cli.mjs", import.meta.url).pathname, "ps", "--json"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
    const now = injected.now || Date.now(), root = process.env.AMUX_STATE_AGE_DIR || join(homedir(), ".agentmux/state-age");
    const store = injected.store || createState(join(root, "state.json"));
    const seen = new Set(store.get("sent", []));
    report = { at: new Date(now).toISOString(), policy: policyHash(), source: snapshots.map(({ id, sha, tip }) => ({ id, sha, tip })),
      ps, sourceErrors, unroutedProjects: allProjects.filter(p => !p.dispatcher).map(({ id, root, ledger }) => ({ id, root, ledger })),
      ...planStateAge({ projects: snapshots, registrationProjects, panes: ps.panes, now, seen }), sent: [] };
    report.messages = stateAgeDigests(report, snapshots, new Set(store.get("deliveredDigests", [])));
    if (flags.send) {
      const calibration = flags.measurement && JSON.parse(readFileSync(flags.measurement, "utf8"));
      if (projects.length !== 1 || !qualifyStateAge(calibration, projects[0])) throw Error("State-age activation refused: incomplete or excessive historical message volume");
      const queue = injected.queue || createDeliveryQueue();
      const digestKeys = stateAgeQueuedReceipts(queue, snapshots, store.get("deliveredDigests", []));
      report.messages = stateAgeDigests(report, snapshots, digestKeys);
      store.set("reservations", reserveStateAgeMessages(report, store.get("reservations", {})));
      for (const message of report.messages) {
        const [agentName, pane] = message.target.split(":");
        const job = queue.enqueue({ agentName, pane: Number(pane), text: message.text,
          source: "state-age", metadata: { sender: "state-age", digestKey: message.key, receiptKeys: message.receiptKeys }, idempotencyKey: message.idempotencyKey });
        for (const key of job.metadata?.receiptKeys || [job.idempotencyKey]) digestKeys.add(key);
        report.sent.push({ id: job.id, target: message.target, digestKey: message.key, status: job.status });
      }
      store.set("deliveredDigests", [...digestKeys].filter(key => key.startsWith("state-age-unowned:") || key.slice(13, 23) >= new Date(now - 7 * 86400000).toISOString().slice(0, 10)));
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "last-check.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    }
  }
  if (flags.output) writeFileSync(flags.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(args[0] === "replay" ? { ...report, snapshots: undefined,
    days: Object.fromEntries(Object.entries(report.days).map(([day, value]) => [day, { ...value, alarms: undefined }])) }
    : { at: report.at, alarms: report.alarms.length, messages: report.messages.length, unknownClocks: report.unknownClocks.length, sent: report.sent }, null, 2));
  return report;
}
