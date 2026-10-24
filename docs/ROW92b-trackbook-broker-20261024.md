# Trackbook opt-in broker login

Owner api:4, sole writer in /home/adelost/lsrc/trackbook-92b-api4-20261024.
lsrc:3 accepted92r6e3bd4b6 and authorized exactly this clean GitHub-main copy.
Base8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd. Historical canonical and its
16 WIP paths/index remain untouched; no env, credential or database is copied.
92r remains a completed separate read phase; its consent feature is not done.

Actual92b start24October17:55:42Z. Original2h deadline19:55:42Z,
checkpoint18:15:42Z,150%stop20:55:42Z. Active time is not measured.

## File plan before code

- Reuse @v1d/auth-client from the existing broker client package; update app
  package/lock. Broker app id trackbook, exact callback
  https://skyvw.app/auth/callback, identity scope only.
- Add one additive D1 migration for unique broker identity to existing users.id
  links and short-lived, browser/session-bound, one-use transactions. No new
  user, Better Auth identity, passkey or device row is created by linking.
- Add bounded src/lib/server/auth/broker-store.ts and broker.ts helpers and
  auth/v1d plus exact callback route adapters. Validate an actual existing
  passkey or Better Auth session, exact Origin and CSRF for explicit linking;
  reject bearer/Basic-only authority, conflicts, wrong browser/session, expired
  and replayed transactions. Email never participates in mapping.
- Reuse existing30day local session creation for mapped broker re-login and
  existing account-pause/erasure fences. Linking returns without replacing the
  old local or Better Auth cookie. Existing Google and passkey paths remain.
  Extend hook public-path admission and logout's pending-broker cleanup only.
- Extend existing settings load and compose a small v1d sign-in row through
  its existing host snippet, using the shared account-section/button styles.
  Keep generated UI ownership intact. Add secondary Sign in with v1d to the
  existing sign-in page and concise unlinked/error recovery. No extra page or
  renderer. Verify actual390/1280 entry, connected profile and return flow.
- Add focused D1/route tests for atomic mapping, replay, conflicts, CSRF,
  cookie continuity and account fences. Use the current local synthetic
  account/browser proof path; real production OAuth remains an operator action.
- Register trackbook at the existing broker only after matching independent
  CLIENT_SECRET_TRACKBOOK and Pages V1D_AUTH_CLIENT_SECRET bindings are accepted
  through ordinary Wrangler stdin provisioning. No values printed/saved. Read
  source/deployment receipts before every operational action.

The existing edge already sends /auth/* to account Pages and preserves the
sole skyvw.app browser origin. No edge behavior change is presently needed.
Run current check/build, relevant auth tests, edge routing tests and one real
local browser smoke. Use the repository's normal deploy path, with exact
source, prior Pages/Worker/broker deployments, additive migration receipt and
live readback. Keep the old Google path after the opt-in release; full real
account proof is separate from synthetic workerd evidence. Legacy stays.

Estimate within2h: identity/storage/routes45min, focused tests/local flow25min,
profile/entry and actual images20min, provision/release/live30min. These are
owner estimates, not additional phases or a restarted clock. At the budget,
bank the verified part and exact remaining boundary.

## Safe account-switch bank,24October18:40Z

Current lsrc:3 account instruction requests the ordinary safe A path at the
nearest boundary, with exact session, no force/fresh session/credit override
and no budget reset. api:4 is still listed onW. Ordinary dry preview of
codex:1 forapi:4 returns would-defer(working); an A switch is not yet verified.
The current read shows A5h69%used/week26%used; the mover must read both windows
again at the actual switch. No account credentials are copied by this feature.

Banked source: app59511408650a49a44367fcbfb9b5d42374c88855 is clean and pushed
to feat/broker-login-92b-api4-20261024, not main. Brokerc235a34dc1da87e8b0d8818f5001c3b832f1bacc
is onmain; its Trackbook registration has not been deployed. Both independent
secret bindings are accepted through Wrangler stdin and the generated value
was absent from3 owned logs. Read provision-receipt.json; never regenerate or
repeat it on resume. Existing production Pages/source remains unchanged.

Verified on the final app source:318tests, TypeScript and cache gate;14edge
tests and product-copy smoke. Broker134tests/build/dry-run pass. Actual built
Pages/workerd with local D1 completed existing-session link, logout and mapped
login, same owner/accountKey, unchanged cookie/passkey row/device row and
unlinked recovery.390/1280 images were opened. The provider boundary was
synthetic, with Basic authentication, exact callback, PKCE and one-use codes;
redirect-only transport wrappers are documented in browser-proof.json.
Initial local fixture startup/navigation/teardown failures were corrected;
the final browser process exits0 with no page errors and closes its browser.

No D1 production migration, broker registry deploy or app/edge release has
started. Own local proof server8936 and headless browser are closed. The old
canonical's16 source paths, deletion state and index are verified unchanged.

Resume only after ordinary tooling proves the same session is onA. Then read
these receipts, fetch/reconcile source, merge the verified app to currentmain,
deploy the broker once with its current version as rollback, apply only the
additive broker-links migration once, and run scripts/deploy.sh from the clean
approved copy. Record versions and anonymous live390/1280/bytes/perimeter.
An authorized operator's real existing-account proof still remains after the
opt-in release. Old Google/passkeys and Legacy remain. Deadlines19:55:42Z and
20:55:42Z continue across the account wait; a late continuation needs a bounded
decision, not a new clock.

Aggregate receipt: /home/adelost/lsrc/.artifacts/shared-login-92b-api4-20261024/receipt.json.
