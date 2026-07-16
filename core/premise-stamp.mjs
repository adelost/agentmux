// Machine-verifiable state projection for inter-agent briefs.
//
// A premise stamp is captured by the sender-side tool, never typed into the
// brief. The delivery broker reprojects the same selectors immediately before
// the first physical send and refuses to inject a brief whose basis changed.

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { lstatSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

export const PREMISE_STAMP_SCHEMA_VERSION = 1;
export const PREMISE_STAMP_PRODUCER = "amux.premise-proof.v1";
const LIVE_SUGGESTIONS = "https://suggest.v1d.io";
const TICKET_PROJECT = Object.freeze({ SRC: "source", SKY: "skydive", AI: "ai" });
const SHA = /^[0-9a-f]{40}$/u;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function projectionMatches(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => projectionMatches(value, actual[index]));
  }
  if (isObject(expected)) {
    return isObject(actual) && Object.keys(expected)
      .every((key) => projectionMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

function command(execFile, file, args, options = {}) {
  return String(execFile(file, args, {
    encoding: "utf8", timeout: 8_000, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], ...options,
  })).trim();
}

function optionalCommand(execFile, file, args, options = {}) {
  try { return command(execFile, file, args, options); } catch { return null; }
}

function cleanRemote(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return String(value).replace(/^(?:[^@\s]+@)?([^:\s]+):/u, "$1:");
  }
}

function githubSlug(remote) {
  const match = String(remote).match(/github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  return match ? `${match[1]}/${match[2]}` : null;
}

function asGithubSlug(value) {
  return githubSlug(value) || (/^[^/\s]+\/[^/\s]+$/u.test(String(value)) ? String(value) : null);
}

function baseRef(execFile, root) {
  const remote = optionalCommand(execFile, "git", ["-C", root, "ls-remote", "--symref", "origin", "HEAD"]);
  const advertised = remote?.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu)?.[1];
  if (advertised) return advertised;
  const symbolic = optionalCommand(execFile, "git",
    ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic?.startsWith("origin/")) return symbolic.slice("origin/".length);
  for (const candidate of ["main", "master"]) {
    if (optionalCommand(execFile, "git", ["-C", root, "show-ref", "--verify", "--quiet",
      `refs/remotes/origin/${candidate}`]) != null) return candidate;
  }
  return null;
}

