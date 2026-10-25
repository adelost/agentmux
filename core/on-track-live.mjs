import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const read = path => JSON.parse(readFileSync(path, "utf8"));
const sha = data => createHash("sha256").update(data).digest("hex");
const withinHour = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= 3600000;

/** WHAT: Reads candidate terminal publications instead of guessing by release number. WHY: Keeps qualified-but-unpublished and failed runs out of live evidence. */
export function onTrackPublications(project) {
  const spec = project.liveEvidence;
  if (!spec?.root || !["huset", "cutkit"].includes(spec.kind)) throw Error("project has no latest-live receipt adapter");
  const candidates = [];
  for (const dir of readdirSync(spec.root, { withFileTypes: true })) {
    if (!dir.isDirectory() || (spec.prefix && !dir.name.startsWith(spec.prefix))) continue;
    const root = join(spec.root, dir.name);
    const file = spec.kind === "huset" ? join(root, "qualified", "publish-result.json") : join(root, "release.json");
    if (!existsSync(file)) continue;
    try {
      const result = read(file);
      const passed = spec.kind === "huset" ? result.deployExit === 0 && result.bytesExit === 0 && result.liveExit === 0 : result.smoke?.ok === true;
      const at = spec.kind === "huset" ? result.endedAt : result.at;
      if (passed && Number.isFinite(Date.parse(at))) candidates.push({ root, file, result, at });
    } catch { /* A partial publication is not a terminal live receipt. */ }
  }
  return candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

async function currentBundles(project, fetcher) {
  return Object.fromEntries(await Promise.all(project.liveEvidence.sites.map(async site => {
    const page = await fetcher(site, { signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store" });
    if (!page.ok) throw Error(`live title HTTP${page.status}`);
    const html = await page.text(), bundle = html.match(/src=["']([^"']*\/assets\/[^"']+\.js)["']/u)?.[1];
    if (!bundle) throw Error("live bundle reference missing");
    const url = new URL(bundle, site), asset = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store" });
    if (!asset.ok) throw Error(`live bundle HTTP${asset.status}`);
    return [new URL(site).host, { bundle: url.pathname, sha256: sha(Buffer.from(await asset.arrayBuffer())) }];
  })));
}

/** WHAT: Checks native Huset title, lobby and board receipts from one deployed source. WHY: Prevents a successful publication from implying unmeasured game flows. */
export function qualifyHusetLive(receipt, publication, project, now) {
  const hosts = Object.values(receipt.hosts || {}), game = receipt.game || {}, calls = game.calls || [];
  const actions = ["create", "join", "configure", "ready", "start"];
  const clean = value => Array.isArray(value) && value.length === 0;
  const title = hosts.length === project.liveEvidence.sites.length && hosts.every(h => clean(h.errors) && h.picture && existsSync(h.picture));
  const lobby = actions.every(action => calls.some(c => String(c.path).endsWith(`/${action}`) && c.status >= 200 && c.status < 300))
    && calls.every(c => c.status >= 200 && c.status < 300);
  const board = game.aiSeats === 0 && clean(game.errors) && Number.isFinite(game.boardSeconds) && game.picture && existsSync(game.picture);
  const passed = { "title-bundles-390": title, "lobby-api": lobby, "board-hud-390": board };
  return project.livePaths.map(path => ({ path, at: publication.at,
    result: !withinHour(publication.at, now) ? "UNKNOWN" : passed[path] ? "PASS" : "FAIL",
    reason: !withinHour(publication.at, now) ? "existing-live-proof-older-than-60min" : passed[path] ? "native-live-receipt-qualified" : "native-path-proof-incomplete-or-red" }));
}

/** WHAT: Resolves a current deployed receipt and its actual observed main paths. WHY: Keeps C4 on current live bytes without launching browsers, paid calls or a new game. */
export async function readLatestOnTrackLive(project, { fetcher = fetch, now = Date.now(), deployment = null } = {}) {
  try {
    const candidates = onTrackPublications(project);
    if (project.liveEvidence.kind === "huset") {
      const actual = await currentBundles(project, fetcher);
      for (const publication of candidates) {
        const qualified = join(publication.root, "qualified"), bytes = read(join(qualified, "live-bytes.json"));
        if (!Object.entries(actual).every(([host, value]) => bytes.hosts?.[host]?.sha256 === value.sha256 && bytes.hosts[host].bundle === value.bundle)) continue;
        const file = join(qualified, "live", "receipt.json"), receipt = read(file);
        return { project: project.id, readAt: new Date(now).toISOString(), publication: { path: publication.file, at: publication.at,
          source: publication.result.correctedSource || publication.result.workerSource, receipt: file, receiptSha256: sha(readFileSync(file)), actualBundles: actual },
        live: qualifyHusetLive(receipt, publication, project, now) };
      }
      throw Error("no successful native publication receipt matches both currently live bundles");
    }
    let versions = deployment;
    if (!versions) {
      const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" };
      delete env.CLOUDFLARE_API_TOKEN;
      versions = JSON.parse(execFileSync(project.liveEvidence.wrangler, ["deployments", "list", "--name", project.liveEvidence.workerName, "--json"],
        { cwd: project.liveEvidence.cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    }
    const current = [...versions].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
    if (current?.versions?.length !== 1 || current.versions[0].percentage !== 100) throw Error("current live Worker is unknown or split");
    const worker = current.versions[0].version_id, publication = candidates.find(c => c.result.worker === worker);
    if (!publication) throw Error("current live Worker has no terminal release receipt");
    const sidecar = join(publication.root, "main-live.json");
    const proof = existsSync(sidecar) ? read(sidecar) : publication.result;
    const native = proof.worker === worker && Array.isArray(proof.live) ? proof.live : [];
    return { project: project.id, readAt: new Date(now).toISOString(), publication: { path: publication.file, at: publication.at, worker, source: publication.result.source },
      live: project.livePaths.map(path => {
        const p = native.find(p => p.path === path);
        return p && withinHour(p.at, now) ? p : { path, at: publication.at, result: "UNKNOWN", reason: "latest-live-public-smoke-does-not-prove-this-main-path" };
      }) };
  } catch (error) {
    return { project: project.id, readAt: new Date(now).toISOString(), error: error.message,
      live: project.livePaths.map(path => ({ path, at: null, result: "UNKNOWN", reason: "latest-live-source-unavailable" })) };
  }
}
