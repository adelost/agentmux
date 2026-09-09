import { afterEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";

const roots = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "queue-lease-")); roots.push(path); return path; };
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("queue process lease", () => {
  it("cannot reap a newly acquired live owner after both processes observed a stale PID", async () => {
    const rootDir = root(), path = join(rootDir, ".session-probe.lock");
    writeFileSync(path, JSON.stringify({ pid: 2147483647, token: "stale-probe", acquiredAt: 1 }));
    const child = fork(fileURLToPath(new URL("./fixtures/queue-lock-contender.mjs", import.meta.url)), [rootDir], {
      stdio: ["ignore", "ignore", "inherit", "pipe", "ipc"],
    });
    const messages = [];
    child.on("message", (message) => messages.push(message));
    const waitFor = async (stage) => {
      const deadline = Date.now() + 4_500;
      while (Date.now() < deadline) {
        const message = messages.find((item) => item.stage === stage);
        if (message) return message;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`queue probe did not reach ${stage}`);
    };
    let lease;
    try {
      await waitFor("stale-read");
      lease = createDeliveryQueue({ rootDir }).acquireSessionLease("probe");
      child.stdio[3].write(Buffer.from([1]));
      const other = await waitFor("acquired");
      expect(Number(!!lease) + Number(other.acquired)).toBe(1);
    } finally {
      lease?.release();
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        if (child.connected) child.send("release");
        await exited;
      }
    }
  });

  it("preserves a live legacy holder and reuses the same inode across new releases", () => {
    const rootDir = root(), path = join(rootDir, ".session-probe.lock");
    const legacy = JSON.stringify({ pid: process.pid, token: "legacy" });
    writeFileSync(path, legacy);
    const queue = createDeliveryQueue({ rootDir });
    expect(queue.acquireSessionLease("probe")).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(legacy);
    writeFileSync(path, JSON.stringify({ pid: 2147483647, token: "dead" }));
    const inode = statSync(path).ino;
    const first = queue.acquireSessionLease("probe");
    expect(first).toBeTruthy(); first.release(); first.release();
    expect(statSync(path).ino).toBe(inode);
    const next = queue.acquireSessionLease("probe");
    expect(next).toBeTruthy(); next.release();
    expect(statSync(path).ino).toBe(inode);
  });
});
