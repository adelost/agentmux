import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { onTrackPaths, onTrackStore, readOnTrackProjects, validateOnTrackProjects } from "../core/on-track-projects.mjs";
import { ON_TRACK_STATE, onTrackStatistics } from "../core/on-track-monitor.mjs";
import { captureOnTrackCommand } from "../core/on-track-evidence.mjs";
import { createOnTrackRuntime } from "../channels/on-track.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { detectSenderFromEnv } from "../core/sender-detect.mjs";

/** WHAT: Defines the reviewer evidence format and bounded command capture. WHY: Keeps submissions bound to the fixed checklist and source format. */
export const ON_TRACK_HELP = `amux on-track configure /absolute/projects.json
amux on-track show PROJECT
amux on-track submit PROJECT /absolute/receipt.json
amux on-track capture PROJECT PROBE
amux on-track capture-owner PROJECT AGENT:PANE
amux on-track stats   (also amux done --on-track)

Hourly schedule, 20 minute receipt deadline, C1-C5. No self-rating.
Receipt: {project,cycle,at,checks:[{id,result:"PASS|FAIL|UNKNOWN",evidence:[]}],deviations:[{check,row,owner,action}],asks:[],rows:[],live:[],outcomeChanges:[],resolved:[]}
File evidence: {kind:"file",path:"docs/TASKS.md",sha:"40 hex",line:12,quote:"exact line",at:"ISO"}.
Command evidence: use capture's returned JSON, including actual exitCode, sha256 and command. Only configured probes run, at explicit capture, never at receipt submission.
asks: [{askId,row,owner,estimate,outcome,evidence}] for EVERY frozen ask. outcome is TASKS Done when.
Explicit non-task/other-project dispositions require the frozen existing binding: {askId,disposition,bindingRef,reason}. Missing task: {askId,row:null,reason,evidence} plus owned C1 FAIL/UNKNOWN.
rows: [{row,evidence,ownerLog,progressAt,waitingSince?,stop?:{kind,evidence},action?}] for EVERY open row. Stop kinds: red,unexpected-value,money-cap,new-cause,human-decision.
live: [{path,result,at,evidence}] for EVERY configured live path. No new paid hourly run.
outcomeChanges: [{row,commit,askId,evidence}]. resolved: [{check,row,evidence}].
FAIL/UNKNOWN require an owned deviation. userOrMoneyImpact:true also notifies the human immediately.
See docs/ON-TRACK.md. Source integrity is machine checked; natural-language equivalence still requires the reviewer's judgment.`;

/** WHAT: Routes the on-track CLI without starting a model or replaying a delivery. WHY: Separates receipt handling from queue submission and reviewer work. */
export async function cmdOnTrack(args, dependencies = {}) {
  const [action, id, file, ...extra] = args;
  if (!action || ["--help", "-h"].includes(action)) { console.log(ON_TRACK_HELP); return; }
  const state = dependencies.state || onTrackStore();
  if (action === "stats") { const rows = onTrackStatistics(state.get(ON_TRACK_STATE)); console.log(JSON.stringify(rows, null, 2)); return rows; }
  if (action === "configure") {
    if (!id || file) throw Error("configure requires one projects.json file");
    const config = validateOnTrackProjects(JSON.parse(readFileSync(id, "utf8")));
    const path = onTrackPaths().config;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    console.log(`configured ${config.map(p => p.id).join(", ")}; schedule runs on bridge heartbeat`); return;
  }
  const projects = dependencies.projects || readOnTrackProjects;
  const project = projects().find(p => p.id === id);
  if (!project || extra.length) throw Error("unknown project or extra arguments");
  const record = state.get(ON_TRACK_STATE)?.projects[id];
  if (action === "show") { if (file) throw Error("show takes only PROJECT"); console.log(JSON.stringify(record || { status: "not-scheduled" }, null, 2)); return record; }
  if (action === "capture" || action === "capture-owner") {
    if (!record?.cycle || !file) throw Error("capture needs a pending cycle and configured PROBE");
    let selected = project;
    if (action === "capture-owner") {
      if (!/^[\w-]+:\d+$/u.test(file)) throw Error("invalid owner address");
      selected = { ...project, probes: { owner: [process.execPath, fileURLToPath(new URL("../bin/on-track-owner-log.mjs", import.meta.url)), file] } };
    }
    const result = captureOnTrackCommand({ project: selected, cycle: record.cycle, probe: action === "capture-owner" ? "owner" : file });
    const key = randomUUID();
    state.updateKey(ON_TRACK_STATE, data => { data.commands[key] = result; return data; });
    const evidence = { kind: "command", record: key, at: result.at, command: result.command, exitCode: result.exitCode, sha256: result.sha256 };
    console.log(JSON.stringify(evidence, null, 2)); return evidence;
  }
  if (action !== "submit" || !file) throw Error(ON_TRACK_HELP);
  const actor = dependencies.actor || detectSenderFromEnv(process.env, command => execSync(command, { encoding: "utf8", timeout: 2000 }));
  const runtime = createOnTrackRuntime({ state, projects, queue: dependencies.queue || createDeliveryQueue(), ...dependencies.runtime });
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error("on-track receipt exceeds 2 MiB");
  let receipt;
  try { receipt = JSON.parse(text); } catch { receipt = null; }
  const review = await runtime.submit(project, receipt, actor);
  console.log(JSON.stringify(review, null, 2));
  if (!review.valid) process.exitCode = 1;
  return review;
}
