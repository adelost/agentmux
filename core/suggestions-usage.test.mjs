import { component, expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import {
  buildRowsReadAlert,
  classifyRowsReadUsage,
  queryDurableObjectsRowsRead,
  usagePeriodWindow,
} from "./suggestions-usage.mjs";

feature("Suggestions Durable Object rows-read observability", () => {
  unit("daily windows follow Cloudflare's 00:00 UTC reset", {
    given: ["a timestamp after midnight in Stockholm", () => Date.parse("2026-07-16T00:30:00+02:00")],
    when: ["building a daily analytics window", (nowMs) => usagePeriodWindow("daily", nowMs)],
    then: ["the period is the current UTC day, not the local calendar day", (window) => {
      expect(window).toEqual({
        key: "2026-07-15",
        start: "2026-07-15T00:00:00.000Z",
        end: "2026-07-15T22:30:00.000Z",
      });
    }],
  });

  unit("warning is emitted before the configured rows-read cliff", {
    given: ["a five-million operational budget with explicit tiers", () => ({
      budgetRows: 5_000_000, warnAt: 0.7, criticalAt: 0.9,
    })],
    when: ["classifying 3.6 million observed rows", (policy) =>
      classifyRowsReadUsage({ rowsRead: 3_600_000, ...policy })],
    then: ["the signal is warning with exact ratio and remaining rows", (usage) => {
      expect(usage).toEqual({ tier: "warning", rowsRead: 3_600_000,
        budgetRows: 5_000_000, ratio: 0.72, remainingRows: 1_400_000 });
    }],
  });

  component("GraphQL aggregation reports exact account rows without causal attribution", {
    given: ["Cloudflare periodic groups for two Suggestions objects and one other namespace", () => {
      const fetchImpl = vi.fn(async (_url, init) => {
        const request = JSON.parse(init.body);
        return Response.json({ data: { viewer: { accounts: [{
          durableObjectsPeriodicGroups: [
            { dimensions: { namespaceId: "suggestions", name: "project:source" },
              sum: { rowsRead: 1_200_000, rowsWritten: 10 } },
            { dimensions: { namespaceId: "suggestions", name: "project:skydive" },
              sum: { rowsRead: 2_400_000, rowsWritten: 20 } },
            { dimensions: { namespaceId: "other", name: "other:1" },
              sum: { rowsRead: 50, rowsWritten: 1 } },
          ],
        }] } } });
      });
      return { fetchImpl };
    }],
    when: ["querying the account's current UTC-day usage", async ({ fetchImpl }) => ({
      result: await queryDurableObjectsRowsRead({
        accountId: "a".repeat(32), token: "t".repeat(40), period: "daily",
        nowMs: Date.parse("2026-07-15T12:00:00Z"), fetchImpl,
      }),
      request: JSON.parse(fetchImpl.mock.calls[0][1].body),
    })],
    then: ["all namespaces are included and the query uses Cloudflare's rowsRead sum", ({ result, request }) => {
      expect(result.rowsRead).toBe(3_600_050);
      expect(result.groups).toEqual([
        { namespaceId: "suggestions", name: "project:skydive", rowsRead: 2_400_000,
          rowsWritten: 20 },
        { namespaceId: "suggestions", name: "project:source", rowsRead: 1_200_000,
          rowsWritten: 10 },
        { namespaceId: "other", name: "other:1", rowsRead: 50, rowsWritten: 1 },
      ]);
      expect(request.query).toContain("durableObjectsPeriodicGroups");
      expect(request.query).toContain("rowsRead");
      expect(request.variables.accountTag).toBe("a".repeat(32));
    }],
  });

  unit("alerts name the evidence and keep root-cause attribution unknown", {
    given: ["a critical exact analytics snapshot", () => ({
      periodKey: "2026-07-15", tier: "critical", rowsRead: 4_700_000,
      budgetRows: 5_000_000, ratio: 0.94, remainingRows: 300_000,
      groups: [{ namespaceId: "ns", name: "project:skydive", rowsRead: 3_000_000,
        rowsWritten: 20 }],
    })],
    when: ["rendering the broker warning", (snapshot) => buildRowsReadAlert(snapshot)],
    then: ["the prompt cites analytics and refuses to guess the producer", (alert) => {
      expect(alert.idempotencyKey).toBe("suggestions-rows-read:2026-07-15:critical");
      expect(alert.prompt).toContain("Cloudflare Analytics");
      expect(alert.prompt).toContain("4,700,000 / 5,000,000");
      expect(alert.prompt).toContain("Orsaksattribution: okänd");
    }],
  });
});
