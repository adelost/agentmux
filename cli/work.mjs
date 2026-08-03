import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSuggestionsFleetKeyFile, defaultSuggestionsTokenFile, sendSuggestionsRequest,
} from "../core/suggestions-authoring.mjs";
import { detectSenderFromEnv } from "../core/sender-detect.mjs";

const PROJECT_BY_SESSION = Object.freeze({
  skydive: "skydive", skyvw: "skyvw",
});
const VALUE_FLAGS = new Set([
  "base-url", "deploy", "hours", "live", "merge", "project", "summary", "tests", "wake",
]);

const usage = () => `Usage: amux work [status|next] [--project ID]
  amux work join --project ID
  amux work add "problem and expected outcome"
  amux work approve TICKET
  amux work claim TICKET
  amux work show TICKET
  amux work working "measured progress"
  amux work wait|block "reason" --wake "observable condition" [--hours N]
  amux work answer "answer after reading the ticket thread"
  amux work done --tests "focused/manual proof" [--summary TEXT]
                 [--merge URL] [--deploy TEXT] [--live TEXT]

The calling pane and pilot project are inferred. A shared fleet key can join a new
pane once. Workers self-claim approved READY work; no broker forwards the claim.`;

/** WHAT: Maps a pane address to one Suggestions project. WHY: Keeps project selection obvious and overrideable. */
export function projectForWorkSender(sender, override = null) {
  if (override) return override;
  const session = String(sender ?? "").split(":", 1)[0];
  return PROJECT_BY_SESSION[session] ?? null;
}

/** WHAT: Parses the deliberately small work command surface. WHY: Keeps agent workflow free of curl-shaped ceremony. */
export function parseWorkArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const action = args[0]?.startsWith("-") ? "status" : (args.shift() ?? "status");
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const [rawName, inline] = value.slice(2).split("=", 2);
    if (!VALUE_FLAGS.has(rawName)) throw new Error(`unknown option --${rawName}`);
    const next = inline ?? args[index + 1];
    if (!next || (inline == null && next.startsWith("--"))) {
      throw new Error(`--${rawName} requires a value`);
    }
    options[rawName] = next;
    if (inline == null) index += 1;
  }
  return { action, options, positional, help: false };
}

