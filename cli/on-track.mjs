import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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
import { readAskProducers } from "../core/ask-source-evidence.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readIndexedOnTrackAnswer } from "../core/on-track-answer-index.mjs";

/** WHAT: Defines the reviewer evidence format and bounded command capture. WHY: Keeps submissions bound to the fixed checklist and source format. */
export const ON_TRACK_HELP = `amux on-track configure /absolute/projects.json
amux on-track register-producers /absolute/producers.json
amux on-track show PROJECT
amux on-track submit PROJECT /absolute/receipt.json
amux on-track capture PROJECT PROBE
amux on-track capture-owner PROJECT AGENT:PANE
amux on-track capture-answers PROJECT [CURSOR]  (bounded pages; nextCursor is returned)
amux on-track answer PROJECT ID  (actual full text from its captured source reference)
amux on-track recover-source PROJECT  (only an unreadable pending baseline; preserves cycle and deadline)
amux on-track evidence PROJECT RECORD  (read the captured source output)
amux on-track stats   (also amux done --on-track)

Hourly schedule, normal20min deadline, controller-approved first baseline24h/2h. No self-rating.
Receipt: {project,cycle,at,checks:[{id,result:"PASS|FAIL|UNKNOWN",evidence:[]}],deviations:[{check,row,owner,action}],asks:[],rows:[],live:[],outcomeChanges:[],resolved:[]}
File evidence: {kind:"file",path:"docs/TASKS.md",sha:"40 hex",line:12,quote:"exact line",at:"ISO"}.
Command evidence: use capture's returned JSON, including actual exitCode, sha256 and command. Only configured probes run, at explicit capture, never at receipt submission.
asks: EVERY original scoped order has disposition row, answered or missing.
row: {askId,disposition:"row",row,owner,estimate,outcome,evidence}; outcome is TASKS Done when.
answered: {askId,disposition:"answered",replyId,reason,evidence}; replyId must be a frozen canonical reply.
missing: {askId,disposition:"missing",row:null,reason,evidence} plus owned C1 FAIL. UNKNOWN only for an unreadable source.
Source delivery IDs are matched automatically when exactly one TASKS row carries the ID. Original receipt mappings remain inspectable.
rows: [{row,evidence,ownerLog,progressAt,waitingSince?,stop?:{kind,evidence},action?}] for active rows only. Read capture-owner once per owner. Later/parked/terminal rows are excluded.
Stop kinds: red,unexpected-value,money-cap,new-cause,human-decision,leader-queue. leader-queue needs predecessor OR gate, decisionId from frozen decisions, and evidence; estimates never stop progress.
live: [{path,result,at,evidence}] for EVERY configured live path. No new paid hourly run.
outcomeChanges: [{row,commit,askId,evidence}]. resolved: [{check,row,evidence}].
FAIL/UNKNOWN require an owned deviation. userOrMoneyImpact:true also notifies the human immediately.
See docs/ON-TRACK.md. Source integrity is machine checked; natural-language equivalence still requires the reviewer's judgment.`;

