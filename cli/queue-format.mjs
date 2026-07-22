// Queue display formatting for `amux queue` (extracted from cli/commands.mjs
// to keep that dispatcher under its line cap). Pure presentation over the
// durable delivery queue: no tmux, no broker decisions.

import { stripAnsi } from "../lib.mjs";
import { truncate } from "./format.mjs";
import { needsDeliveryTerminalNotice, TERMINAL_DELIVERY_STATES } from "../core/delivery-queue.mjs";

function queueAge(createdAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Number(createdAt || now)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function queueDisplayState(job) {
  const state = job.status === "acknowledged" ? "delivered" : String(job.status || "unknown");
  return job.cancelRequestStatus === "requested" ? `${state}+cancel_requested` : state;
}

function queueReason(job) {
  if (job.cancelRequestStatus === "requested") {
    return `cancel requested: ${job.cancelRequestedReason || "reason unavailable"}`;
  }
  return job.lastReason || job.cancelRequestLastReason || "";
}

function queueCell(value, max) {
  const printable = stripAnsi(String(value || ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(printable, max);
}

/** WHAT: Collects unfinished jobs plus terminal receipts still awaiting notice. WHY: Separates operational queue truth from retained delivery history. */
export function listDeliveryQueueJobs(queue, { includeTerminal = false } = {}) {
  const targets = includeTerminal ? queue.allTargets() : queue.targets();
  return targets.flatMap(({ agentName, pane }) => queue.list(agentName, pane))
    .filter((job) => includeTerminal
      || !TERMINAL_DELIVERY_STATES.has(job.status)
      || needsDeliveryTerminalNotice(job)
      || job.cancelRequestStatus === "requested")
    .sort((a, b) => {
      const byCreated = Number(a.createdAt || 0) - Number(b.createdAt || 0);
      return byCreated || String(a.id).localeCompare(String(b.id));
    });
}

/** WHAT: Maps queue jobs to printable table rows. WHY: Keeps ANSI and control noise out of operator-facing queue output. */
export function deliveryQueueDisplayRows(jobs, { now = Date.now() } = {}) {
  return jobs.map((job) => ({
    jobId: String(job.id),
    target: `${job.agentName}:${job.pane}`,
    age: queueAge(job.createdAt, now),
    state: queueDisplayState(job),
    attempts: Number(job.attempts || 0),
    reason: queueCell(queueReason(job), 52),
    preview: queueCell(job.text, 60),
  }));
}

/** WHAT: Formats queue rows as an aligned plain-text table. WHY: Keeps queue rendering separate from durable queue storage. */
export function formatDeliveryQueueTable(rows, { total = rows.length } = {}) {
  if (!rows.length) return "Delivery queue is empty.";
  const headers = {
    jobId: "jobId",
    target: "target",
    age: "age",
    state: "state",
    attempts: "attempts",
    reason: "reason",
    preview: "preview",
  };
  const keys = Object.keys(headers);
  const widths = Object.fromEntries(keys.map((key) => [
    key,
    Math.max(headers[key].length, ...rows.map((row) => String(row[key]).length)),
  ]));
  const line = (row) => keys.map((key) => String(row[key]).padEnd(widths[key])).join("  ").trimEnd();
  const output = [line(headers), ...rows.map(line)];
  if (total > rows.length) output.push(`… ${total - rows.length} more; raise --limit to show them.`);
  return output.join("\n");
}

/** WHAT: Stores a durable cancellation request for one delivery job. WHY: Prevents CLI cancellation requests from bypassing broker adjudication. */
export function requestDeliveryQueueCancellation(queue, { id, reason, requestedBy = "cli" }) {
  const before = queue.findById(id);
  if (!before) throw new Error(`delivery job ${id} not found`);
  const job = queue.requestCancellation(id, { reason, requestedBy });
  const newlyRequested = !before.cancelRequestStatus && job.cancelRequestStatus === "requested";
  return { job, newlyRequested };
}
