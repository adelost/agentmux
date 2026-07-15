import { feature, unit, expect } from "bdd-vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

feature("fleet progress command routing", () => {
  unit("amux queue can never be mistaken for a configured agent target", {
    given: ["the cron command allowlist", () =>
      readFileSync(join(REPO, "bin", "fleet-progress-cron.sh"), "utf-8")],
    when: ["reading its reserved command ledger", (source) =>
      source.match(/^RESERVED_CMDS="([^"]+)"/m)?.[1] || ""],
    then: ["the queue CLI is reserved", (commands) => {
      expect(` ${commands.trim()} `).toContain(" queue ");
    }],
  });
});
