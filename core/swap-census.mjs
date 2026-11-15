import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";

const run = promisify(execFile);

/** WHAT: Returns pane process trees by resident and swapped memory. WHY: Keeps pressure reports attributable to pane owners. */
export async function paneMemoryCensus(socket) {
  const panes = new Map();
  const { stdout } = await run("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_pid} #{session_name}:#{pane_index}"], { timeout: 10_000 });
  for (const line of stdout.trim().split("\n")) {
    const match = /^(\d+) (.+)$/u.exec(line); if (match) panes.set(Number(match[1]), match[2]);
  }
  const processes = new Map();
  const ids = (await readdir("/proc")).filter(name => /^\d+$/u.test(name));
  await Promise.all(ids.map(async id => {
    try {
      const s = await readFile(`/proc/${id}/status`, "utf8");
      const get = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, "mu").exec(s)?.[1] || 0);
      processes.set(Number(id), { parent: get("PPid"), rss: get("VmRSS"), swap: get("VmSwap") });
    } catch { /* Process exited during the census. */ }
  }));
  const groups = new Map();
  for (const [pid, process] of processes) {
    let parent = pid, depth = 0;
    while (processes.has(parent) && !panes.has(parent) && depth++ < 60) parent = processes.get(parent).parent;
    const name = panes.get(parent) || "outside panes", group = groups.get(name) || { rss: 0, swap: 0 };
    group.rss += process.rss; group.swap += process.swap; groups.set(name, group);
  }
  return [...groups].sort((a, b) => b[1].rss + b[1].swap - a[1].rss - a[1].swap).slice(0, 10)
    .map(([name, g]) => `${name}: RAM ${(g.rss / 1048576).toFixed(2)} GiB, swap ${(g.swap / 1048576).toFixed(2)} GiB`);
}