export function inspectRepository(path, { execFile = execFileSync } = {}) {
  const root = optionalCommand(execFile, "git", ["-C", resolve(path), "rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const headSha = command(execFile, "git", ["-C", root, "rev-parse", "HEAD"]);
  const branch = optionalCommand(execFile, "git", ["-C", root, "symbolic-ref", "--short", "HEAD"])
    || "(detached)";
  const rawRemote = optionalCommand(execFile, "git", ["-C", root, "remote", "get-url", "origin"]);
  const baseRefName = rawRemote ? baseRef(execFile, root) : null;
  if (rawRemote && !baseRefName) {
    throw new Error("premise capture: origin default branch cannot be resolved");
  }
  const remoteLine = rawRemote && baseRefName
    ? optionalCommand(execFile, "git", ["-C", root, "ls-remote", "--exit-code", "origin",
      `refs/heads/${baseRefName}`]) : null;
  if (rawRemote && !remoteLine) {
    throw new Error(`premise capture: origin/${baseRefName} cannot be verified`);
  }
  const baseHeadSha = remoteLine?.split(/\s+/u)[0] || null;
  if (!SHA.test(headSha) || (baseHeadSha != null && !SHA.test(baseHeadSha))) {
    throw new Error("premise capture: repository returned an invalid commit identity");
  }
  return {
    selector: { root },
    basis: {
      repository: githubSlug(rawRemote) || cleanRemote(rawRemote || root),
      branch,
      headSha,
      baseRefName,
      baseHeadSha,
    },
  };
}

export function referencedTicketSelectors(text) {
  const matches = [...String(text).matchAll(/\b((SRC|SKY|AI)-[0-9]{4,})\b/gu)];
  return [...new Map(matches.map((match) => [match[1], {
    projectId: TICKET_PROJECT[match[2]], ticketId: match[1],
  }])).values()];
}

export function referencedPullRequests(text) {
  const value = String(text);
  const explicit = [...value.matchAll(/\b(?:PR|pull request)\s*#([1-9][0-9]*)\b/giu)]
    .map((match) => Number(match[1]));
  const contextual = [...value.matchAll(
    /\b(?:rebase|review|merge|merged|mergad|draft|din)\b[^#\n]{0,32}#([1-9][0-9]*)\b/giu,
  )].map((match) => Number(match[1]));
  return [...new Set([...explicit, ...contextual])];
}

export function referencedBaseShas(text) {
  return [...new Set([...String(text).matchAll(
    /\b(?:base|main|origin\/main|rebase|onto|sha|head)\b[^\n0-9a-f]{0,32}([0-9a-f]{7,40})\b/giu,
  )].map((match) => match[1].toLowerCase()))];
}

function readCredential(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid?.() != null
    && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error("premise capture: Suggestions read credential must be a private owned file");
  }
  const raw = readFileSync(path, "utf8");
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (raw !== value && raw !== `${value}\n`) {
    throw new Error("premise capture: Suggestions read credential must be one line");
  }
  if (!/^[A-Za-z0-9._~+/-]{32,512}=*$/u.test(value)) {
    throw new Error("premise capture: invalid Suggestions read credential");
  }
  return value;
}

async function fetchJson(url, { fetchImpl, token }) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  const value = await response.json();
  if (!response.ok || !isObject(value)) {
    throw new Error(`premise capture: ${url.pathname} returned HTTP ${response.status}`);
  }
  return value;
}

function boardProjection(detail) {
  const ticket = detail.ticket;
  const assignment = isObject(ticket?.assignment) ? ticket.assignment : null;
  const owner = Array.isArray(assignment?.members)
    ? assignment.members.find((member) => member?.role === "owner") : null;
  const ownerAgentId = owner?.agentId ?? assignment?.ownership?.owner?.agentId ?? null;
  if (!isObject(ticket) || typeof ticket.id !== "string" || !Number.isSafeInteger(ticket.revision)
    || typeof ticket.status !== "string" || !Number.isSafeInteger(ticket.updatedAt)
    || (assignment && (!Number.isSafeInteger(assignment.id)
      || !Number.isSafeInteger(assignment.generation) || typeof assignment.state !== "string"
      || typeof ownerAgentId !== "string"))) {
    throw new Error("premise capture: invalid ticket projection");
  }
  return {
    ticketId: ticket.id,
    revision: ticket.revision,
    status: ticket.status,
    updatedAt: ticket.updatedAt,
    assignment: assignment ? {
      id: assignment.id,
      generation: assignment.generation,
      state: assignment.state,
      ownerAgentId,
    } : null,
    mergeCandidates: Array.isArray(detail.mergeCandidates) ? detail.mergeCandidates : [],
    merges: Array.isArray(detail.merges) ? detail.merges : [],
    completionState: detail.completion?.state ?? null,
  };
}

async function inspectBoard(selectors, { baseUrl, fetchImpl, token }) {
  const rows = [];
  for (const selector of selectors) {
    const url = new URL(`/api/tickets/${encodeURIComponent(selector.ticketId)}`, baseUrl);
    url.searchParams.set("project", selector.projectId);
    rows.push({ projectId: selector.projectId,
      ...boardProjection(await fetchJson(url, { fetchImpl, token })) });
  }
  return rows;
}

function inspectPullRequests(numbers, repository, { execFile }) {
  if (!numbers.length) return [];
  if (!repository) throw new Error("premise capture: --premise-repo is required for a PR brief");
  return numbers.map((number) => {
    const raw = command(execFile, "gh", ["pr", "view", String(number), "--repo", repository,
      "--json", "number,state,headRefOid,baseRefOid,baseRefName,mergeStateStatus,updatedAt,url"]);
    const value = JSON.parse(raw);
    if (value.number !== number || !SHA.test(String(value.headRefOid))) {
      throw new Error(`premise capture: invalid PR #${number} projection`);
    }
    return value;
  });
}

export async function captureBriefPremise(text, {
  sender,
  repoPath = process.cwd(),
  observedAt = Date.now(),
  baseUrl = LIVE_SUGGESTIONS,
  readCredentialFile = resolve(homedir(), ".config/agent/suggestions-read-token"),
  readToken = null,
  fetchImpl = globalThis.fetch,
  execFile = execFileSync,
} = {}) {
  if (!sender) throw new Error("premise capture: exact sender pane is required");
  const tickets = referencedTicketSelectors(text);
  const prNumbers = referencedPullRequests(text);
  const baseShas = referencedBaseShas(text);
  if (tickets.length > 8 || prNumbers.length > 8 || baseShas.length > 8) {
    throw new Error("premise capture: a brief may reference at most eight tickets, PRs, and base SHAs");
  }
  const repository = inspectRepository(repoPath, { execFile });
  if (!repository && (prNumbers.length || baseShas.length)) {
    throw new Error("premise capture: --premise-repo must name the repository used by this brief");
  }
  const remoteHead = repository?.basis.baseHeadSha;
  const alreadyStale = remoteHead && baseShas.find((sha) => !remoteHead.startsWith(sha));
  if (alreadyStale) {
    throw new Error(`premise already stale: referenced base ${alreadyStale} is not current `
      + `${repository.basis.baseRefName} ${remoteHead}`);
  }
  const token = tickets.length ? (readToken || readCredential(readCredentialFile)) : null;
  const selectors = {
    sender,
    repository: repository?.selector ?? null,
    pullRequests: prNumbers,
    tickets,
  };
  const basis = {
    repository: repository?.basis ?? null,
    referencedBaseShas: baseShas,
    pullRequests: inspectPullRequests(prNumbers, asGithubSlug(repository?.basis.repository), { execFile }),
    board: tickets.length
      ? await inspectBoard(tickets, { baseUrl, fetchImpl, token }) : [],
  };
  const identity = { schemaVersion: PREMISE_STAMP_SCHEMA_VERSION,
    producer: PREMISE_STAMP_PRODUCER, observedAt, selectors, basis };
  if (Buffer.byteLength(JSON.stringify(identity), "utf8") > 64 * 1024) {
    throw new Error("premise capture: projected state exceeds 64 KiB");
  }
  return { ...identity, attestationHash: digest(identity) };
}

export async function verifyBriefPremise(stamp, {
  baseUrl = LIVE_SUGGESTIONS,
  readCredentialFile = resolve(homedir(), ".config/agent/suggestions-read-token"),
  readToken = null,
  fetchImpl = globalThis.fetch,
  execFile = execFileSync,
} = {}) {
  const keys = ["schemaVersion", "producer", "observedAt", "selectors", "basis",
    "attestationHash"];
  if (!isObject(stamp) || Object.keys(stamp).length !== keys.length
    || Object.keys(stamp).some((key) => !keys.includes(key))
    || stamp.schemaVersion !== PREMISE_STAMP_SCHEMA_VERSION
    || stamp.producer !== PREMISE_STAMP_PRODUCER
    || !Number.isSafeInteger(stamp.observedAt) || !isObject(stamp.selectors)
    || !isObject(stamp.basis) || stamp.attestationHash !== digest({
      schemaVersion: stamp.schemaVersion, producer: stamp.producer,
      observedAt: stamp.observedAt, selectors: stamp.selectors, basis: stamp.basis })) {
    return { status: "stale", mismatches: ["identity"] };
  }
  try {
    const repository = stamp.selectors.repository
      ? inspectRepository(stamp.selectors.repository.root, { execFile }) : null;
    const tickets = Array.isArray(stamp.selectors.tickets) ? stamp.selectors.tickets : [];
    const token = tickets.length ? (readToken || readCredential(readCredentialFile)) : null;
    const currentBasis = {
      repository: repository?.basis ?? null,
      referencedBaseShas: stamp.basis.referencedBaseShas,
      pullRequests: inspectPullRequests(stamp.selectors.pullRequests || [],
        asGithubSlug(repository?.basis.repository), { execFile }),
      board: tickets.length
        ? await inspectBoard(tickets, { baseUrl, fetchImpl, token }) : [],
    };
    const mismatches = [];
    for (const key of ["repository", "pullRequests", "board"]) {
      if (!projectionMatches(stamp.basis[key], currentBasis[key])) mismatches.push(key);
    }
    return mismatches.length ? { status: "stale", mismatches, currentBasis }
      : { status: "valid", mismatches: [] };
  } catch (error) {
    return { status: "unavailable", reason: error.message };
  }
}

export function premiseEnvelope(stamp) {
  if (!isObject(stamp) || stamp.schemaVersion !== PREMISE_STAMP_SCHEMA_VERSION
    || stamp.producer !== PREMISE_STAMP_PRODUCER
    || !/^sha256:[a-f0-9]{64}$/u.test(String(stamp.attestationHash || ""))) {
    throw new Error("premise envelope: valid premise stamp required");
  }
  return `[AMUX PREMISE ${stamp.producer} ${stamp.attestationHash} observedAt=${stamp.observedAt}]\n`
    + `${JSON.stringify(stamp)}\n[/AMUX PREMISE]`;
}
