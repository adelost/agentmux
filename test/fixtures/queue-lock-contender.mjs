// Pauses after reading a dead legacy owner, with the real queue otherwise intact.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalRead = fs.readFileSync;
let intercepted = false;
fs.readFileSync = (...args) => {
  const value = originalRead(...args);
  if (!intercepted && String(value).startsWith('{"pid":2147483647,"token":"stale-probe"')) {
    intercepted = true;
    process.send({ stage: "stale-read" });
    const byte = Buffer.alloc(1), deadline = Date.now() + 4_000;
    let resumed = false;
    while (Date.now() < deadline) {
      try { if (fs.readSync(3, byte, 0, 1, null) === 1) { resumed = true; break; } }
      catch (error) { if (error.code !== "EAGAIN") throw error; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (!resumed) throw new Error("queue probe coordinator timeout");
  }
  return value;
};
syncBuiltinESMExports();
const { createDeliveryQueue } = await import("../../core/delivery-queue.mjs");
const lease = createDeliveryQueue({ rootDir: process.argv[2] }).acquireSessionLease("probe");
process.send({ stage: "acquired", acquired: !!lease });
process.on("message", () => { lease?.release(); process.exit(0); });
setTimeout(() => { lease?.release(); process.exit(2); }, 5_000).unref();
