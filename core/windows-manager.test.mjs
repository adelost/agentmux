import { expect, feature, unit } from "bdd-vitest";
import {
  MANAGER_CONTRACT_VERSION,
  MANAGER_TOOLS,
  buildCodexResumeArgs,
  buildRunbookContext,
  classifyManagerOutcome,
  createCliProvider,
  createHttpProvider,
  newestCodexSessionId,
  createMockProvider,
  extractCliAnswer,
  formatLocalRescueAnswer,
  formatProviderFallback,
  parseToolCalls,
  planLocalRescueTurn,
  planManagerTurn,
  planRescueCommand,
  planToolCall,
  redactSecrets,
  trackManagerBootId,
} from "./windows-manager.mjs";

feature("windows manager core", () => {
  unit("critical rescue language is local and provider-independent", {
    then: ["status, logs, and WSL failure map narrowly while general chat stays with the manager AI", () => {
      expect(planLocalRescueTurn("status")).toEqual({ kind: "status", tools: ["get_status"] });
      expect(planLocalRescueTurn("Hur mår WSL?")).toEqual({ kind: "status", tools: ["get_status"] });
      expect(planLocalRescueTurn("visa loggarna")).toEqual({ kind: "logs", tools: ["get_logs"] });
      expect(planLocalRescueTurn("WSL har kraschat")).toEqual({ kind: "recovery", tools: ["get_status", "recover"] });
      expect(planLocalRescueTurn("WSL krash")).toEqual({ kind: "recovery", tools: ["get_status", "recover"] });
      expect(planLocalRescueTurn("Ok, WSL har kraschat och behöver startas om"))
        .toEqual({ kind: "restart-wsl", tools: ["get_status", "restart_wsl"] });
      expect(planLocalRescueTurn("Kan du starta om WSL?"))
        .toEqual({ kind: "restart-wsl", tools: ["get_status", "restart_wsl"] });
      expect(planLocalRescueTurn("WSL svarar inte")).toEqual({ kind: "recovery", tools: ["get_status", "recover"] });
      expect(planLocalRescueTurn("hur restartar vi WSL?")).toEqual({ kind: "recovery", tools: ["get_status", "recover"] });
      expect(planLocalRescueTurn("Hej! Hur restartar vi?")).toEqual({ kind: "recovery", tools: ["get_status", "recover"] });
      expect(planLocalRescueTurn("hej")).toBeNull();
      expect(planLocalRescueTurn("kan du skriva kod?")).toBeNull();
    }],
  });

  unit("local answers and provider fallback remain actionable", {
    then: ["measurements survive provider failure without claiming a false recovery", () => {
      expect(formatLocalRescueAnswer({ kind: "status" }, [{ ok: true, detail: "AMUX READY" }], "RECOVERED"))
        .toBe("AMUX READY");
      expect(formatLocalRescueAnswer({ kind: "recovery" }, [
        { ok: true, detail: "status" },
        { ok: false, detail: "bridge-timeout" },
      ], "PARTIAL")).toBe("AMUX PARTIAL lokal recovery\nsteg=2 fel=1\nbridge-timeout");
      expect(formatProviderFallback("http-401")).toContain("manager-ai=http-401");
      expect(formatProviderFallback("http-401")).toContain("Rescue fungerar utan AI");
    }],
  });

  unit("the runbook carries the manager identity, failure classes, and every safety rule", {
    then: ["all required statements are present and the prompt stays compact", () => {
      const runbook = buildRunbookContext({ contractVersion: MANAGER_CONTRACT_VERSION });
      expect(runbook).toContain("Kontraktsversion: 1");
      expect(runbook).toContain("_windows_");
      expect(runbook).toContain("Windows-nativ manager-AI");
      expect(runbook).toContain("node.exe");
      expect(runbook).toContain("OOM/hang/omstart");
      expect(runbook).toContain("Bara bryggen nere");
      expect(runbook).toContain("Värden död");
      expect(runbook).toContain("wsl --shutdown");
      expect(runbook).toContain("autentiserat och uttryckligt");
      expect(runbook).toContain("modellen kan aldrig");
      expect(runbook).toContain("wsl=offline");
      expect(runbook).toContain("60 sekunder");
      expect(runbook).toContain("Journalföring sker före varje exekvering");
      expect(runbook).toContain("RECOVERED");
      expect(runbook).toContain("PARTIAL");
      expect(runbook).toContain("BLOCKED");
      expect(runbook).toContain("falskt ACK");
      expect(runbook).toContain("autentiseringsfel");
      expect(runbook).toContain("get_status innan någon åtgärd");
      expect(runbook).toContain('{"tool":"get_status"}');
      expect(runbook).toContain('{"tool":"recover"}');
      expect(runbook).not.toContain("—");
      expect(runbook.split(/\s+/u).length).toBeLessThan(1200);
    }],
  });

  unit("the tool allowlist is bounded and keeps destructive restart local-only", {
    then: ["six tools with exact timeouts and only restart_wsl destructive", () => {
      expect(MANAGER_TOOLS.map((tool) => tool.name)).toEqual([
        "get_status",
        "get_logs",
        "start_bridge",
        "start_wsl",
        "recover",
        "restart_wsl",
      ]);
      const byName = Object.fromEntries(MANAGER_TOOLS.map((tool) => [tool.name, tool]));
      expect(byName.start_wsl.timeoutMs).toBe(120_000);
      expect(byName.recover.timeoutMs).toBe(570_000);
      expect(byName.restart_wsl.timeoutMs).toBe(570_000);
      expect(byName.restart_wsl).toMatchObject({ destructive: true, modelCallable: false });
      for (const name of ["get_status", "get_logs", "start_bridge"]) {
        expect(byName[name].timeoutMs).toBeGreaterThanOrEqual(30_000);
        expect(byName[name].timeoutMs).toBeLessThanOrEqual(45_000);
      }
      for (const tool of MANAGER_TOOLS) {
        if (tool.name !== "restart_wsl") expect(tool.destructive).toBe(false);
        expect(tool.description.length).toBeGreaterThan(10);
      }
    }],
  });

  unit("planManagerTurn assembles system, bounded history, and the user text", {
    then: ["system first, redacted observation, history sliced, user last", () => {
      const history = Array.from({ length: 14 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `entry-${index}`,
      }));
      const observation = { wsl: "offline", note: `token sk-${"k".repeat(24)}` };
      const messages = planManagerTurn({
        userText: "hur mår läget?",
        observation,
        history,
        contractVersion: MANAGER_CONTRACT_VERSION,
      });
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("Du är Agentmux Windows-hanterare");
      expect(messages[0].content).toContain("Aktuell observation (JSON):");
      expect(messages[0].content).toContain('"wsl":"offline"');
      expect(messages[0].content).not.toContain("sk-");
      expect(messages[0].content).toContain("***");
      expect(messages).toHaveLength(12);
      expect(messages[1].content).toBe("entry-4");
      expect(messages.at(-1)).toEqual({ role: "user", content: "hur mår läget?" });
      const noObservation = planManagerTurn({ userText: "hej", contractVersion: 1 });
      expect(noObservation[0].content).toContain("\nnull");
      expect(noObservation).toHaveLength(2);
    }],
  });

  unit("parseToolCalls is strict, prose tolerant, and capped", {
    then: ["allowlisted per-line JSON only, garbage skipped, max three", () => {
      expect(parseToolCalls("Jag kollar status.\n{\"tool\":\"get_status\"}\nKlart snart."))
        .toEqual(["get_status"]);
      expect(parseToolCalls("{\"tool\":\"get_status\"}\n{\"tool\":\"recover\"}"))
        .toEqual(["get_status", "recover"]);
      expect(parseToolCalls("{\"tool\":\"wipe\"}")).toEqual([]);
      expect(parseToolCalls("{\"tool\":\"restart\"}")).toEqual([]);
      expect(parseToolCalls("{\"tool\":\"restart_wsl\"}")).toEqual([]);
      expect(parseToolCalls("not json at all")).toEqual([]);
      expect(parseToolCalls("{\"tool\":123}")).toEqual([]);
      expect(parseToolCalls("[{\"tool\":\"get_status\"}]")).toEqual([]);
      expect(parseToolCalls("{\"tool\":\"get_status\"")).toEqual([]);
      expect(parseToolCalls("")).toEqual([]);
      expect(parseToolCalls(null)).toEqual([]);
      expect(parseToolCalls(
        "{\"tool\":\"get_status\"}\n{\"tool\":\"get_logs\"}\n{\"tool\":\"start_bridge\"}\n{\"tool\":\"start_wsl\"}",
      )).toEqual(["get_status", "get_logs", "start_bridge"]);
    }],
  });

  unit("planToolCall enforces every freshness bound", {
    then: ["unknown refused, start_wsl needs proven offline, recover needs fresh status", () => {
      expect(planToolCall({ name: "nope" })).toEqual({ allow: false, reason: "unknown-tool" });
      for (const name of ["get_status", "get_logs", "start_bridge"]) {
        expect(planToolCall({ name })).toEqual({ allow: true, reason: "ok" });
        expect(planToolCall({ name, observation: null, lastStatusMs: null })).toEqual({ allow: true, reason: "ok" });
      }
      expect(planToolCall({ name: "start_wsl", observation: { wsl: "offline" } }))
        .toEqual({ allow: true, reason: "ok" });
      expect(planToolCall({ name: "start_wsl", observation: { wsl: "online" } }))
        .toEqual({ allow: false, reason: "wsl-not-proven-offline" });
      expect(planToolCall({ name: "start_wsl", observation: { wsl: "unknown" } }))
        .toEqual({ allow: false, reason: "wsl-not-proven-offline" });
      expect(planToolCall({ name: "start_wsl", observation: null }))
        .toEqual({ allow: false, reason: "wsl-not-proven-offline" });
      expect(planToolCall({ name: "restart_wsl", observation: { wsl: "unknown" } }))
        .toEqual({ allow: false, reason: "explicit-human-restart-required" });
      expect(planToolCall({ name: "restart_wsl", observation: { wsl: "unknown" }, explicitHumanRestart: true }))
        .toEqual({ allow: true, reason: "explicit-human-restart" });
      const nowMs = 1_000_000;
      expect(planToolCall({ name: "recover", lastStatusMs: nowMs - 59_000, nowMs }))
        .toEqual({ allow: true, reason: "ok" });
      expect(planToolCall({ name: "recover", lastStatusMs: nowMs - 61_000, nowMs }))
        .toEqual({ allow: false, reason: "status-stale" });
      expect(planToolCall({ name: "recover", lastStatusMs: null, nowMs }))
        .toEqual({ allow: false, reason: "status-stale" });
      expect(planToolCall({ name: "recover", lastStatusMs: nowMs + 5_000, nowMs }))
        .toEqual({ allow: false, reason: "status-stale" });
    }],
  });

  unit("classifyManagerOutcome reuses the bridge classifier exactly", {
    then: ["RECOVERED, PARTIAL, BLOCKED with the failed stage", () => {
      expect(classifyManagerOutcome([
        { stage: "get_status", ok: true },
        { stage: "start_bridge", ok: true },
      ])).toEqual({ outcome: "RECOVERED", failedStage: null });
      expect(classifyManagerOutcome([
        { stage: "start_wsl", ok: true },
        { stage: "start_bridge", ok: false },
      ])).toEqual({ outcome: "PARTIAL", failedStage: "start_bridge" });
      expect(classifyManagerOutcome([
        { stage: "start_wsl", ok: false },
        { stage: "start_bridge", ok: false },
      ])).toEqual({ outcome: "BLOCKED", failedStage: "start_wsl" });
    }],
  });

  unit("boot tracking keeps the boot id before the current one", {
    then: ["first sighting stores last, each change moves it to prev, repeats are no-ops", () => {
      const state = {};
      expect(trackManagerBootId(state, { bootId: "a" })).toBe(state);
      expect(state).toEqual({ prevBootId: null, lastBootId: "a" });
      trackManagerBootId(state, { bootId: "a" });
      expect(state).toEqual({ prevBootId: null, lastBootId: "a" });
      trackManagerBootId(state, { bootId: "b" });
      expect(state).toEqual({ prevBootId: "a", lastBootId: "b" });
      trackManagerBootId(state, {});
      trackManagerBootId(state, { wsl: "offline" });
      expect(state).toEqual({ prevBootId: "a", lastBootId: "b" });
      trackManagerBootId(state, { bootId: "c" });
      expect(state).toEqual({ prevBootId: "b", lastBootId: "c" });
    }],
  });

  unit("planRescueCommand routes recover by the stored pre-boot identity", {
    then: ["a known boot id runs recover-verify, an unknown one stays degraded", () => {
      expect(planRescueCommand({ name: "get_status" }))
        .toEqual({ command: "get-status", beforeBootId: null, degraded: false });
      expect(planRescueCommand({ name: "start_wsl" }).command).toBe("start-wsl");
      expect(planRescueCommand({ name: "restart_wsl" }).command).toBe("restart-wsl");
      expect(planRescueCommand({ name: "recover", beforeBootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }))
        .toEqual({ command: "recover-verify", beforeBootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", degraded: false });
      expect(planRescueCommand({ name: "recover", beforeBootId: null }))
        .toEqual({ command: "recover", beforeBootId: null, degraded: true });
      expect(planRescueCommand({ name: "recover", beforeBootId: "not a boot id" }).degraded).toBe(true);
      expect(planRescueCommand({ name: "recover" }).degraded).toBe(true);
    }],
  });

  unit("redactSecrets masks every secret shape and keeps prose", {
    then: ["mfa, three-part Discord token, sk- and key- all become ***", () => {
      const mfa = `mfa${"a".repeat(24)}`;
      const discord = `${"x".repeat(24)}.${"y".repeat(6)}.${"z".repeat(30)}`;
      const sk = `sk-${"k".repeat(24)}`;
      const key = `key-${"k".repeat(24)}`;
      const text = `status ok ${mfa} and ${discord} plus ${sk} and ${key} wsl=offline`;
      const redacted = redactSecrets(text);
      expect(redacted).toBe("status ok *** and *** plus *** and *** wsl=offline");
      expect(redacted).not.toContain(mfa);
      expect(redactSecrets("inga hemligheter här")).toBe("inga hemligheter här");
      expect(redactSecrets(null)).toBe("");
    }],
  });

  unit("the mock provider replays scripted responses in order", {
    then: ["strings normalize, objects pass through, exhaustion is a clean failure", async () => {
      const provider = createMockProvider(["hej", { ok: false, reason: "planned-failure" }]);
      expect(provider.name).toBe("mock");
      expect(await provider.chat([{ role: "user", content: "x" }])).toEqual({ ok: true, text: "hej" });
      expect(await provider.chat([])).toEqual({ ok: false, reason: "planned-failure" });
      expect(await provider.chat([])).toEqual({ ok: false, reason: "mock-exhausted" });
    }],
  });

  unit("the http provider posts chat completions and never leaks the key", {
    then: ["success, non-200, and timeout all keep the key out of every result", async () => {
      const key = `sk-live-${"s".repeat(30)}`;
      const calls = [];
      const okFetch = async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "allt grönt" } }] }),
        };
      };
      const provider = createHttpProvider({
        endpoint: "https://llm.example/v1",
        model: "manager-model",
        apiKeyProvider: () => key,
        timeoutMs: 5_000,
        fetchImpl: okFetch,
      });
      expect(provider.name).toBe("http");
      const messages = [{ role: "user", content: "status?" }];
      expect(await provider.chat(messages)).toEqual({ ok: true, text: "allt grönt" });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.headers.authorization).toBe(`Bearer ${key}`);
      expect(JSON.parse(calls[0].init.body)).toEqual({ model: "manager-model", messages });

      const failing = createHttpProvider({
        endpoint: "https://llm.example/v1",
        model: "m",
        apiKeyProvider: () => key,
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      });
      const denied = await failing.chat([]);
      expect(denied).toEqual({ ok: false, reason: "http-500" });
      expect(JSON.stringify(denied)).not.toContain(key);

      const timedOut = createHttpProvider({
        endpoint: "https://llm.example/v1",
        model: "m",
        apiKeyProvider: () => key,
        fetchImpl: async () => {
          throw Object.assign(new Error(`aborted with ${key}`), { name: "TimeoutError" });
        },
      });
      const timeoutResult = await timedOut.chat([]);
      expect(timeoutResult).toEqual({ ok: false, reason: "timeout" });
      expect(JSON.stringify(timeoutResult)).not.toContain(key);

      const leaky = createHttpProvider({
        endpoint: "https://llm.example/v1",
        model: "m",
        apiKeyProvider: () => key,
        fetchImpl: async () => {
          throw new Error(`network broke near ${key}`);
        },
      });
      const networkResult = await leaky.chat([]);
      expect(networkResult).toEqual({ ok: false, reason: "request-failed" });
      expect(JSON.stringify(networkResult)).not.toContain(key);
    }],
  });

  unit("extractCliAnswer strips the codex header and token trailer", {
    then: ["the body survives, chrome is gone", () => {
      expect(extractCliAnswer("codex\nHej Mattias, WSL mår bra.\ntokens used\n1,951\n"))
        .toBe("Hej Mattias, WSL mår bra.");
      expect(extractCliAnswer("codex\nCODEX OK\ntokens used\n12\nCODEX OK\n"))
        .toBe("CODEX OK");
      expect(extractCliAnswer("codex\ntokens used\n1\n")).toBeNull();
      expect(extractCliAnswer("")).toBeNull();
      expect(extractCliAnswer("tokens used\n5\n")).toBeNull();
    }],
  });

  unit("the cli provider flattens messages, times out bounded, and never leaks the engine", {
    then: ["prompt shape, exit codes and timeout are classified", async () => {
      const seen = [];
      const fake = (cmd, args, input, timeout) => {
        seen.push({ cmd, args, input, timeout });
        return Promise.resolve({ code: 0, stdout: "codex\nSvar från codex.\ntokens used\n9\n", timedOut: false });
      };
      const provider = createCliProvider({ command: "wsl.exe", args: ["--", "codex", "exec", "-"], timeoutMs: 5_000, execImpl: fake });
      const result = await provider.chat([
        { role: "system", content: "Runbook." },
        { role: "user", content: "status?" },
      ]);
      expect(result).toMatchObject({ ok: true, text: "Svar från codex." });
      expect(seen[0].cmd).toBe("wsl.exe");
      expect(seen[0].input).toContain("[SYSTEM]\nRunbook.");
      expect(seen[0].input).toContain("[USER]\nstatus?");
      expect(seen[0].timeout).toBe(5_000);

      const timeoutProvider = createCliProvider({
        command: "x",
        execImpl: () => Promise.resolve({ code: null, stdout: "", timedOut: true }),
      });
      expect(await timeoutProvider.chat([{ role: "user", content: "hej" }]))
        .toEqual({ ok: false, reason: "timeout" });

      const failProvider = createCliProvider({
        command: "x",
        execImpl: () => Promise.resolve({ code: 3, stdout: "codex\n", timedOut: false }),
      });
      expect(await failProvider.chat([{ role: "user", content: "hej" }]))
        .toEqual({ ok: false, reason: "exit-3" });

      const emptyProvider = createCliProvider({
        command: "x",
        execImpl: () => Promise.resolve({ code: 0, stdout: "codex\ntokens used\n1\n", timedOut: false }),
      });
      expect(await emptyProvider.chat([{ role: "user", content: "hej" }]))
        .toEqual({ ok: false, reason: "empty-response" });
    }],
  });

  unit("newestCodexSessionId picks the newest rollout after the cursor and skips noise", {
    then: ["exact id, cursor respected, garbage ignored", () => {
      const entries = [
        "2026/07/21/rollout-2026-07-21T06-20-13-019f82e7-21bd-7b62-9eaa-eb2719207962.jsonl",
        "2026/07/21/rollout-2026-07-21T07-01-02-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        "2026/07/15/rollout-2026-07-15T15-31-43-019f65f9-e4c0-7022-89ad-74d52abbe661.jsonl",
        "2026/07/21/notes.txt",
      ];
      expect(newestCodexSessionId("/x", { entries }))
        .toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(newestCodexSessionId("/x", { entries, afterMs: Date.parse("2026-07-21T07:00:00Z") }))
        .toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(newestCodexSessionId("/x", { entries, afterMs: Date.parse("2026-07-22T00:00:00Z") }))
        .toBeNull();
      expect(newestCodexSessionId("/x", { entries: [] })).toBeNull();
    }],
  });

  unit("a resumed turn sends only the new message plus observation, never the runbook again", {
    then: ["second call carries the session id and a small prompt; fallback resends fully", async () => {
      const calls = [];
      const sessionId = "019f82e7-21bd-7b62-9eaa-eb2719207962";
      const execImpl = (cmd, callArgs, input) => {
        calls.push({ callArgs, input });
        return Promise.resolve({ code: 0, stdout: "codex\nSvar.\ntokens used\n5\n", timedOut: false });
      };
      void createCliProvider;
      const sessionEntries = [
        "2026/07/21/rollout-2026-07-21T06-20-13-019f82e7-21bd-7b62-9eaa-eb2719207962.jsonl",
      ];
      const sessionedProvider = createCliProvider({
        command: "wsl.exe",
        args: ["base-args"],
        resumeArgs: (id) => ["resume", id],
        sessionsDir: "/x",
        execImpl,
        readdirImpl: () => sessionEntries,
        nowMs: () => Date.parse("2026-07-21T06:20:00Z"),
      });
      const first = await sessionedProvider.chat([
        { role: "system", content: "RUNBOOK TEXT\n\nAktuell observation (JSON):\n{\"wsl\":\"online\"}" },
        { role: "user", content: "hej" },
      ]);
      expect(first.ok).toBe(true);
      expect(calls[0].callArgs).toEqual(["base-args"]);
      expect(calls[0].input).toContain("RUNBOOK TEXT");

      const second = await sessionedProvider.chat([
        { role: "system", content: "RUNBOOK TEXT\n\nAktuell observation (JSON):\n{\"wsl\":\"online\"}" },
        { role: "user", content: "och nu då?" },
      ]);
      expect(second.ok).toBe(true);
      expect(second.sessionId).toBe(sessionId);
      expect(calls[1].callArgs).toEqual(["resume", sessionId]);
      expect(calls[1].input).toContain("[USER]\noch nu då?");
      expect(calls[1].input).toContain("Aktuell observation (JSON):");
      expect(calls[1].input).not.toContain("RUNBOOK TEXT");
    }],
  });

  unit("a restarted manager resumes its persisted session without a full re-send", {
    then: ["the first turn after restart already uses resume args and the small prompt", async () => {
      const calls = [];
      const sessionId = "019f82e7-21bd-7b62-9eaa-eb2719207962";
      const execImpl = (cmd, callArgs, input) => {
        calls.push({ callArgs, input });
        return Promise.resolve({ code: 0, stdout: "codex\nSvar.\ntokens used\n5\n", timedOut: false });
      };
      const provider = createCliProvider({
        command: "wsl.exe",
        args: ["base-args"],
        resumeArgs: (id) => ["resume", id],
        initialSessionId: sessionId,
        execImpl,
      });
      const result = await provider.chat([
        { role: "system", content: "RUNBOOK TEXT\n\nAktuell observation (JSON):\n{\"wsl\":\"online\"}" },
        { role: "user", content: "tillbaka nu" },
      ]);
      expect(result).toMatchObject({ ok: true, sessionId });
      expect(calls).toHaveLength(1);
      expect(calls[0].callArgs).toEqual(["resume", sessionId]);
      expect(calls[0].input).toContain("[USER]\ntillbaka nu");
      expect(calls[0].input).not.toContain("RUNBOOK TEXT");
    }],
  });

  unit("manager resume args are a real argv array, never one joined string", {
    then: ["codex.js, exec, resume, the id, and the stdin dash stay separate elements", () => {
      const codexJs = "C:\\Users\\claw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
      const execArgs = [codexJs, "exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"];
      const resume = buildCodexResumeArgs(execArgs);
      expect(typeof resume).toBe("function");
      const sessionId = "019f82e7-21bd-7b62-9eaa-eb2719207962";
      const argv = resume(sessionId);
      expect(argv).toEqual([codexJs, "exec", "resume", "--skip-git-repo-check", sessionId, "-"]);
      expect(argv.every((entry) => !entry.includes(" "))).toBe(true);
      expect(buildCodexResumeArgs(["exec", "-"])).toBeInstanceOf(Function);
      expect(buildCodexResumeArgs(["--help"])).toBeNull();
      expect(buildCodexResumeArgs(null)).toBeNull();
    }],
  });

  unit("a configured session id without resume args falls back to full turns", {
    then: ["the small resume prompt is never sent as a fresh session", async () => {
      const calls = [];
      const execImpl = (cmd, callArgs, input) => {
        calls.push({ callArgs, input });
        return Promise.resolve({ code: 0, stdout: "codex\nSvar.\ntokens used\n5\n", timedOut: false });
      };
      const provider = createCliProvider({
        command: "node.exe",
        args: ["codex.js", "exec", "-"],
        initialSessionId: "019f82e7-21bd-7b62-9eaa-eb2719207962",
        execImpl,
      });
      const result = await provider.chat([
        { role: "system", content: "RUNBOOK TEXT" },
        { role: "user", content: "hej" },
      ]);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].callArgs).toEqual(["codex.js", "exec", "-"]);
      expect(calls[0].input).toContain("RUNBOOK TEXT");
    }],
  });
});
