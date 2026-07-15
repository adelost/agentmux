# Pull request gate

Every pull request to `master` runs the repository-owned `Pull request gate` on
a GitHub-hosted runner. The stable required-check name is `Required test`. It
installs exactly `package-lock.json` and runs the Vitest suite through
`npm run ci`. The workflow installs ripgrep for the real search integration;
the exact Codex CLI used by the execpolicy contract is a locked dev dependency.
Agentmux has no compile/typecheck build step; setup, native runtime canaries,
and visual gates are intentionally not smuggled into the fast default PR gate.

The workflow has only `contents: read` permission. It receives no Suggestions,
Discord, model-provider, or deployment credentials and cannot mutate fleet
state.

Repository rules must require both `Required test` and `broker-verdict
(self-reported)` for `master`. Until that rule is enabled, the checks are
machine evidence but not a merge fence.

Enable the two required contexts for administrators as well as ordinary
writers. Do not enable a required native approval count until a distinct
authenticated reviewer principal exists; otherwise every pull request becomes
unmergeable by construction.

## Review identity

CI makes the test claim machine-verifiable; it does not establish an
independent reviewer. Today every pull request and review request authenticates
to GitHub as the same account, so GitHub correctly refuses a native approval on
that account's own pull request.

Changing only Git's `user.name` or `user.email` improves commit attribution but
does not change the authenticated pull-request author or reviewer. A native
review fence needs a separate least-privilege GitHub principal, such as a
broker-only GitHub App with pull-request review permission. That identity and
credential boundary require an explicit fleet decision.

Until that principal exists, the broker may publish the deliberately named
`broker-verdict (self-reported)` status. It proves only that a recorded
`pass`/`hold` verdict names the pull request's **current, full head SHA**. A new
commit receives no inherited status and therefore needs a new verdict. It does
not prove who performed the review and must never be described as an approval.

After posting the human-readable verdict as a PR comment, dispatch its exact
head and comment URL:

```bash
REPO=adelost/agentmux
PR=49
HEAD_SHA="$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)"
COMMENT_BODY="$(printf '%s\n\n%s\n' \
  "<!-- broker-verdict:self-reported:v1 verdict=pass reviewer=lsrc:2 head=$HEAD_SHA -->" \
  'Broker verdict: PASS (self-reported; freshness only).')"
EVIDENCE_URL="$(jq -n --arg body "$COMMENT_BODY" '{body: $body}' | \
  gh api --method POST "repos/$REPO/issues/$PR/comments" --input - --jq .html_url)"

jq -n --arg pr "$PR" --arg head "$HEAD_SHA" --arg url "$EVIDENCE_URL" '{
  event_type: "self-reported-verdict",
  client_payload: {
    pull_request: $pr,
    head_sha: $head,
    verdict: "pass",
    reviewer: "lsrc:2",
    evidence_url: $url
  }
}' | gh api --method POST "repos/$REPO/dispatches" --input -
```

Use `verdict: "hold"` to publish a failing status. The publisher rejects stale
SHAs, closed PRs, forks, malformed pane identities, and evidence URLs that do
not point back to the selected PR. The comment or comment-only review must
contain the exact hidden marker for the submitted verdict, pane, and SHA; prose
alone can never produce the status.
