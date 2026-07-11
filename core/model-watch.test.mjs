import { unit, feature, expect } from "bdd-vitest";
import { modelRank, classifyModelChange, changeMessage, stopBrief, shouldStopPane, label, decideRecovery, resumeBrief, recoveryMessage, interruptUntilIdle, RECOVERY_COOLDOWN_MS } from "./model-watch.mjs";

feature("modelRank — comparable within a family", () => {
  unit("codex: version dominates, variant breaks ties", {
    given: ["the observed quota-drop pairs", () => [
      ["gpt-5.6-sol", "gpt-5.6-mini"],
      ["gpt-5.6-sol", "gpt-5.5"],
    ]],
    when: ["ranking each pair", (pairs) => pairs.map(([a, b]) => [modelRank(a).score, modelRank(b).score])],
    then: ["first always outranks second", (ranked) => {
      for (const [a, b] of ranked) expect(a).toBeGreaterThan(b);
    }],
  });

  unit("codex: current same-version product ladder is sol > terra > luna", {
    given: ["the picker variants", () => ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
    when: ["ranking", (models) => models.map((model) => modelRank(model).score)],
    then: ["strictly descending", ([sol, terra, luna]) => {
      expect(sol).toBeGreaterThan(terra);
      expect(terra).toBeGreaterThan(luna);
    }],
  });

  unit("claude: fable outranks opus outranks sonnet", {
    given: ["family names as they appear in jsonl", () => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]],
    when: ["ranking", (ms) => ms.map((m) => modelRank(m).score)],
    then: ["strictly descending", ([f, o, s]) => {
      expect(f).toBeGreaterThan(o);
      expect(o).toBeGreaterThan(s);
    }],
  });

  unit("unknown strings rank null (callers treat as lateral)", {
    given: ["a synthetic marker", () => "<synthetic>"],
    when: ["ranking", (m) => modelRank(m)],
    then: ["null", (r) => { expect(r).toBeNull(); }],
  });
});

feature("classifyModelChange — the warn/act decision", () => {
  unit("quota drop gpt-5.6-sol max → gpt-5.5 is a downgrade", {
    given: ["the ai:3 incident", () => classifyModelChange(
      { model: "gpt-5.6-sol", effort: "max" },
      { model: "gpt-5.5", effort: "max" },
    )],
    when: ["classifying", (c) => c],
    then: ["downgrade with readable labels", (c) => {
      expect(c.direction).toBe("downgrade");
      expect(c.from).toBe("gpt-5.6-sol max");
      expect(c.to).toBe("gpt-5.5 max");
    }],
  });

  unit("fable → opus is a downgrade (context fallback)", {
    given: ["the claude case", () => classifyModelChange(
      { model: "claude-fable-5", effort: null },
      { model: "claude-opus-4-8", effort: null },
    )],
    when: ["classifying", (c) => c],
    then: ["downgrade", (c) => { expect(c.direction).toBe("downgrade"); }],
  });

  unit("switching back up is an upgrade, not noise", {
    given: ["recovery after quota reset", () => classifyModelChange(
      { model: "gpt-5.5", effort: "max" },
      { model: "gpt-5.6-sol", effort: "max" },
    )],
    when: ["classifying", (c) => c],
    then: ["upgrade", (c) => { expect(c.direction).toBe("upgrade"); }],
  });

  unit("same model, lower effort = downgrade of kind effort (warn, no stop)", {
    given: ["the crash-respawn case: max→xhigh on sol", () => classifyModelChange(
      { model: "gpt-5.6-sol", effort: "max" },
      { model: "gpt-5.6-sol", effort: "xhigh" },
    )],
    when: ["classifying", (c) => c],
    then: ["downgrade + effort kind + shouldStopPane false", (c) => {
      expect(c.direction).toBe("downgrade");
      expect(c.kind).toBe("effort");
      expect(shouldStopPane(c)).toBe(false);
    }],
  });

  unit("a model downgrade is kind model and DOES stop", {
    given: ["sol → mini", () => classifyModelChange(
      { model: "gpt-5.6-sol", effort: "max" },
      { model: "gpt-5.6-mini", effort: "max" },
    )],
    when: ["classifying", (c) => c],
    then: ["stop", (c) => {
      expect(c.kind).toBe("model");
      expect(shouldStopPane(c)).toBe(true);
    }],
  });

  unit("no change means null (no warning spam)", {
    given: ["identical sightings", () => classifyModelChange(
      { model: "gpt-5.6-sol", effort: "max" },
      { model: "gpt-5.6-sol", effort: "max" },
    )],
    when: ["classifying", (c) => c],
    then: ["null", (c) => { expect(c).toBeNull(); }],
  });

  unit("case and surrounding whitespace do not manufacture a model change", {
    given: ["equivalent labels from two producers", () => classifyModelChange(
      { model: "GPT-5.6-SOL", effort: "XHIGH" },
      { model: " gpt-5.6-sol ", effort: "xhigh" },
    )],
    when: ["classifying", (c) => c],
    then: ["null", (c) => expect(c).toBeNull()],
  });

  unit("cross-family or unknown stays lateral (warn only, no push)", {
    given: ["a synthetic-to-real transition", () => classifyModelChange(
      { model: "<synthetic>", effort: null },
      { model: "claude-fable-5", effort: null },
    )],
    when: ["classifying", (c) => c],
    then: ["lateral", (c) => { expect(c.direction).toBe("lateral"); }],
  });
});

