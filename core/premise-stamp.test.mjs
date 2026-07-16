import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  captureBriefPremise,
  premiseEnvelope,
  referencedPullRequests,
  verifyBriefPremise,
} from "./premise-stamp.mjs";

function git(...args) {
  return String(execFileSync("git", args, { encoding: "utf8" })).trim();
}

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-premise-"));
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  git("init", "--bare", bare);
  git("init", "-b", "main", work);
  git("-C", work, "config", "user.email", "premise@example.invalid");
  git("-C", work, "config", "user.name", "Premise Test");
  writeFileSync(join(work, "state.txt"), "one\n");
  git("-C", work, "add", "state.txt");
  git("-C", work, "commit", "-m", "one");
  git("-C", work, "remote", "add", "origin", bare);
  git("-C", work, "push", "-u", "origin", "main");
  git("-C", work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { root, bare, work, head: git("-C", work, "rev-parse", "HEAD") };
}

const ticketFetch = async () => Response.json({
  ticket: { id: "SRC-0093", revision: 5, status: "in_progress", updatedAt: 1_000,
    assignment: { id: 68, generation: 1, state: "active",
      members: [{ role: "owner", agentId: "lsrc:6" }] } },
  mergeCandidates: [{ number: 57, state: "open", headSha: "a".repeat(40) }],
  merges: [],
  completion: null,
});

describe("inter-agent premise stamps", () => {
  it("recognizes a contextual bare PR reference without treating a comment number as a PR", () => {
    expect(referencedPullRequests("Din #57 är bankad; läs kommentar #14.")).toEqual([57]);
  });

  it("verifies the canonical cross-service hash vector emitted by Suggestions", async () => {
    const stamp = {
      schemaVersion: 1,
      producer: "amux.premise-proof.v1",
      observedAt: 4_600_003,
      selectors: { sender: "Project broker", repository: null, pullRequests: [],
        tickets: [{ projectId: "source", ticketId: "SRC-0001" }] },
      basis: { repository: null, referencedBaseShas: [], pullRequests: [], board: [{
        projectId: "source", ticketId: "SRC-0001", revision: 5, status: "in_progress",
        updatedAt: 4_600_003,
        assignment: { id: 1, generation: 1, state: "waiting", ownerAgentId: "lsrc:4" },
      }] },
      attestationHash: "sha256:bb53b13ca6a9b9ac12eed76ef10094c30ad3b88294003de43dbef1ad7cbbfd68",
    };
    const fetchImpl = async () => Response.json({ ticket: {
      id: "SRC-0001", revision: 5, status: "in_progress", updatedAt: 4_600_003,
      assignment: { id: 1, generation: 1, state: "waiting",
        members: [{ role: "owner", agentId: "lsrc:4" }] },
    } });
    await expect(verifyBriefPremise(stamp, { readToken: "r".repeat(40), fetchImpl }))
      .resolves.toEqual({ status: "valid", mismatches: [] });
  });

  it("red-first: detects a moved trunk before the queued brief reaches the receiver", async () => {
    const repo = repositoryFixture();
    try {
      const stamp = await captureBriefPremise(
        `Rebase SRC-0093 onto main ${repo.head.slice(0, 7)} before reviewing.`, {
          sender: "lsrc:2", repoPath: repo.work, observedAt: 2_000,
          readToken: "r".repeat(40), fetchImpl: ticketFetch,
        });
      expect(stamp).toMatchObject({ schemaVersion: 1, producer: "amux.premise-proof.v1",
        observedAt: 2_000,
        basis: { repository: { headSha: repo.head, baseHeadSha: repo.head },
          board: [{ projectId: "source", ticketId: "SRC-0093", revision: 5 }] } });
      expect(premiseEnvelope(stamp)).toContain(stamp.attestationHash);
      expect(premiseEnvelope(stamp)).toContain(JSON.stringify(stamp));
      await expect(verifyBriefPremise(stamp, {
        readToken: "r".repeat(40), fetchImpl: ticketFetch,
      })).resolves.toEqual({ status: "valid", mismatches: [] });

      writeFileSync(join(repo.work, "state.txt"), "two\n");
      git("-C", repo.work, "add", "state.txt");
      git("-C", repo.work, "commit", "-m", "two");
      git("-C", repo.work, "push", "origin", "main");

      const result = await verifyBriefPremise(stamp, {
        readToken: "r".repeat(40), fetchImpl: ticketFetch,
      });
      expect(result).toMatchObject({ status: "stale", mismatches: ["repository"] });
      await expect(captureBriefPremise(
        `Rebase SRC-0093 onto main ${repo.head.slice(0, 7)}.`, {
          sender: "lsrc:2", repoPath: repo.work, observedAt: 3_000,
          readToken: "r".repeat(40), fetchImpl: ticketFetch,
        })).rejects.toThrow(/premise already stale/u);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("rejects a mutated stamp identity without consulting external state", async () => {
    const result = await verifyBriefPremise({
      schemaVersion: 1, producer: "amux.premise-proof.v1", observedAt: 1,
      selectors: {}, basis: {}, attestationHash: "sha256:bad",
    });
    expect(result).toEqual({ status: "stale", mismatches: ["identity"] });
  });
});
