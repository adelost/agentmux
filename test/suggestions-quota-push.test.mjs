// Push-script contracts: config errors are loud and the log line names
// exactly which engine data made it into the pushed snapshot.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect as vitestExpect, it } from "vitest";
import { feature, unit, expect } from "bdd-vitest";
import {
  loadPushConfig,
  quotaPushDeliveryHealth,
  quotaPushSummary,
  pushQuotaSnapshot,
  readQuotaPushEvents,
  recordQuotaPushEvent,
} from "../bin/suggestions-quota-push.mjs";
import { readCodexQuota } from "../core/quota-usage.mjs";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

feature("suggestions-quota-push config", () => {
  unit("parses baseUrl and expands the credential path", {
    when: ["loading a complete config", () => loadPushConfig(
      "baseUrl: https://suggest.v1d.io/\nadminCredentialFile: ~/.config/agent/suggestions-admin-token\n",
    )],
    then: ["the trailing slash is stripped and ~ resolves to home", (config) => {
      expect(config.baseUrl).toBe("https://suggest.v1d.io");
      expect(config.credentialFile.startsWith("/")).toBe(true);
      expect(config.credentialFile.endsWith(".config/agent/suggestions-admin-token")).toBe(true);
    }],
  });

  unit("a config without required keys fails loudly", {
    when: ["loading a config missing adminCredentialFile", () => {
      try {
        loadPushConfig("baseUrl: https://suggest.v1d.io\n");
        return "no error";
      } catch (error) {
        return error.message;
      }
    }],
    then: ["the error names both required keys", (message) => {
      expect(message).toContain("baseUrl and adminCredentialFile");
    }],
  });
});

feature("suggestions-quota-push summary", () => {
  unit("names per-engine outcome including typed errors", {
    when: ["summarizing a mixed snapshot", () => quotaPushSummary({
      claude: { ok: true, limits: [] },
      codex: { ok: false, error: "no_rate_limit_events" },
    })],
    then: ["both engines and the codex error are visible", (summary) => {
      expect(summary).toContain("claude ok");
      expect(summary).toContain("codex no_rate_limit_events");
    }],
  });
});

feature("suggestions quota delivery ledger", () => {
  unit("survives restart and alerts after more than two intervals without delivery", {
    given: ["a durable ledger with success, failure and lock-skip outcomes", () => {
      const statePath = join(mkdtempSync(join(tmpdir(), "quota-push-state-")), "events.jsonl");
      recordQuotaPushEvent(statePath, { outcome: "success" }, { now: () => NOW });
      recordQuotaPushEvent(statePath, { outcome: "failure", reason: "http_503" },
        { now: () => NOW + 15 * 60_000 });
      recordQuotaPushEvent(statePath, { outcome: "lock_skip" },
        { now: () => NOW + 20 * 60_000 });
      return statePath;
    }],
    when: ["a fresh process reads the ledger at the two-interval boundary", (statePath) => ({
      statePath,
      events: readQuotaPushEvents(statePath),
      atBoundary: quotaPushDeliveryHealth(statePath, { now: () => NOW + 30 * 60_000 }),
      overdue: quotaPushDeliveryHealth(statePath, { now: () => NOW + 30 * 60_000 + 1 }),
    })],
    then: ["all outcomes remain and only the exceeded boundary alerts", (result) => {
      expect(result.events.map((event) => event.outcome))
        .toEqual(["success", "failure", "lock_skip"]);
      expect(result.atBoundary).toMatchObject({ state: "nominal", lastSuccessfulAt:
        "2026-07-17T12:00:00.000Z" });
      expect(result.overdue).toMatchObject({ state: "alert", reason: "suggestions-delivery-stale",
        ageMs: 30 * 60_000 + 1, lastOutcome: "lock_skip" });
    }],
  });

  unit("persists classified reasons without response bodies or credentials", {
    given: ["a failure event next to secrets that must never enter its schema", () => {
      const statePath = join(mkdtempSync(join(tmpdir(), "quota-push-redaction-")), "events.jsonl");
      recordQuotaPushEvent(statePath, { outcome: "failure", reason: "http_401",
        token: "admin-secret", responseBody: "upstream leaked bearer-secret" }, { now: () => NOW });
      return statePath;
    }],
    when: ["reading the durable bytes", (statePath) => readFileSync(statePath, "utf8")],
    then: ["only the classified reason is present", (bytes) => {
      expect(bytes).toContain("http_401");
      expect(bytes).not.toContain("admin-secret");
      expect(bytes).not.toContain("bearer-secret");
    }],
  });
});

