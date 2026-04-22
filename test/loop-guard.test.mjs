import { feature, unit, expect } from "bdd-vitest";
import {
  checkLoopGuard,
  readLoopGuardConfig,
  loopGuardKey,
  formatLoopGuardWarning,
  DEFAULTS,
} from "../core/loop-guard.mjs";

const config = (overrides = {}) => ({
  enabled: true,
  threshold: 3,
  windowMs: 30_000,
  shortLen: 10,
  ...overrides,
});

const emptyEntry = () => ({ last_msgs: [], last_warning_ts: null });

feature("checkLoopGuard: block behaviour", () => {
  unit("3 identical short msgs within window → block + warn on 3rd", {
    given: ["fresh entry, threshold=3", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["sending '0' three times at t=0,1,2 sec", ({ entry, cfg }) => {
      const r1 = checkLoopGuard(entry, "0", 0, cfg);
      const r2 = checkLoopGuard(entry, "0", 1000, cfg);
      const r3 = checkLoopGuard(entry, "0", 2000, cfg);
      return { r1, r2, r3 };
    }],
    then: ["1st + 2nd pass, 3rd blocks + warns", ({ r1, r2, r3 }) => {
      expect(r1.block).toBe(false);
      expect(r2.block).toBe(false);
      expect(r3.block).toBe(true);
      expect(r3.warn).toBe(true);
      expect(r3.count).toBe(3);
      expect(r3.text).toBe("0");
    }],
  });

  unit("3 different short msgs → all pass, no block (each resets window)", {
    given: ["fresh entry", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["a, b, c at t=0,1,2", ({ entry, cfg }) => {
      const r1 = checkLoopGuard(entry, "a", 0, cfg);
      const r2 = checkLoopGuard(entry, "b", 1000, cfg);
      const r3 = checkLoopGuard(entry, "c", 2000, cfg);
      return { r1, r2, r3, entry };
    }],
    then: ["no blocks", ({ r1, r2, r3, entry }) => {
      expect(r1.block).toBe(false);
      expect(r2.block).toBe(false);
      expect(r3.block).toBe(false);
      expect(entry.last_msgs.length).toBe(1);
      expect(entry.last_msgs[0].text).toBe("c");
    }],
  });

  unit("2 identical + 1 different → different resets, no block", {
    given: ["fresh entry", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["0, 0, hej at t=0,1,2", ({ entry, cfg }) => {
      const r1 = checkLoopGuard(entry, "0", 0, cfg);
      const r2 = checkLoopGuard(entry, "0", 1000, cfg);
      const r3 = checkLoopGuard(entry, "hej", 2000, cfg);
      return { r1, r2, r3, entry };
    }],
    then: ["3rd (hej) forwards, window holds only 'hej'", ({ r2, r3, entry }) => {
      expect(r2.count).toBe(2);
      expect(r2.block).toBe(false);
      expect(r3.block).toBe(false);
      expect(entry.last_msgs.length).toBe(1);
      expect(entry.last_msgs[0].text).toBe("hej");
    }],
  });

  unit("3 identical but length > shortLen → never blocks", {
    given: ["fresh entry + long message (>10 chars)", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["3 long msgs", ({ entry, cfg }) => {
      const long = "this is a long prompt";
      const r1 = checkLoopGuard(entry, long, 0, cfg);
      const r2 = checkLoopGuard(entry, long, 1000, cfg);
      const r3 = checkLoopGuard(entry, long, 2000, cfg);
      return { r1, r2, r3, entry };
    }],
    then: ["no blocks, window stays empty (long msgs don't accumulate)", ({ r1, r2, r3, entry }) => {
      expect(r1.block).toBe(false);
      expect(r2.block).toBe(false);
      expect(r3.block).toBe(false);
      expect(entry.last_msgs.length).toBe(0);
    }],
  });

  unit("3 identical but with gaps > windowMs → never blocks", {
    given: ["fresh entry, windowMs=1000 for test speed", () => ({
      entry: emptyEntry(),
      cfg: config({ windowMs: 1000 }),
    })],
    when: ["3 '0' spaced 2s apart", ({ entry, cfg }) => {
      const r1 = checkLoopGuard(entry, "0", 0, cfg);
      const r2 = checkLoopGuard(entry, "0", 2000, cfg);
      const r3 = checkLoopGuard(entry, "0", 4000, cfg);
      return { r1, r2, r3 };
    }],
    then: ["no blocks — purge keeps window size 1", ({ r1, r2, r3 }) => {
      expect(r1.block).toBe(false);
      expect(r2.block).toBe(false);
      expect(r3.block).toBe(false);
      expect(r3.count).toBe(1);
    }],
  });
});

feature("checkLoopGuard: warning suppression", () => {
  unit("warn fires only on the first block in a period — subsequent blocks are silent", {
    given: ["fresh entry, threshold=3", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["5 identical '0's in rapid succession", ({ entry, cfg }) => {
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(checkLoopGuard(entry, "0", i * 500, cfg));
      }
      return results;
    }],
    then: ["3rd warns, 4th/5th are silent blocks", (results) => {
      expect(results[2].block).toBe(true);
      expect(results[2].warn).toBe(true);
      expect(results[3].block).toBe(true);
      expect(results[3].warn).toBe(false);
      expect(results[4].block).toBe(true);
      expect(results[4].warn).toBe(false);
    }],
  });

  unit("warn fires again after windowMs has passed since last warning", {
    given: ["fresh entry, small window=1000ms", () => ({
      entry: emptyEntry(),
      cfg: config({ windowMs: 1000 }),
    })],
    when: ["3 '0's rapidly (block+warn), then 3 more after windowMs", ({ entry, cfg }) => {
      const first = [];
      for (let i = 0; i < 3; i++) first.push(checkLoopGuard(entry, "0", i * 100, cfg));
      // Wait past window so everything purges, then new run
      const second = [];
      for (let i = 0; i < 3; i++) second.push(checkLoopGuard(entry, "0", 2000 + i * 100, cfg));
      return { first, second };
    }],
    then: ["both third-msgs warn (new block period)", ({ first, second }) => {
      expect(first[2].block).toBe(true);
      expect(first[2].warn).toBe(true);
      expect(second[2].block).toBe(true);
      expect(second[2].warn).toBe(true);
    }],
  });
});

feature("checkLoopGuard: reset cases", () => {
  unit("different message clears the window and warn-ts even when count was high", {
    given: ["entry that has already blocked once", () => {
      const entry = emptyEntry();
      const cfg = config();
      for (let i = 0; i < 4; i++) checkLoopGuard(entry, "0", i * 100, cfg);
      // now entry has 4x '0' and last_warning_ts set
      return { entry, cfg };
    }],
    when: ["user sends a different short msg", ({ entry, cfg }) => {
      return checkLoopGuard(entry, "hej", 500, cfg);
    }],
    then: ["different msg forwards, window holds only 'hej', warn-ts cleared", (r, { entry }) => {
      expect(r.block).toBe(false);
      expect(entry.last_msgs.length).toBe(1);
      expect(entry.last_msgs[0].text).toBe("hej");
      expect(entry.last_warning_ts).toBeNull();
    }],
  });

  unit("long message resets everything", {
    given: ["entry with identicals", () => {
      const entry = emptyEntry();
      const cfg = config();
      checkLoopGuard(entry, "0", 0, cfg);
      checkLoopGuard(entry, "0", 100, cfg);
      return { entry, cfg };
    }],
    when: ["long prompt arrives", ({ entry, cfg }) => {
      return checkLoopGuard(entry, "write me a full implementation", 200, cfg);
    }],
    then: ["window cleared, no block", (r, { entry }) => {
      expect(r.block).toBe(false);
      expect(entry.last_msgs.length).toBe(0);
      expect(entry.last_warning_ts).toBeNull();
    }],
  });
});

feature("checkLoopGuard: disabled", () => {
  unit("enabled=false short-circuits — nothing blocks, nothing stored", {
    given: ["disabled config", () => ({ entry: emptyEntry(), cfg: config({ enabled: false }) })],
    when: ["10 identical '0's", ({ entry, cfg }) => {
      const results = [];
      for (let i = 0; i < 10; i++) results.push(checkLoopGuard(entry, "0", i * 100, cfg));
      return { results, entry };
    }],
    then: ["no blocks, window untouched", ({ results, entry }) => {
      for (const r of results) expect(r.block).toBe(false);
      expect(entry.last_msgs.length).toBe(0);
    }],
  });
});

feature("checkLoopGuard: edge cases", () => {
  unit("empty message = not short (zero length doesn't count as loop candidate)", {
    given: ["fresh entry", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["empty string 3 times", ({ entry, cfg }) => {
      const r1 = checkLoopGuard(entry, "", 0, cfg);
      const r2 = checkLoopGuard(entry, "", 100, cfg);
      const r3 = checkLoopGuard(entry, "", 200, cfg);
      return { r1, r2, r3, entry };
    }],
    then: ["no blocks, window empty (empty msg is treated as 'not short')", ({ r3, entry }) => {
      expect(r3.block).toBe(false);
      expect(entry.last_msgs.length).toBe(0);
    }],
  });

  unit("case-insensitive + trim: '0 ' and '0' treated as identical", {
    given: ["fresh entry", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["'0', ' 0 ', '0\\n'", ({ entry, cfg }) => {
      const r1 = checkLoopGuard(entry, "0", 0, cfg);
      const r2 = checkLoopGuard(entry, " 0 ", 100, cfg);
      const r3 = checkLoopGuard(entry, "0\n", 200, cfg);
      return r3;
    }],
    then: ["blocks on 3rd", (r3) => {
      expect(r3.block).toBe(true);
    }],
  });

  unit("'HEJ' and 'hej' are identical (lowercased)", {
    given: ["fresh entry", () => ({ entry: emptyEntry(), cfg: config() })],
    when: ["HEJ, hej, Hej", ({ entry, cfg }) => {
      checkLoopGuard(entry, "HEJ", 0, cfg);
      checkLoopGuard(entry, "hej", 100, cfg);
      return checkLoopGuard(entry, "Hej", 200, cfg);
    }],
    then: ["blocks on 3rd", (r) => expect(r.block).toBe(true)],
  });
});

feature("readLoopGuardConfig", () => {
  unit("defaults when env vars absent", {
    when: ["reading empty env", () => readLoopGuardConfig({})],
    then: ["returns defaults", (cfg) => {
      expect(cfg.enabled).toBe(DEFAULTS.enabled);
      expect(cfg.threshold).toBe(DEFAULTS.threshold);
      expect(cfg.windowMs).toBe(DEFAULTS.windowMs);
      expect(cfg.shortLen).toBe(DEFAULTS.shortLen);
    }],
  });

  unit("env overrides apply", {
    when: ["reading custom env", () => readLoopGuardConfig({
      LOOP_GUARD_THRESHOLD: "5",
      LOOP_GUARD_WINDOW_MS: "60000",
      LOOP_GUARD_SHORT_LEN: "20",
      LOOP_GUARD_ENABLED: "true",
    })],
    then: ["custom values used", (cfg) => {
      expect(cfg.threshold).toBe(5);
      expect(cfg.windowMs).toBe(60000);
      expect(cfg.shortLen).toBe(20);
      expect(cfg.enabled).toBe(true);
    }],
  });

  unit("LOOP_GUARD_ENABLED=false disables", {
    when: ["env has ENABLED=false", () => readLoopGuardConfig({ LOOP_GUARD_ENABLED: "false" })],
    then: ["enabled is false", (cfg) => expect(cfg.enabled).toBe(false)],
  });
});

feature("loopGuardKey", () => {
  unit("builds pane-key from agent + pane index", {
    when: ["building key", () => loopGuardKey("claw", 5)],
    then: ["returns 'claw:5'", (k) => expect(k).toBe("claw:5")],
  });
});

feature("formatLoopGuardWarning", () => {
  unit("short text: shown verbatim", {
    when: ["formatting", () => formatLoopGuardWarning({ text: "0", count: 3, ageSec: 2 })],
    then: ["contains text, count, age", (s) => {
      expect(s).toContain("'0'");
      expect(s).toContain("× 3");
      expect(s).toContain("in 2s");
      expect(s).toContain("amux esc");
    }],
  });

  unit("long text: truncates to 20 chars with ellipsis", {
    when: ["formatting 30-char text", () => formatLoopGuardWarning({
      text: "a".repeat(30), count: 5, ageSec: 10,
    })],
    then: ["preview is 17 chars + ellipsis", (s) => {
      expect(s).toContain("'" + "a".repeat(17) + "…'");
    }],
  });
});
