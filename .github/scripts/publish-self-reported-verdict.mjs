export const STATUS_CONTEXT = "broker-verdict (self-reported)";

const requiredText = (value, name, maxLength) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} is required and must be at most ${maxLength} characters`);
  }
  return normalized;
};

const evidenceUrl = (value, owner, repo, pullNumber) => {
  const raw = requiredText(value, "evidence_url", 500);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("evidence_url must be an absolute GitHub pull-request comment URL");
  }
  const expectedPath = `/${owner}/${repo}/pull/${pullNumber}`.toLowerCase();
  const reference = parsed.hash.match(/^#(issuecomment|pullrequestreview)-(\d+)$/);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com"
    || parsed.pathname.toLowerCase() !== expectedPath
    || !reference) {
    throw new Error("evidence_url must point to a comment or review on the selected pull request");
  }
  const id = Number(reference[2]);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error("evidence_url contains an invalid comment or review ID");
  }
  return { href: parsed.href, kind: reference[1], id };
};

const evidenceMarker = ({ verdict, reviewer, headSha }) =>
  `<!-- broker-verdict:self-reported:v1 verdict=${verdict} reviewer=${reviewer} head=${headSha} -->`;

const verifyEvidence = async ({ github, owner, repo, pullNumber, evidence,
  verdict, reviewer, headSha }) => {
  let body;
  let htmlUrl;
  if (evidence.kind === "issuecomment") {
    const { data: comment } = await github.rest.issues.getComment({
      owner,
      repo,
      comment_id: evidence.id,
    });
    const issuePath = `/repos/${owner}/${repo}/issues/${pullNumber}`.toLowerCase();
    let actualIssuePath = "";
    try {
      actualIssuePath = new URL(comment.issue_url).pathname.toLowerCase();
    } catch {
      throw new Error("the evidence comment has an invalid issue reference");
    }
    if (actualIssuePath !== issuePath) {
      throw new Error("the evidence comment belongs to another pull request");
    }
    body = comment.body;
    htmlUrl = comment.html_url;
  } else {
    const { data: review } = await github.rest.pulls.getReview({
      owner,
      repo,
      pull_number: pullNumber,
      review_id: evidence.id,
    });
    if (review.state !== "COMMENTED" || review.commit_id?.toLowerCase() !== headSha) {
      throw new Error("the evidence review is not a comment-only review on the selected head");
    }
    body = review.body;
    htmlUrl = review.html_url;
  }
  if (new URL(htmlUrl).href !== evidence.href) {
    throw new Error("evidence_url does not match the fetched GitHub evidence");
  }
  if (typeof body !== "string" || !body.includes(evidenceMarker({ verdict, reviewer, headSha }))) {
    throw new Error("the evidence is missing the exact self-reported verdict marker");
  }
};

export const publishSelfReportedVerdict = async ({ github, context, inputs }) => {
  const pullNumber = Number(inputs.pull_request);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error("pull_request must be a positive integer");
  }

  const headSha = requiredText(inputs.head_sha, "head_sha", 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("head_sha must be a full 40-character commit SHA");
  }
  const verdict = requiredText(inputs.verdict, "verdict", 8).toLowerCase();
  if (verdict !== "pass" && verdict !== "hold") {
    throw new Error("verdict must be pass or hold");
  }
  const reviewer = requiredText(inputs.reviewer, "reviewer", 64).toLowerCase();
  if (!/^[a-z][a-z0-9-]*:[1-9]\d*$/.test(reviewer)) {
    throw new Error("reviewer must be an agent pane such as lsrc:2");
  }

  const { owner, repo } = context.repo;
  const evidence = evidenceUrl(inputs.evidence_url, owner, repo, pullNumber);
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (pull.state !== "open") {
    throw new Error("the selected pull request is not open");
  }
  if (pull.head.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error("the pull-request head must belong to this repository");
  }
  if (pull.head.sha.toLowerCase() !== headSha) {
    throw new Error(`stale verdict: current pull-request head is ${pull.head.sha}`);
  }
  await verifyEvidence({ github, owner, repo, pullNumber, evidence,
    verdict, reviewer, headSha });

  const state = verdict === "pass" ? "success" : "failure";
  const label = verdict === "pass" ? "PASS" : "HOLD";
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state,
    context: STATUS_CONTEXT,
    description: `Freshness only: self-reported ${label} by ${reviewer}`,
    target_url: evidence.href,
  });
  return { pullNumber, headSha, reviewer, verdict, state, targetUrl: evidence.href };
};
