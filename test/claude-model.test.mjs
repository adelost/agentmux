import { feature, unit, expect } from "bdd-vitest";
import { normalizeClaudeModelName } from "../core/claude-model.mjs";

feature("normalizeClaudeModelName: spoken forms become wire ids", () => {
  unit("`opus 4.8` → `claude-opus-4-8`", {
    given: ["what a human types in Discord", () => "opus 4.8"],
    when: ["normalizing", (raw) => normalizeClaudeModelName(raw)],
    then: ["the wire id Claude Code accepts", (r) => {
      expect(r.ok).toBe(true);
      expect(r.model).toBe("claude-opus-4-8");
    }],
  });

  unit("spacing and `claude` prefix are optional", {
    given: ["three spellings of the same model", () => ["opus4.8", "claude opus 4.8", "OPUS 4.8"]],
    when: ["normalizing each", (raws) => raws.map((r) => normalizeClaudeModelName(r).model)],
    then: ["all resolve to one id", (models) => {
      expect(models).toEqual(["claude-opus-4-8", "claude-opus-4-8", "claude-opus-4-8"]);
    }],
  });

  unit("a major-only version keeps its shape", {
    given: ["`sonnet 5`", () => "sonnet 5"],
    when: ["normalizing", (raw) => normalizeClaudeModelName(raw)],
    then: ["no trailing separator is invented", (r) => expect(r.model).toBe("claude-sonnet-5")],
  });

  unit("the `[1m]` context suffix survives normalization", {
    given: ["`opus 4.8 [1m]`", () => "opus 4.8 [1m]"],
    when: ["normalizing", (raw) => normalizeClaudeModelName(raw)],
    then: ["suffix is re-attached to the wire id", (r) => expect(r.model).toBe("claude-opus-4-8[1m]")],
  });
});

feature("normalizeClaudeModelName: already-valid names pass through", () => {
  unit("aliases and full ids are untouched", {
    given: ["names Claude Code resolves itself", () => ["opus", "opusplan", "opusplan[1m]", "claude-opus-4-5-20251101"]],
    when: ["normalizing each", (raws) => raws.map((r) => normalizeClaudeModelName(r).model)],
    then: ["identical output", (models) => {
      expect(models).toEqual(["opus", "opusplan", "opusplan[1m]", "claude-opus-4-5-20251101"]);
    }],
  });

  unit("`opusplan` is not mistaken for the `opus` family", {
    given: ["an alias that starts with a family name", () => "opusplan"],
    when: ["normalizing", (raw) => normalizeClaudeModelName(raw)],
    then: ["it stays an alias", (r) => expect(r.model).toBe("opusplan")],
  });
});

feature("normalizeClaudeModelName: rejection explains itself", () => {
  unit("free text is rejected with a reason and a hint", {
    given: ["a typo'd Discord message", () => "byt till opus tack"],
    when: ["normalizing", (raw) => normalizeClaudeModelName(raw)],
    then: ["rejected, and the caller can say why", (r) => {
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("spaces");
      expect(r.hint).toContain("claude-opus-4-8");
    }],
  });

  unit("empty input is rejected", {
    given: ["whitespace only", () => "   "],
    when: ["normalizing", (raw) => normalizeClaudeModelName(raw)],
    then: ["rejected as empty", (r) => {
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("empty model name");
    }],
  });
});
