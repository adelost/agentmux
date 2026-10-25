import { Session } from "node:inspector";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** WHAT: Writes one requested CPU capture. WHY: Keeps incident profiling local and separate from message contents. */
export function captureBridgeCpu() {
  const session = new Session();
  const log = error => console.warn(`CPU diagnostic failed: ${error.message}`);
  try { session.connect(); }
  catch (error) { log(error); return; }
  session.post("Profiler.enable", error => {
    if (error) { log(error); session.disconnect(); return; }
    session.post("Profiler.start", error => {
      if (error) { log(error); session.disconnect(); return; }
      setTimeout(() => session.post("Profiler.stop", (error, result) => {
        try {
          if (error) throw error;
          const dir = join(homedir(), ".agentmux", "diagnostics");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, `cpu-${process.pid}.cpuprofile`);
          writeFileSync(path, JSON.stringify(result.profile), { mode: 0o600, flag: "wx" });
          console.log(`CPU diagnostic saved: ${path}`);
        } catch (error) { log(error); }
        finally { session.disconnect(); }
      }), 15000).unref();
    });
  });
}
