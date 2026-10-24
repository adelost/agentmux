# Trackbook opt-in broker login

Owner api:4, sole writer in /home/adelost/lsrc/trackbook-92b-api4-20261024.
lsrc:3 accepted92r6e3bd4b6 and authorized exactly this clean GitHub-main copy.
Base8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd. Historical canonical and its
16 WIP paths/index remain untouched; no env, credential or database is copied.
92r remains a completed separate read phase; its consent feature is not done.

Actual92b start24October17:55:42Z. Original2h deadline19:55:42Z,
checkpoint18:15:42Z,150%stop20:55:42Z. Active time is not measured.

## Current publication,24October18:57Z

Opt-in is live at https://skyvw.app/signin. App5951140 is on remote main and
production Pages c186a81e-9ae0-4a6f-8aa8-76e150ad9ae3. Broker c235a34 runs
version2d10c617-d0a0-40af-a1ea-2f887f880f2f at100%, health200. The ordinary
release also published edge c6902fce-d2c6-4c4d-8de8-7ca2f32c49f8. This is
one Trackbook owner/database, with old Google/password/passkeys retained.

The ordinary account switch is verified onA in the exact native session
01a16de5-2dd4-7b53-b4fa-e94b30aa0650. Actual18:50Z quota:5h74%used,
week27%used. No parallelW work, fresh session or clock reset.

The single additive migration submission completed. The receipt parser first
rejected Wrangler's progress prefix; no SQL was resent. Independent sqlite_master
comparison matches all3 exact objects, and6 PRAGMA reads confirm columns,
unique indexes, owner references and expiry index. Reconciliation wrote0rows.

Final source:318app tests,134broker tests,14edge tests, check/cache/copy/build;
fresh pre-merge14identity/session tests in4.61s. Normal release check/build and
14edge tests pass. Actual local Pages/D1 browser proof preserves the old cookie,
owner/accountKey/passkey/device rows across link/logout/login. Its broker is
synthetic. Live anonymous controls and both Google handoffs pass; OAuth provider
network requests were stopped before Google. No personal authentication byapi4.

Live390/1280 screenshots were opened. New status200/enabled, unsigned link401,
invalid callback400, direct Pages broker403 and private-page302 pass. Public
/web-app/ and /map-demo/ bytes match their existing upstream; served immutable
app entry matches the exact local build. Initial legacy callback expectation
was wrong: the existing documented registration remains sky.v1d.io and forwards
once to skyvw.app. Only that failed check was repeated against the actual contract.

Production before operator:2existing users,0broker links,0consumed link/login
transactions, SELECT-only0writes. Old canonical16paths, mtimes, deletion, HEAD,
branch and index remain unchanged. Own browser/local proof processes are closed.

**Done24October19:05Z:** lsrc:0 completed existing Google login, Settings
Connect v1d, logout and v1d login in the real account. Same11jumps, highest136,
same name and2devices. Source api:4 delivery:901e49cbd94559dfeb7ce28476b72f68,
received19:03:15.109Z. His18:57–19:00Z window was approximate; authoritative
server link completion19:01:47.270Z and broker login19:02:45.748Z establish times.

Independent server-identity-proof.json:4 SELECT statements across production
D1 and broker Data Studio,29rows read,0written. Exactly1mapping each way to
the existing owner created10July, with its12July auth_link. Old app Google
subject equals the enabled broker identity's verified Google subject; raw
identifiers compared only in memory.2users before/after,2preexisting active
device credentials,1consumed browser/session-bound link and1consumed login,
2consumed Trackbook broker codes. The mapped local session was created at
19:02:45.895Z with the existing30day lifetime.

The consumed link plus published exact-session/atomic recheck proves the old
session was valid at linking. Production cookie bytes were not captured;
byte-identical continuity is local actual-worker evidence. The real account
has0passkeys, so no real passkey ceremony is claimed. Synthetic preservation
proof covers that case. closeout-live.json confirms identical deployed versions,
broker/app200 and opt-in enabled. No new release, provisioning or personal
browser interaction byapi4. No remaining92b work. Old login and Legacy stay.

Rollback: preceding Pages88d525e0-99bf-490a-93bb-ed62e6cab487;
broker baf1bcab-0354-4752-8583-bec9ca67b40c; edge890ba920-75f6-4a22-80ff-6f35b4c773ba.
Retain additive schema and credentials. Reconcile every operation receipt before
any retry. No release outcome remains UNKNOWN.

Release18:55:37Z:59min55s from original phase start,40min36s from first app
commit,1implementation/release writer. Original19:55:42Z deadline and20:55:42Z
150%stop persist. Evidence: receipt.json, broker-release.json,
migration-release.json, app-release.json, provider-release-after.json,
live-proof.json and cleanup-after-release.json in
/home/adelost/lsrc/.artifacts/shared-login-92b-api4-20261024/.

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

## Historical account-switch bank,24October18:40Z

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
