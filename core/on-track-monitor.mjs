import { ON_TRACK_CHECKS, validateOnTrackReceipt } from "./on-track-validation.mjs";

/** WHAT: Names the persisted scheduler state. WHY: Prevents bridge restarts from losing deadlines and uncertain delivery outcomes. */
export const ON_TRACK_STATE = "on_track_v1";
const HOUR = 3600000, DEADLINE = 1200000;
const iso = at => new Date(at).toISOString();

/** WHAT: Formats the fixed reviewer request and frozen input identities. WHY: Keeps review deadlines independent of an agent's memory. */
export function onTrackReminder(project, cycle) {
  return `On-track ${project.id}, cycle ${cycle.id}. Receipt due ${iso(cycle.deadline)}. Read the actual files and owner logs; no self-rating.\n`
    + Object.entries(ON_TRACK_CHECKS).map(([id, text]) => `${id}: ${text}`).join("\n")
    + `\nLive paths: ${project.livePaths.join(", ")}. No new paid run. TASKS ${project.root}/${project.ledger}@${cycle.tip || "UNKNOWN"}.\n`
    + `Read frozen asks and previous deviations: amux on-track show ${project.id}. Evidence/schema: amux on-track --help.\n`
    + `Submit JSON: amux on-track submit ${project.id} /absolute/receipt.json. Missing evidence or UNKNOWN is a deviation. Missing/invalid receipts escalate to ${project.dispatcher} and ${project.reviewer}.`;
}

