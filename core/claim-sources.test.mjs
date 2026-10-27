import { expect, feature, integration } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createClaimSources } from "./claim-sources.mjs";
import { checkReply } from "./claim-guard.mjs";

feature("citations use remote-default source", () => {
  integration("local-only source and non-existent lines cannot qualify", {
    given: ["a real temporary Git repository with different remote and local bytes", () => {
      const dir = mkdtempSync(join(tmpdir(), "claim-source-"));
      const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
      writeFileSync(join(dir, "service.mjs"), "export const ready = true;\n");
      git("add", "service.mjs"); git("commit", "-m", "remote baseline");
      const sha = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", sha);
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      writeFileSync(join(dir, "local.mjs"), "local only");
      return { dir, sha };
    }],
    when: ["checking through the same public module as the mirror", ({ dir, sha }) => {
      const sources = createClaimSources([dir]);
      return { dir, values: [
        checkReply("Tjänsten är klar, `service.mjs:1`.", sources).verdict,
        checkReply("Tjänsten är klar, `service.mjs:50`.", sources).verdict,
        checkReply("Tjänsten är klar, `local.mjs:1`.", sources).verdict,
        checkReply(`Tjänsten är klar, ${sha}.`, sources).verdict,
        checkReply("Tjänsten är klar, deadbeefdeadbeef.", sources).verdict,
        checkReply(`Ingen version finns. \`git grep missing ${sha} -- ./\`, output: 0 träffar.`, sources).verdict,
      ] };
    }],
    then: ["only the actual remote file/line, SHA and scoped denial pass", ({ values }) => expect(values).toEqual(["pass", "hold", "hold", "pass", "hold", "hold"])],
    cleanup: ({ dir }) => rmSync(dir, { recursive: true, force: true }),
  });
});
