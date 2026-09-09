import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const homes = [];
const moduleUrl = new URL("../core/dream-lock.mjs", import.meta.url).href;
function child(home) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireDreamLock } from ${JSON.stringify(moduleUrl)};
    const lock = acquireDreamLock();
    console.log(JSON.stringify({ acquired: lock.acquired }));
    if (lock.acquired) { process.stdin.resume(); process.stdin.once('data', () => { lock.release(); process.exit(); }); }
  `], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let text = "";
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on("data", (data) => { text += data; const match = text.match(/\{"acquired":(true|false)\}/u); if (match) resolve(match[1] === "true"); });
    proc.once("error", reject); proc.once("exit", () => { if (!text.includes('"acquired"')) reject(new Error(text)); });
  });
  return { proc, ready };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
describe("real process Dream lock", () => {
  it("has one owner across concurrent opens and recovers after the holder dies", async () => {
    const home = mkdtempSync(join(tmpdir(), "dream-flock-")); homes.push(home);
    const a = child(home), b = child(home);
    const [aa, bb] = await Promise.all([a.ready, b.ready]); expect(Number(aa) + Number(bb)).toBe(1);
    const holder = aa ? a : b;
    const exited = once(holder.proc, "exit"); holder.proc.kill("SIGKILL"); await exited;
    const c = child(home); expect(await c.ready).toBe(true);
    const closed = once(c.proc, "exit"); c.proc.stdin.write("release"); await closed;
    const d = child(home); expect(await d.ready).toBe(true);
    const done = once(d.proc, "exit"); d.proc.stdin.write("release"); await done;
  });
});