/** WHAT: Builds one durable logical hourly schedule per configured project. WHY: Prevents missed reviews from disappearing and uncertain sends from repeating. */
export function createOnTrackMonitor({ state, projects, snapshot, send, notifyHuman = null, now = Date.now,
  commands = () => ({}), lookup = () => null, log = message => console.warn(message) }) {
  const mutate = fn => state.updateKey(ON_TRACK_STATE, old => { const data = old || { projects: {}, history: [], commands: {}, daily: {} }; fn(data); return data; });
  const get = id => state.get(ON_TRACK_STATE)?.projects[id];
  const findCycle = (data, project, cycle) => data.projects[project.id]?.cycle?.id === cycle.id
    ? data.projects[project.id].cycle : data.history.find(c => c.id === cycle.id);
  let running = null;
  const humanReceipt = result => ({ status: result?.sent === true ? "sent" : result?.outcome === "not-sent" ? "not-sent" : "unknown", receipt: result });

  async function deliver(project, cycle, role, target, text) {
    const key = `${cycle.id}:${role}`;
    if (findCycle(state.get(ON_TRACK_STATE), project, cycle)?.deliveries?.[role]) return;
    mutate(data => { findCycle(data, project, cycle).deliveries[role] = { status: "attempting", at: iso(now()), key }; });
    try {
      const result = await send(target, text, key);
      mutate(data => { findCycle(data, project, cycle).deliveries[role] = { status: "queued", at: iso(now()), key, jobId: result.id }; });
    } catch (error) {
      mutate(data => { findCycle(data, project, cycle).deliveries[role] = { status: "unknown", at: iso(now()), key, error: error.message }; });
      log(`on-track ${key}: send outcome unknown: ${error.message}`);
    }
  }

  async function escalate(project, cycle, reason) {
    const text = `On-track deviation ${project.id}, ${cycle.id}: ${reason}. Reviewer ${project.reviewer}; deadline ${iso(cycle.deadline)}. Read amux on-track show ${project.id}. Resolve with an owner/action; no resend or account move.`;
    await deliver(project, cycle, "dispatcher", project.dispatcher, text);
    await deliver(project, cycle, "reviewer-deviation", project.reviewer, text);
  }

  async function start(project, at, scheduledAt = at) {
    let input;
    try { input = await snapshot(project, at); }
    catch (error) { input = { tip: null, asks: [], sourceError: error.message }; }
    const previous = get(project.id)?.lastReview || null;
    const cycle = { ...input, id: `${project.id}:${at}`, at, scheduledAt, missedHours: Math.floor((at - scheduledAt) / HOUR),
      deadline: at + DEADLINE, previous, deliveries: {}, status: "waiting" };
    mutate(data => {
      const old = data.projects[project.id];
      if (old?.cycle) data.history.push({ project: project.id, ...old.cycle });
      data.projects[project.id] = { ...old, config: project, nextAt: scheduledAt + (Math.floor((at - scheduledAt) / HOUR) + 1) * HOUR, cycle };
    });
    await deliver(project, cycle, "reminder", project.reviewer, onTrackReminder(project, cycle));
    if (input.sourceError) await escalate(project, cycle, `source UNKNOWN: ${input.sourceError}`);
  }

  async function tickInner() {
    const data = state.get(ON_TRACK_STATE);
    for (const cycle of [...(data?.history || []), ...Object.values(data?.projects || {}).map(p => p.cycle)]) {
      for (const [role, receipt] of Object.entries(cycle.deliveries || {})) {
        if (!["queued", "unknown", "attempting"].includes(receipt.status)) continue;
        const job = await lookup(receipt.key, receipt.jobId);
        if (!job) continue;
        if (receipt.transportStatus === job.status && receipt.jobId === job.id) continue;
        mutate(next => {
          const actual = Object.values(next.projects).map(p => p.cycle).find(c => c.id === cycle.id) || next.history.find(c => c.id === cycle.id);
          actual.deliveries[role] = { ...receipt, jobId: job.id, transportStatus: job.status,
            status: job.status === "acknowledged" ? "delivered" : ["cancelled", "dead_letter"].includes(job.status) ? "not-delivered" : "queued",
            acknowledgedAt: job.acknowledgedAt || null };
        });
      }
    }
    let configured;
    try { configured = projects(); }
    catch (error) {
      for (const record of Object.values(state.get(ON_TRACK_STATE)?.projects || {})) {
        if (record.config && record.cycle) await escalate(record.config, record.cycle, `project configuration unreadable: ${error.message}`);
      }
      throw error;
    }
    for (const project of configured) {
      let record = get(project.id);
      const cycle = record?.cycle;
      if (cycle && !cycle.review && now() >= cycle.deadline) {
        mutate(data => {
          const current = data.projects[project.id].cycle;
          current.status = "missing";
          current.events ||= [];
          if (!current.events.some(e => e.kind === "missing")) current.events.push({ kind: "missing", at: now() });
        });
        await escalate(project, cycle, "receipt absent or invalid after 20 minutes");
      }
      if (project.enabled !== false && (!record || now() >= record.nextAt)) {
        if (record) await start(project, now(), record.nextAt);
        else await start(project, now());
      }
      record = get(project.id);
      if (record?.cycle.status === "invalid") await escalate(project, record.cycle, "invalid receipt");
    }
    await dailySummary();
  }

  async function dailySummary() {
    if (!notifyHuman) return;
    const day = iso(now()).slice(0, 10), data = state.get(ON_TRACK_STATE);
    if (!data) return;
    const previousDay = data.day;
    if (!previousDay) { mutate(d => { d.day = day; }); return; }
    if (previousDay === day || data.daily[previousDay]) return;
    mutate(d => { d.daily[previousDay] = { status: "attempting" }; d.day = day; });
    try {
      const end = Date.parse(`${previousDay}T00:00:00Z`) + 86400000 - 1;
      const result = await notifyHuman(`On-track ${previousDay}: ${onTrackStatistics(data, end).map(p => `${p.project}: ${p.deviations24h} deviations; ask-to-row ${p.askToRowMs ?? "unknown"} ms; waiting without stop ${p.waitWithoutStopMs ?? "unknown"} ms`).join("; ")}`, `on-track:daily:${previousDay}`);
      mutate(d => { d.daily[previousDay] = humanReceipt(result); });
    } catch (error) { mutate(d => { d.daily[previousDay] = { status: "unknown", error: error.message }; }); }
  }

  return {
    tick: () => { if (!running) running = tickInner().finally(() => { running = null; }); return running; },
    async submit(project, receipt, actor) {
      if (actor !== project.reviewer) throw Error("receipt requires configured reviewer identity");
      const cycle = get(project.id)?.cycle;
      if (!cycle || cycle.review) throw Error("no pending cycle; an accepted receipt is immutable");
      const review = validateOnTrackReceipt({ project, cycle, receipt, at: now(), commands: commands() });
      if (cycle.sourceError) { review.valid = false; review.errors.push(`source UNKNOWN: ${cycle.sourceError}`); }
      mutate(data => {
        const record = data.projects[project.id];
        if (record.cycle.id !== cycle.id || record.cycle.review) throw Error("review cycle changed while validating; no receipt accepted");
        record.cycle.receipt = receipt;
        record.cycle.validation = review;
        record.cycle.submissions ||= [];
        record.cycle.submissions.push({ at: now(), receipt, review });
        record.cycle.events ||= [];
        if (!review.valid) record.cycle.events.push({ kind: "invalid", at: now(), errors: review.errors });
        record.cycle.status = review.valid ? "reviewed" : "invalid";
        if (review.valid) { record.cycle.review = review; record.lastReview = review; }
      });
      if (!review.valid) await escalate(project, cycle, `invalid receipt: ${review.errors.join("; ")}`);
      else if (review.deviations.length) {
        for (const owner of new Set(review.deviations.map(d => d.owner))) {
          await deliver(project, cycle, `owner:${owner}`, owner,
            `On-track ${project.id}: ${review.deviations.filter(d => d.owner === owner).map(d => `${d.check}/${d.row}: ${d.action}`).join("; ")}`);
        }
        const impact = receipt.userOrMoneyImpact || receipt.deviations?.some(d => ["user", "money"].includes(d.impact))
          || receipt.live?.some(path => path.result === "FAIL");
        if (impact && notifyHuman && !get(project.id).cycle.human) {
          mutate(data => { data.projects[project.id].cycle.human = { status: "attempting" }; });
          try {
            const result = await notifyHuman(`On-track ${project.id}: user/money impact. ${review.deviations.map(d => `${d.row}: ${d.action} (${d.owner})`).join("; ")}`, `${cycle.id}:human`);
            mutate(data => { data.projects[project.id].cycle.human = humanReceipt(result); });
          } catch (error) { mutate(data => { data.projects[project.id].cycle.human = { status: "unknown", error: error.message }; }); }
        }
      }
      return review;
    },
  };
}

