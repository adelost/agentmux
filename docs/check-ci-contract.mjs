import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { publishSelfReportedVerdict, STATUS_CONTEXT } from
  "../.github/scripts/publish-self-reported-verdict.mjs";

assert.equal(
  existsSync(new URL("../.github/workflows/pull-request.yml", import.meta.url)),
  false,
  "GitHub pull-request CI must stay absent; verification is local and targeted",
);

const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const context = { repo: { owner: "adelost", repo: "agentmux" } };
const inputs = {
  pull_request: "49",
  head_sha: SHA,
  verdict: "pass",
  reviewer: "lsrc:2",
  evidence_url: "https://github.com/adelost/agentmux/pull/49#issuecomment-123",
};
assert.equal(STATUS_CONTEXT, "broker-verdict (self-reported)",
  "the public status name must disclose that the verdict is self-reported");
const markerFor = (receipt) =>
  `<!-- broker-verdict:self-reported:v1 verdict=${receipt.verdict} reviewer=${receipt.reviewer} head=${receipt.head_sha} -->`;

const harness = ({ headSha = SHA, state = "open", fullName = "adelost/agentmux",
  evidenceInputs = inputs, evidenceBody = markerFor(evidenceInputs), issueNumber = 49,
  reviewState = "COMMENTED", reviewSha = headSha } = {}) => {
  const statuses = [];
  return {
    statuses,
    github: {
      rest: {
        pulls: { get: async () => ({ data: { state, head: { sha: headSha,
          repo: { full_name: fullName } } } }), getReview: async () => ({ data: {
          state: reviewState, commit_id: reviewSha, body: evidenceBody,
          html_url: evidenceInputs.evidence_url,
        } }) },
        issues: { getComment: async () => ({ data: {
          body: evidenceBody,
          html_url: evidenceInputs.evidence_url,
          issue_url: `https://api.github.com/repos/adelost/agentmux/issues/${issueNumber}`,
        } }) },
        repos: { createCommitStatus: async (status) => statuses.push(status) },
      },
    },
  };
};

const passing = harness();
const passReceipt = await publishSelfReportedVerdict({ github: passing.github, context, inputs });
assert.equal(passReceipt.state, "success");
assert.equal(passing.statuses.length, 1);
assert.deepEqual(passing.statuses[0], {
  owner: "adelost",
  repo: "agentmux",
  sha: SHA,
  state: "success",
  context: STATUS_CONTEXT,
  description: "Freshness only: self-reported PASS by lsrc:2",
  target_url: inputs.evidence_url,
});

const holdInputs = { ...inputs, verdict: "hold" };
const holding = harness({ evidenceInputs: holdInputs });
await publishSelfReportedVerdict({ github: holding.github, context,
  inputs: holdInputs });
assert.equal(holding.statuses[0].state, "failure");
assert.match(holding.statuses[0].description, /self-reported HOLD/);

const reviewInputs = { ...inputs,
  evidence_url: "https://github.com/adelost/agentmux/pull/49#pullrequestreview-456" };
const reviewEvidence = harness({ evidenceInputs: reviewInputs });
await publishSelfReportedVerdict({ github: reviewEvidence.github, context, inputs: reviewInputs });
assert.equal(reviewEvidence.statuses[0].state, "success");

const amended = harness({ headSha: NEXT_SHA });
await assert.rejects(
  publishSelfReportedVerdict({ github: amended.github, context, inputs }),
  /stale verdict/,
);
assert.equal(amended.statuses.length, 0,
  "an amended head must never inherit the old self-reported verdict");

const unmarked = harness({ evidenceBody: "PASS, but without the machine-verifiable marker." });
await assert.rejects(publishSelfReportedVerdict({ github: unmarked.github, context, inputs }),
  /missing the exact/);
assert.equal(unmarked.statuses.length, 0);

const foreignComment = harness({ issueNumber: 50 });
await assert.rejects(publishSelfReportedVerdict({ github: foreignComment.github, context, inputs }),
  /another pull request/);
assert.equal(foreignComment.statuses.length, 0);

for (const invalid of [
  { ...inputs, head_sha: SHA.slice(1) },
  { ...inputs, verdict: "approve" },
  { ...inputs, reviewer: "adelost" },
  { ...inputs, evidence_url: "https://example.com/review" },
]) {
  const target = harness();
  await assert.rejects(publishSelfReportedVerdict({ github: target.github, context,
    inputs: invalid }));
  assert.equal(target.statuses.length, 0);
}

const closed = harness({ state: "closed" });
await assert.rejects(publishSelfReportedVerdict({ github: closed.github, context, inputs }),
  /not open/);
assert.equal(closed.statuses.length, 0);

console.log("Verification contract: GitHub PR CI absent; current-head PASS/HOLD receipts verified");