describe("suggestions quota cron boundary", () => {
  it("records the sterile cron environment's missing runtime before exiting", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-push-sterile-"));
    const statePath = join(root, "events.jsonl");
    const wrapper = join(process.cwd(), "bin", "suggestions-quota-push-cron.sh");
    const result = spawnSync("/bin/bash", [wrapper], { encoding: "utf8", env: {
      HOME: root,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      NODE_BIN: join(root, "missing-node"),
      AMUX_QUOTA_PUSH_LOCK: join(root, "push.lock"),
      AMUX_QUOTA_PUSH_LOG: join(root, "push.log"),
      AMUX_QUOTA_PUSH_STATE: statePath,
    } });

    vitestExpect(result.status).toBe(1);
    vitestExpect(result.stderr).toContain("node executable not found");
    vitestExpect(readQuotaPushEvents(statePath)).toMatchObject([
      { version: 1, outcome: "failure", reason: "node_unavailable" },
    ]);
  });

  it("records a real flock skip in the durable ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "quota-push-lock-"));
    const lockPath = join(root, "push.lock");
    const statePath = join(root, "events.jsonl");
    const readyPath = join(root, "holder-ready");
    const holder = spawn("flock", ["-n", lockPath, process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1],'ready');setTimeout(()=>{},10000)",
      readyPath], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    vitestExpect(existsSync(readyPath)).toBe(true);
    const wrapper = join(process.cwd(), "bin", "suggestions-quota-push-cron.sh");
    const result = spawnSync("bash", [wrapper], { encoding: "utf8", env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      NODE_BIN: process.execPath,
      AMUX_QUOTA_PUSH_LOCK: lockPath,
      AMUX_QUOTA_PUSH_LOG: join(root, "push.log"),
      AMUX_QUOTA_PUSH_STATE: statePath,
    } });
    holder.kill("SIGTERM");
    vitestExpect(result.status).toBe(0);
    vitestExpect(readQuotaPushEvents(statePath).map((event) => event.outcome))
      .toEqual(["lock_skip"]);
  });

  it("installs the resolved node path and keeps cron errors observable", () => {
    const installer = readFileSync(join(process.cwd(), "bin", "install-quota-push.sh"), "utf8");
    vitestExpect(installer).toContain("NODE_BIN=");
    vitestExpect(installer).not.toContain("$SCRIPT >> /dev/null 2>&1");
  });

  it("replaces the already-installed broken cron row instead of calling it installed", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-push-install-"));
    const bin = join(root, "bin");
    const state = join(root, "crontab");
    const config = join(root, "push.yaml");
    mkdirSync(bin);
    writeFileSync(join(bin, "crontab"), `#!/bin/sh
if [ "$1" = "-l" ]; then cat "$CRONTAB_STATE"; exit 0; fi
if [ "$1" = "-" ]; then cat > "$CRONTAB_STATE"; exit 0; fi
exit 2
`);
    chmodSync(join(bin, "crontab"), 0o755);
    writeFileSync(config, "baseUrl: https://suggest.v1d.io\nadminCredentialFile: /tmp/token\n");
    writeFileSync(state, "*/15 * * * * /old/suggestions-quota-push-cron.sh >> /dev/null 2>&1\n");
    const installer = join(process.cwd(), "bin", "install-quota-push.sh");
    const result = spawnSync("bash", [installer, config], { encoding: "utf8", env: {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_BIN: process.execPath,
      CRONTAB_STATE: state,
    } });
    const installed = readFileSync(state, "utf8");
    vitestExpect(result.status).toBe(0);
    vitestExpect(installed).toContain(`NODE_BIN=${process.execPath}`);
    vitestExpect(installed).not.toContain("/old/suggestions-quota-push-cron.sh");
    vitestExpect(installed.match(/suggestions-quota-push-cron\.sh/gu)).toHaveLength(1);
  });
});

describe("real quota producer to Suggest push boundary", () => {
  it("posts the exact activity-selected observation and records verified success", async () => {
    const root = mkdtempSync(join(tmpdir(), "quota-push-integration-"));
    const sessions = join(root, "sessions", "2026", "07", "17");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-old-live.jsonl"), `${JSON.stringify({
      timestamp: "2026-07-17T12:00:00.000Z",
      payload: { rate_limits: { limit_id: "codex", plan_type: "pro", primary: {
        used_percent: 65, window_minutes: 10_080,
        resets_at: Date.parse("2026-07-23T04:16:00.000Z") / 1000,
      } } },
    })}\n`);
    const codex = readCodexQuota({ sessionsRoot: join(root, "sessions") });
    const snapshot = { generatedAt: "2026-07-17T12:00:05.000Z",
      claude: { ok: false, engine: "claude", error: "offline" }, codex };
    let received = null;
    const server = createServer((request, response) => {
      let bytes = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { bytes += chunk; });
      request.on("end", () => {
        received = JSON.parse(bytes);
        response.writeHead(204).end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const tokenPath = join(root, "token");
      const statePath = join(root, "events.jsonl");
      const configPath = join(root, "push.yaml");
      writeFileSync(tokenPath, "test-admin-secret\n");
      writeFileSync(configPath, `baseUrl: http://127.0.0.1:${address.port}\nadminCredentialFile: ${tokenPath}\nstatePath: ${statePath}\n`);
      const result = await pushQuotaSnapshot(snapshot, { configPath, now: () => NOW });
      vitestExpect(result).toMatchObject({ ok: true, health: { state: "nominal" } });
      vitestExpect(received).toEqual({ version: 1, snapshot });
      vitestExpect(received.snapshot.codex.observation).toMatchObject({
        source: "codex.rollout.rate_limits", observedAt: "2026-07-17T12:00:00.000Z",
        usedPercent: 65, remainingPercent: 35, resetsAt: "2026-07-23T04:16:00.000Z",
      });
      vitestExpect(readQuotaPushEvents(statePath).map((event) => event.outcome))
        .toEqual(["success"]);
      vitestExpect(readFileSync(statePath, "utf8")).not.toContain("test-admin-secret");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