const parseResponse = (text, label) => {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON`); }
};

const credential = (path, label) => {
  let value;
  try { value = readFileSync(path, "utf8").trim(); }
  catch { throw new Error(`${label} is unavailable at ${path}`); }
  if (!value) throw new Error(`${label} is empty at ${path}`);
  return value;
};

/** WHAT: Defines the bounded HTTP seam used by amux work. WHY: Reuses durable mutation staging and hides credentials. */
export function createWorkClient({ baseUrl, sender, fleetToken, adminToken, fetchImpl = fetch,
  stateDir } = {}) {
  const headers = (admin = false) => ({ authorization: `Bearer ${admin ? adminToken : fleetToken}`,
    ...(admin ? {} : { "x-agent-id": sender }) });
  const read = async (path, admin = false) => {
    const response = await fetchImpl(new URL(path, baseUrl), { headers: headers(admin) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Suggestions HTTP ${response.status}: ${text.slice(0, 500)}`);
    return parseResponse(text, "Suggestions");
  };
  const mutate = async (path, method, body, admin = false) => {
    const temporary = mkdtempSync(join(tmpdir(), "amux-work-"));
    const bodyFile = join(temporary, "body.json");
    writeFileSync(bodyFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    try {
      const result = await sendSuggestionsRequest({ baseUrl, path, method, bodyFile,
        token: admin ? adminToken : fleetToken,
        requestHeaders: admin ? {} : { "x-agent-id": sender }, fetchImpl,
        ...(stateDir ? { stateDir } : {}) });
      return parseResponse(result.responseText, "Suggestions mutation");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  };
  return { read, mutate };
}

const rowLabel = (row) => {
  const id = row?.id ?? row?.ticketId ?? "?";
  const title = row?.title ?? row?.summary ?? "Untitled";
  const priority = row?.priority ? ` · ${row.priority}` : "";
  return `${id} · ${title}${priority}`;
};

/** WHAT: Formats one bounded work overview. WHY: Makes current state and next choices visible without becoming a dashboard. */
export function formatWorkOverview(data) {
  const agent = data?.agent ?? {};
  const project = data?.project ?? {};
  const lines = [
    `${project.id ?? "?"} · ${agent.id ?? agent.agentId ?? "?"} · ${agent.workStatus ?? "unknown"}`,
    `capacity ${project.activeWorkers ?? "?"}/${project.maxActiveWorkers ?? "?"}`,
  ];
  if (agent.currentTicket) lines.push(`CURRENT ${agent.currentTicket}`);
  const pending = Array.isArray(data?.pendingActions) ? data.pendingActions : [];
  if (pending.length) lines.push(`NEEDS RESPONSE ${pending.map((item) => item.kind).join(", ")}`);
  const ready = Array.isArray(data?.readyCandidates) ? data.readyCandidates.slice(0, 5) : [];
  lines.push(ready.length ? "READY" : "READY none");
  ready.forEach((row) => lines.push(`  ${rowLabel(row)}`));
  const omitted = Number(data?.readyOmitted ?? 0);
  if (omitted > 0) lines.push(`  +${omitted} more claimable`);
  const groups = data?.readyGroups;
  if (groups) {
    const awaiting = Array.isArray(data?.awaitingApprovalCandidates)
      ? data.awaitingApprovalCandidates.slice(0, 5) : [];
    if (Number(groups.awaitingApproval) > 0) {
      lines.push(`AWAITING APPROVAL ${Number(groups.awaitingApproval)}`);
      awaiting.forEach((row) => lines.push(`  ${rowLabel(row)}`));
    }
    const held = Array.isArray(data?.heldCandidates) ? data.heldCandidates.slice(0, 5) : [];
    if (Number(groups.held) > 0) {
      lines.push(`HELD ${Number(groups.held)}`);
      held.forEach((row) => lines.push(`  ${rowLabel(row)}`));
    }
    if (Number(groups.dependencyBlocked) > 0) {
      lines.push(`DEPENDENCY-BLOCKED ${Number(groups.dependencyBlocked)}`);
    }
  }
  const recent = Array.isArray(data?.recentTickets) ? data.recentTickets.slice(0, 3) : [];
  if (recent.length) lines.push("RECENT");
  recent.forEach((row) => {
    const commit = row?.delivery?.commit?.shortSha ? ` · ${row.delivery.commit.shortSha}` : "";
    lines.push(`  ${rowLabel(row)} · ${row.status ?? "unknown"}${commit}`);
  });
  return lines.join("\n");
}

/** WHAT: Formats one read-only ticket detail with its true claimability. WHY: Keeps criteria, revision and assignment out of raw API calls. */
export function formatTicketShow(detail) {
  const ticket = detail?.ticket ?? detail ?? {};
  const approval = ticket?.productApproval?.state ?? "unknown";
  const safetyState = ticket?.safety?.state ?? "clear";
  const lines = [rowLabel(ticket),
    `${ticket.status ?? "unknown"} · revision ${ticket.revision ?? "?"}`
    + ` · approval ${approval} · safety ${safetyState}`];
  const owner = ticket?.assignment?.ownership?.owner?.agentId ?? null;
  if (ticket?.assignment) {
    lines.push(`ASSIGNMENT ${owner ?? "?"} · ${ticket.assignment.state ?? "?"}`
      + ` · generation ${ticket.assignment.generation ?? "?"}`);
  }
  const held = ticket?.safety?.executionBlocked === true;
  const claimBlock = held ? "safety hold"
    : approval !== "approved" ? `approval ${approval}`
      : ticket?.assignment ? "already assigned"
        : ticket.status !== "ready" ? `status ${ticket.status ?? "unknown"}` : null;
  lines.push(claimBlock ? `CLAIMABLE no (${claimBlock})` : "CLAIMABLE yes");
  const boundedText = (value, limit = 600) => {
    const text = String(value ?? "").trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  };
  const problem = boundedText(ticket?.problem);
  if (problem) lines.push("PROBLEM", `  ${problem}`);
  const expected = boundedText(ticket?.expected);
  if (expected) lines.push("EXPECTED", `  ${expected}`);
  const criteria = Array.isArray(ticket?.criteria) ? ticket.criteria.slice(0, 8) : [];
  if (criteria.length) {
    lines.push("CRITERIA");
    criteria.forEach((criterion) => lines.push(`  - ${criterion}`));
  }
  if (ticket?.deferral) {
    lines.push(`DEFERRAL ${ticket.deferral.kind ?? "?"} · ${ticket.deferral.state ?? "?"}`
      + `${ticket.deferral.blockerRef ? ` · ${ticket.deferral.blockerRef}` : ""}`);
  }
  return lines.join("\n");
}

const currentWork = async (client, project) => {
  const overview = await client.read(`/api/agent/overview?project=${encodeURIComponent(project)}&recent=5`);
  const ticketId = overview?.agent?.currentTicket;
  const generation = Number(overview?.agent?.assignmentGeneration);
  if (!ticketId || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("this pane has no active Suggestions ticket");
  }
  return { overview, ticketId, generation };
};

const githubCommit = (cwd, exec = execFileSync) => {
  const run = (...args) => exec("git", args, { cwd, encoding: "utf8", timeout: 2_000 }).trim();
  try {
    const sha = run("rev-parse", "HEAD");
    const label = run("log", "-1", "--pretty=%s");
    const remote = run("config", "--get", "remote.origin.url")
      .replace(/^git@github\.com:/u, "https://github.com/").replace(/\.git$/u, "");
    return /^https:\/\/github\.com\//u.test(remote) ? { label, url: `${remote}/commit/${sha}` } : null;
  } catch { return null; }
};

const outputResult = (result, fallback) => {
  const ticket = result?.ticket ?? result;
  return ticket?.id ? rowLabel(ticket) : fallback;
};

/** WHAT: Defines one explicit board operation for the calling pane. WHY: Keeps the board additive instead of a mandatory broker. */
export async function runWorkCommand(argv, dependencies = {}) {
  const parsed = parseWorkArgs(argv);
  if (parsed.help) return usage();
  const sender = dependencies.sender;
  if (!sender) throw new Error("amux work must run inside a configured agent pane");
  const project = projectForWorkSender(sender, parsed.options.project);
  if (!project) throw new Error("cannot infer Suggestions project; pass --project ID");
  const baseUrl = parsed.options["base-url"] ?? dependencies.baseUrl ?? "https://suggest.v1d.io";
  const client = dependencies.client ?? createWorkClient({ baseUrl, sender,
    fleetToken: dependencies.fleetToken, adminToken: dependencies.adminToken,
    fetchImpl: dependencies.fetchImpl, stateDir: dependencies.stateDir });
  const action = parsed.action === "next" ? "status" : parsed.action;

  if (action === "status") return formatWorkOverview(await client.read(
    `/api/agent/overview?project=${encodeURIComponent(project)}&recent=5`));
  if (action === "show") {
    const ticketId = parsed.positional[0];
    if (!ticketId) throw new Error("show requires a ticket id");
    return formatTicketShow(await client.read(
      `/api/tickets/${encodeURIComponent(ticketId)}?project=${encodeURIComponent(project)}`));
  }
  if (action === "join") {
    try {
      await client.read(`/api/agent/overview?project=${encodeURIComponent(project)}&recent=1`);
      return `JOINED ${sender} · ${project} (already registered)`;
    } catch {
      await client.mutate(`/api/agent/register?project=${encodeURIComponent(project)}`, "POST", {
        agentId: sender, displayName: sender, mutationId: randomUUID(),
      });
      return `JOINED ${sender} · ${project}`;
    }
  }
  if (action === "add") {
    const raw = parsed.positional.join(" ").trim();
    if (raw.length < 8) throw new Error("add requires a concrete problem and expected outcome");
    const result = await client.mutate(`/api/agent/tickets?project=${encodeURIComponent(project)}`,
      "POST", { project, raw, mutationId: randomUUID() });
    const ticket = result?.ticket ?? result;
    return `${outputResult(result, "Ticket created")}\nNEXT amux work approve ${ticket?.id ?? "<ticket>"}`;
  }
  if (action === "approve") {
    const ticketId = parsed.positional[0];
    if (!ticketId) throw new Error("approve requires a ticket id");
    const detail = await client.read(`/api/tickets/${ticketId}?project=${encodeURIComponent(project)}`);
    const ticket = detail?.ticket;
    if (ticket?.productApproval?.state === "approved") return `APPROVED ${ticketId} (already)`;
    if (ticket?.status !== "ready") {
      throw new Error(`${ticketId} is ${ticket?.status ?? "unavailable"}; approve after triage reaches READY`);
    }
    const revision = Number(ticket.revision);
    const materialFingerprint = ticket.productApproval?.materialFingerprint;
    if (!Number.isSafeInteger(revision) || typeof materialFingerprint !== "string") {
      throw new Error("ticket approval material is unavailable");
    }
    await client.mutate(`/api/agent/tickets/${ticketId}/product-approval?project=${encodeURIComponent(project)}`,
      "POST", { source: sender, mutationId: randomUUID(), expectedTicketRevision: revision,
        materialFingerprint }, true);
    return `APPROVED ${ticketId}`;
  }
  if (action === "claim") {
    const ticketId = parsed.positional[0];
    if (!ticketId) throw new Error("claim requires a ticket id");
    const detail = await client.read(`/api/tickets/${ticketId}?project=${encodeURIComponent(project)}`);
    const revision = Number(detail?.ticket?.revision);
    if (!Number.isSafeInteger(revision)) throw new Error("ticket revision is unavailable");
    const result = await client.mutate("/api/agent/claim", "POST", { ticketId,
      expectedTicketRevision: revision, mutationId: randomUUID() });
    return outputResult(result, `CLAIMED ${ticketId}`);
  }
  if (action === "working") {
    const summary = parsed.positional.join(" ").trim();
    if (summary.length < 3) throw new Error("working requires measured progress");
    const current = await currentWork(client, project);
    await client.mutate("/api/agent/check-in", "POST", { ticketId: current.ticketId,
      assignmentGeneration: current.generation, mutationId: randomUUID(),
      status: "working", summary });
    return `WORKING ${current.ticketId}`;
  }
  if (action === "wait" || action === "block") {
    const reason = parsed.positional.join(" ").trim();
    const wakeCondition = String(parsed.options.wake ?? "").trim();
    const hours = Number(parsed.options.hours ?? 2);
    if (reason.length < 3 || wakeCondition.length < 3 || !Number.isFinite(hours) || hours <= 0) {
      throw new Error(`${action} requires a reason, --wake condition and positive --hours`);
    }
    const current = await currentWork(client, project);
    await client.mutate("/api/agent/check-in", "POST", { ticketId: current.ticketId,
      assignmentGeneration: current.generation, mutationId: randomUUID(),
      status: action === "wait" ? "waiting" : "blocked", reason, wakeCondition,
      nextCheckAt: Date.now() + Math.round(hours * 3_600_000) });
    return `${action.toUpperCase()} ${current.ticketId}`;
  }
  if (action === "answer") {
    const body = parsed.positional.join(" ").trim();
    if (body.length < 3) throw new Error("answer requires text after reading the full thread");
    const current = await currentWork(client, project);
    await client.mutate(`/api/tickets/${current.ticketId}/comments?project=${encodeURIComponent(project)}`,
      "POST", { mutationId: randomUUID(), body });
    return `ANSWERED ${current.ticketId}`;
  }
  if (action === "done") {
    const tests = String(parsed.options.tests ?? "").trim();
    if (tests.length < 3) throw new Error("done requires --tests with focused/manual proof");
    const current = await currentWork(client, project);
    const commit = parsed.options.merge
      ? { label: dependencies.commitLabel ?? "Delivered change", url: parsed.options.merge }
      : githubCommit(dependencies.cwd ?? process.cwd(), dependencies.execFileSync);
    if (!commit) throw new Error("cannot derive a GitHub commit; pass --merge URL");
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:commit|pull)\/[A-Za-z0-9_.-]+$/u
      .test(commit.url)) throw new Error("--merge must be a GitHub commit or pull-request URL");
    const completionReceipt = { assignmentGeneration: current.generation,
      summary: parsed.options.summary ?? `Delivered ${current.ticketId}.`, merge: [commit],
      tests: [{ label: tests, url: null }],
      deploy: parsed.options.deploy ? [{ label: parsed.options.deploy, url: null }] : [],
      live: parsed.options.live ? [{ label: parsed.options.live, url: null }] : [], attachmentIds: [] };
    await client.mutate(`/api/tickets/${current.ticketId}/admin?project=${encodeURIComponent(project)}`,
      "PATCH", { mutationId: randomUUID(), source: sender, status: "done",
        terminalAssignmentGeneration: current.generation, completionReceipt }, true);
    return `DONE ${current.ticketId} · ${commit.url}`;
  }
  throw new Error(`unknown work action '${parsed.action}'\n${usage()}`);
}

/** WHAT: Resolves local identity and credentials for the CLI entrypoint. WHY: Keeps tests pure and secrets off argv. */
export async function cmdWork(argv) {
  const parsed = parseWorkArgs(argv);
  if (parsed.help) { console.log(usage()); return; }
  const sender = detectSenderFromEnv(process.env,
    (command) => execSync(command, { encoding: "utf8", timeout: 2_000 }));
  const needsAdmin = parsed.action === "approve" || parsed.action === "done";
  const result = await runWorkCommand(argv, { sender,
    fleetToken: credential(process.env.AMUX_SUGGESTIONS_FLEET_KEY_FILE
      ?? defaultSuggestionsFleetKeyFile(), "Suggestions fleet key"),
    adminToken: needsAdmin ? credential(process.env.AMUX_SUGGESTIONS_ADMIN_TOKEN_FILE
      ?? defaultSuggestionsTokenFile(), "Suggestions admin token") : null });
  console.log(result);
}