function saveConfiguration(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

/** WHAT: Routes the on-track CLI without starting a model or replaying a delivery. WHY: Separates receipt handling from queue submission and reviewer work. */
export async function cmdOnTrack(args, dependencies = {}) {
  const [action, id, file, ...extra] = args;
  if (!action || ["--help", "-h"].includes(action)) { console.log(ON_TRACK_HELP); return; }
  const state = dependencies.state || onTrackStore();
  if (action === "stats") { const rows = onTrackStatistics(state.get(ON_TRACK_STATE)); console.log(JSON.stringify(rows, null, 2)); return rows; }
  if (action === "register-producers") {
    if (!id || file) throw Error("register-producers requires one JSON array file");
    const input = JSON.parse(readFileSync(id, "utf8")), validated = readAskProducers(id);
    if (!Array.isArray(input) || input.length !== validated.length) throw Error("producer source/hash/authority did not verify");
    const path = join(homedir(), ".agentmux", "ask-producers.json");
    let old = [];
    try { old = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Array.isArray(old)) throw Error("existing producer registry unreadable");
    const merged = [...old.filter(p => !validated.some(next => next.id === p.id)), ...validated];
    if (new Set(merged.map(p => p.keyPrefix)).size !== merged.length) throw Error("producer namespaces overlap");
    saveConfiguration(path, merged); console.log(`registered ${validated.length} source-bound producers`); return;
  }
  if (action === "configure") {
    if (!id || file) throw Error("configure requires one projects.json file");
    const config = validateOnTrackProjects(JSON.parse(readFileSync(id, "utf8")));
    const path = onTrackPaths().config;
    saveConfiguration(path, config);
    console.log(`configured ${config.map(p => p.id).join(", ")}; schedule runs on bridge heartbeat`); return;
  }
  const projects = dependencies.projects || readOnTrackProjects;
  const project = projects().find(p => p.id === id);
  if (!project || extra.length) throw Error("unknown project or extra arguments");
  const record = state.get(ON_TRACK_STATE)?.projects[id];
  if (action === "show") { if (file) throw Error("show takes only PROJECT"); console.log(JSON.stringify(record || { status: "not-scheduled" }, null, 2)); return record; }
  if (action === "evidence") {
    const captured = state.get(ON_TRACK_STATE)?.commands?.[file];
    if (!captured || captured.project !== id) throw Error("captured evidence not found in this project");
    console.log(JSON.stringify(captured, null, 2)); return captured;
  }
  if (action === "answer") {
    if (!file || !record?.cycle) throw Error("answer needs a captured answer ID and current cycle");
    const answer = readIndexedOnTrackAnswer({ root: join(dirname(onTrackPaths().state), "answer-pages"), project: id, cycle: record.cycle, id: file });
    console.log(JSON.stringify(answer, null, 2)); return answer;
  }
  if (action === "recover-source") {
    if (file) throw Error("recover-source takes only PROJECT");
    const actor = dependencies.actor || detectSenderFromEnv(process.env, command => execSync(command, { encoding: "utf8", timeout: 2000 }));
    const runtime = createOnTrackRuntime({ state, projects, queue: dependencies.queue || createDeliveryQueue(), ...dependencies.runtime });
    const recovered = await runtime.recoverSource(project, actor); console.log(JSON.stringify(recovered, null, 2)); return recovered;
  }
  if (["capture", "capture-owner", "capture-answers"].includes(action)) {
    if (!record?.cycle || (action !== "capture-answers" && !file)) throw Error("capture needs a pending cycle and configured PROBE");
    let selected = project;
    if (action === "capture-answers") selected = { ...project, probes: { answers: [process.execPath, fileURLToPath(new URL("../bin/on-track-answers.mjs", import.meta.url)), id, ...(file ? [file] : [])] } };
    if (action === "capture-owner") {
      if (!/^[\w-]+:\d+$/u.test(file)) throw Error("invalid owner address");
      selected = { ...project, probes: { owner: [process.execPath, fileURLToPath(new URL("../bin/on-track-owner-log.mjs", import.meta.url)), file] } };
    }
    const prior = action === "capture-owner" && Object.entries(state.get(ON_TRACK_STATE).commands || {}).find(([,r]) =>
      r.project === id && r.cycle === record.cycle.id && r.probe === "owner" && r.command.at(-1) === file && Date.now() - Date.parse(r.at) < 3600000);
    const result = prior ? prior[1] : captureOnTrackCommand({ project: selected, cycle: record.cycle, probe: action === "capture-owner" ? "owner" : action === "capture-answers" ? "answers" : file });
    const key = prior ? prior[0] : randomUUID();
    if (!prior) state.updateKey(ON_TRACK_STATE, data => { data.commands[key] = result; return data; });
    const evidence = { kind: "command", record: key, at: result.at, command: result.command, exitCode: result.exitCode, sha256: result.sha256 };
    if (action === "capture-answers") try { const page = JSON.parse(result.stdout); evidence.answerPage = { offset: page.offset, count: page.answers.length, total: page.total, nextCursor: page.nextCursor }; } catch { /* Actual capture failure remains in its exit/error record. */ }
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