/** WHAT: Returns observed review deviations and explicit timing statistics. WHY: Keeps unknown timings separate from measured work. */
export function onTrackStatistics(data, at = Date.now()) {
  return Object.entries(data?.projects || {}).map(([project, record]) => {
    const cycles = [...(data.history || []).filter(c => c.project === project), record.cycle].filter(c => c && c.at <= at && at - c.at <= 86400000);
    const latency = cycles.flatMap(c => c.review?.askLatencyMs || []).filter(m => m.ms !== null);
    const waits = cycles.flatMap(c => c.review?.deviations || []).filter(d => d.waitingSince && Number.isFinite(Date.parse(d.waitingSince)));
    return { project, status: record.cycle.status, deadline: iso(record.cycle.deadline),
      deviations24h: cycles.reduce((n, c) => n + (c.review?.deviations.length || 0)
        + (c.events?.some(e => ["missing", "invalid"].includes(e.kind)) || ["missing", "invalid"].includes(c.status) ? 1 : 0), 0),
      askToRowMs: latency.length ? Math.round(latency.reduce((n, a) => n + a.ms, 0) / latency.length) : null,
      waitWithoutStopMs: waits.length ? Math.max(...waits.map(w => Math.max(0, at - Date.parse(w.waitingSince)))) : null };
  });
}