feature("messages — actionable, not just informative", () => {
  unit("downgrade warning carries cause hint and recovery action", {
    given: ["a downgrade", () => changeMessage("ai:3", {
      direction: "downgrade", kind: "model", from: "gpt-5.6-sol max", to: "gpt-5.5 max",
    }, 72)],
    when: ["rendering", (m) => m],
    then: ["names pane, models, context, stop action + /model hint", (m) => {
      expect(m).toContain("ai:3");
      expect(m).toContain("gpt-5.6-sol max → gpt-5.5 max");
      expect(m).toContain("context 72%");
      expect(m).toContain("STOPPAS");
      expect(m).toContain("/model");
    }],
  });

  unit("effort-drop message says working continues, never STOPPAD", {
    given: ["an effort downgrade", () => changeMessage("ai:3", {
      direction: "downgrade", kind: "effort", from: "gpt-5.6-sol max", to: "gpt-5.6-sol xhigh",
    }, 82)],
    when: ["rendering", (m) => m],
    then: ["jobbar vidare + /model hint, no stop wording", (m) => {
      expect(m).toContain("jobbar vidare");
      expect(m).toContain("/model");
      expect(m).not.toContain("STOPPAD");
    }],
  });

  unit("stop brief parks the pane and defers re-verification to resume", {
    given: ["a downgrade", () => stopBrief({ from: "gpt-5.6-sol max", to: "gpt-5.5 max" })],
    when: ["rendering", (b) => b],
    then: ["stop now, no commits, re-verify at resume", (b) => {
      expect(b).toContain("[model-watch]");
      expect(b).toContain("STANNA NU");
      expect(b).toContain("committa inget");
      expect(b).toContain("re-verifiera");
    }],
  });

  unit("label folds effort in only when present", {
    given: ["with and without effort", () => [label({ model: "gpt-5.6-sol", effort: "max" }), label({ model: "claude-fable-5" })]],
    when: ["rendering", (l) => l],
    then: ["effort suffixed or absent", ([a, b]) => {
      expect(a).toBe("gpt-5.6-sol max");
      expect(b).toBe("claude-fable-5");
    }],
  });
});

feature("downgrade interruption", () => {
  unit("retries Escape until the pane lifecycle becomes idle", {
    given: ["two ignored Escapes before Codex stops", () => {
      const busy = [true, true, false];
      const escapes = [];
      return { busy, escapes };
    }],
    when: ["interrupting", ({ busy, escapes }) => interruptUntilIdle({
      isBusy: async () => busy.shift(),
      sendEscape: async () => { escapes.push("esc"); },
      sleep: async () => {},
    })],
    then: ["idle is verified after both Escapes", (result, { escapes }) => {
      expect(result).toMatchObject({ stopped: true, escapes: 2, detail: "idle verified" });
      expect(escapes).toHaveLength(2);
    }],
  });

  unit("reports an honest failure when the pane never stops", {
    given: ["a permanently busy pane", () => ({ escapes: [] })],
    when: ["interrupting with a bounded retry budget", ({ escapes }) => interruptUntilIdle({
      isBusy: async () => true,
      sendEscape: async () => { escapes.push("esc"); },
      sleep: async () => {},
      maxAttempts: 3,
    })],
    then: ["the result never claims the pane stopped", (result, { escapes }) => {
      expect(result.stopped).toBe(false);
      expect(result.detail).toContain("still busy");
      expect(escapes).toHaveLength(3);
    }],
  });
});

feature("auto-recovery decision (loop guard)", () => {
  unit("first incident attempts", {
    given: ["no prior attempt", () => ({ lastAttemptMs: null, nowMs: 1_000_000 })],
    when: ["deciding", (args) => decideRecovery(args)],
    then: ["attempt", (r) => expect(r.attempt).toBe(true)],
  });

  unit("a downgrade inside the cooldown never attempts (flap guard)", {
    given: ["an attempt 5 min ago", () => ({
      lastAttemptMs: 1_000_000, nowMs: 1_000_000 + 5 * 60_000,
    })],
    when: ["deciding", (args) => decideRecovery(args)],
    then: ["no attempt, names the cooldown", (r) => {
      expect(r.attempt).toBe(false);
      expect(r.reason).toMatch(/cooldown/i);
    }],
  });

  unit("after the cooldown a NEW incident may attempt again", {
    given: ["an attempt 31 min ago", () => ({
      lastAttemptMs: 1_000_000, nowMs: 1_000_000 + RECOVERY_COOLDOWN_MS + 60_000,
    })],
    when: ["deciding", (args) => decideRecovery(args)],
    then: ["attempt", (r) => expect(r.attempt).toBe(true)],
  });

  unit("kill switch disables attempts entirely", {
    given: ["recovery disabled", () => ({ lastAttemptMs: null, enabled: false })],
    when: ["deciding", (args) => decideRecovery(args)],
    then: ["no attempt", (r) => {
      expect(r.attempt).toBe(false);
      expect(r.reason).toMatch(/disabled/i);
    }],
  });
});

feature("recovery messaging", () => {
  unit("resume brief wakes with the re-verify duty", {
    given: ["a restored label", () => resumeBrief("gpt-5.6-sol xhigh")],
    when: ["rendering", (b) => b],
    then: ["names the model and demands re-verification", (b) => {
      expect(b).toContain("[model-watch]");
      expect(b).toContain("gpt-5.6-sol xhigh");
      expect(b).toMatch(/re-verifiera/i);
    }],
  });

  unit("channel line distinguishes restored from still-parked", {
    given: ["both outcomes", () => ({
      ok: recoveryMessage("api:3", true, "gpt-5.6-sol xhigh"),
      fail: recoveryMessage("api:3", false, "model-missing: quota"),
    })],
    when: ["rendering", (m) => m],
    then: ["🔁 vs 🅿 with detail", ({ ok, fail }) => {
      expect(ok).toContain("🔁");
      expect(ok).toContain("gpt-5.6-sol xhigh");
      expect(fail).toContain("🅿");
      expect(fail).toContain("kvar parkerad");
    }],
  });
});
