import { feature, unit, expect } from "bdd-vitest";
import { mapWithConcurrency } from "./concurrency.mjs";

feature("bounded async concurrency", () => {
  unit("preserves order without exceeding the worker limit", {
    given: ["six tasks and a two-worker pool", () => ({ active: 0, maxActive: 0 })],
    when: ["all tasks run", async (ctx) => {
      const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
        ctx.active++;
        ctx.maxActive = Math.max(ctx.maxActive, ctx.active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        ctx.active--;
        return value * 10;
      });
      return { ...ctx, results };
    }],
    then: ["at most two overlap and result order is stable", ({ maxActive, results }) => {
      expect(maxActive).toBe(2);
      expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    }],
  });
});
