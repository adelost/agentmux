import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSuggestionsFleetKeyFile, defaultSuggestionsTokenFile, sendSuggestionsRequest,
} from "../core/suggestions-authoring.mjs";
import { detectSenderFromEnv } from "../core/sender-detect.mjs";
import { normalizeServiceBaseUrl } from "../core/runtime-defaults.mjs";

// A tmux session maps to one Suggestions project ONLY where the pane's work has
// exactly one home. `ai` was missing here, and the cost was not one extra flag:
// the CLI aborted LOCALLY with "cannot infer project", never reaching the network,
// and three days of conclusions read the resulting failure as a capability denial.
// A request that never left the machine cannot be an authorization decision — but
// nothing in the output said so, and two panes redesigned trust around it.
//
// `lsrc` is deliberately absent. Its panes work Source AND orchestrate the
// skydive, skyvw and ai boards, so there is no single right default; guessing one
// would be a silent wrong-project pick, which is worse than the explicit
// --project it saves.
const PROJECT_BY_SESSION = Object.freeze({
  ai: "ai", skydive: "skydive", skyvw: "skyvw",
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
  amux work retry TICKET
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
  const serviceBaseUrl = normalizeServiceBaseUrl(baseUrl, "Suggestions base URL", {
    allowHttpLoopback: process.env.NODE_ENV === "test",
  });
  const headers = (admin = false) => ({ authorization: `Bearer ${admin ? adminToken : fleetToken}`,
    ...(admin ? {} : { "x-agent-id": sender }) });
  const read = async (path, admin = false) => {
    const response = await fetchImpl(new URL(path, serviceBaseUrl), { headers: headers(admin) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Suggestions HTTP ${response.status}: ${text.slice(0, 500)}`);
    return parseResponse(text, "Suggestions");
  };
  const mutate = async (path, method, body, admin = false) => {
    const temporary = mkdtempSync(join(tmpdir(), "amux-work-"));
    const bodyFile = join(temporary, "body.json");
    writeFileSync(bodyFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    try {
      const result = await sendSuggestionsRequest({ baseUrl: serviceBaseUrl, path, method, bodyFile,
        token: admin ? adminToken : fleetToken,
        requestHeaders: admin ? {} : { "x-agent-id": sender }, fetchImpl,
        ...(stateDir ? { stateDir } : {}) });
      return parseResponse(result.responseText, "Suggestions mutation");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  };
  return { read, mutate };
}

const RETRY_NEXT_STEP = {
  "retry-budget-spent":
    "the bounded retry was already used and judged. Re-running an unstable judge is dice, not recovery — rewrite the report as a new ticket, or have a human review this one.",
  "last-triage-outcome-was-not-a-failure":
    "the triage completed and asked questions; retry cannot answer them. Use: amux work answer \"<answer>\".",
  "ticket-not-in-needs-detail":
    "retry recovers a triage that failed; this ticket is not waiting on one.",
  "no-terminalized-triage":
    "no triage has terminalized on this ticket, so there is nothing to re-run.",
  "ticket-changed-during-retry":
    "the ticket moved between the check and the write. Re-read it and try once more.",
};

/**
 * WHAT: Turns a refused retry into the caller's next action.
 * WHY: A terminal reason must say what to DO. The board answers one 409 for
 * several distinct states, and until it carried a reason three panes in one day
 * each read it as a spent budget. When the server does not name a state, say so
 * plainly rather than guessing one — a confident wrong reason is worse than none.
 */
export function retryRefusal(ticketId, error) {
  const message = String(error?.message ?? error);
  const start = message.indexOf("{");
  let reason = null;
  if (start >= 0) {
    try { reason = JSON.parse(message.slice(start))?.reason ?? null; } catch { reason = null; }
  }
  const step = reason ? RETRY_NEXT_STEP[reason] : null;
  if (step) return `CANNOT RETRY ${ticketId} · ${reason}\n${step}`;
  if (reason) return `CANNOT RETRY ${ticketId} · ${reason}\n${message}`;
  return `CANNOT RETRY ${ticketId} · the board did not name a reason\n${message}`;
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

/** WHAT: Names the one gate that keeps a ticket from being claimed, or null. WHY: `show` and `approve` must answer "can a worker take this?" identically; a second copy would drift and tell two agents different stories. */
export function claimBlocker(ticket) {
  const approval = ticket?.productApproval?.state ?? "unknown";
  if (ticket?.safety?.executionBlocked === true) return "safety hold";
  if (approval !== "approved") return `approval ${approval}`;
  if (ticket?.assignment) return "already assigned";
  if (ticket?.status !== "ready") return `status ${ticket?.status ?? "unknown"}`;
  return null;
}

/** WHAT: States whether a ticket can now be claimed, and by whose action if not. WHY: A mutation that opened one gate must not read as if it opened them all; a safety hold releases only through the human namespace, so retrying is the wrong next move. */
export function claimVerdict(ticketId, ticket) {
  const blocker = claimBlocker(ticket);
  if (!blocker) return "CLAIMABLE yes";
  if (blocker !== "safety hold") return `CLAIMABLE no (${blocker})`;
  return `CLAIMABLE no (safety hold) · agents cannot release it`
    + `\nNEEDS HUMAN POST /api/human/tickets/${ticketId}/safety-approval`;
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
  const claimBlock = claimBlocker(ticket);
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

/**
 * The board rejects a completion receipt WHOLE: `completionReceiptInput` returns
 * null if any field fails, so an over-long summary and a malformed merge URL come
 * back as the same `invalid-completion-receipt`. Two agents lost a delivery to that
 * today, one concluding the receipt could not be booked at all. Limits mirror the
 * board's own `cleanText` bounds — summary 2000, evidence label 500.
 */
const RECEIPT_FIELD_LIMITS = Object.freeze({
  summary: 2_000, tests: 500, deploy: 500, live: 500,
});

/** WHAT: Rejects over-long receipt fields by name before the board can blame the whole receipt. WHY: An unattributable 400 costs more to debug than the flag it came from. */
export const assertReceiptFieldLengths = (fields) => {
  for (const [field, limit] of Object.entries(RECEIPT_FIELD_LIMITS)) {
    const value = fields[field];
    if (value == null) continue;
    const length = String(value).trim().length;
    if (length > limit) {
      throw new Error(`--${field} is ${length} chars; the board rejects the whole receipt over `
        + `${limit}. Shorten it and put the detail in a ticket comment.`);
    }
  }
};

/** WHAT: Defines one explicit board operation for the calling pane. WHY: Keeps the board additive instead of a mandatory broker. */
export async function runWorkCommand(argv, dependencies = {}) {
  const parsed = parseWorkArgs(argv);
  if (parsed.help) return usage();
  const sender = dependencies.sender;
  if (!sender) throw new Error("amux work must run inside a configured agent pane");
  const project = projectForWorkSender(sender, parsed.options.project);
  if (!project) throw new Error("cannot infer Suggestions project; pass --project ID");
  const baseUrl = parsed.options["base-url"] ?? dependencies.baseUrl ?? process.env.SUGGEST_BASE_URL;
  if (!dependencies.client && !baseUrl) {
    throw new Error("Suggestions is not configured; set SUGGEST_BASE_URL or pass --base-url");
  }
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
  if (action === "retry") {
    const ticketId = parsed.positional[0];
    if (!ticketId) throw new Error("retry requires a ticket id");
    // Same ticket, same raw report: the board refuses unless a triage actually
    // failed, and the call is revision-guarded and dedupe-keyed, so a replay is
    // a no-op rather than a second triage.
    try {
      const result = await client.mutate(
        `/api/agent/tickets/${encodeURIComponent(ticketId)}/triage-retry?project=${encodeURIComponent(project)}`,
        "POST", { mutationId: randomUUID() });
      const ticket = result?.ticket ?? result;
      return `RETRYING ${ticketId} \u00b7 ${ticket?.status ?? "triaging"} \u00b7 same ticket id, same raw report`
        + `\nNEXT amux work show ${ticketId}`;
    } catch (error) {
      throw new Error(retryRefusal(ticketId, error));
    }
  }
  if (action === "approve") {
    const ticketId = parsed.positional[0];
    if (!ticketId) throw new Error("approve requires a ticket id");
    const detail = await client.read(`/api/tickets/${ticketId}?project=${encodeURIComponent(project)}`);
    const ticket = detail?.ticket;
    if (ticket?.productApproval?.state === "approved") {
      return `APPROVED ${ticketId} (already)\n${claimVerdict(ticketId, ticket)}`;
    }
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
    // Re-read rather than predict: the product gate is one of several, and the
    // caller's next move depends on the state that actually landed. Falling back
    // to the pre-mutation ticket would report the approval we just cleared as a
    // live blocker, so an unreadable board says so instead of guessing.
    const settled = await client.read(
      `/api/tickets/${ticketId}?project=${encodeURIComponent(project)}`);
    return `APPROVED ${ticketId}\n${settled?.ticket
      ? claimVerdict(ticketId, settled.ticket)
      : "CLAIMABLE unverified (re-read returned no ticket)"}`;
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
    assertReceiptFieldLengths({ summary: parsed.options.summary, tests,
      deploy: parsed.options.deploy, live: parsed.options.live });
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
