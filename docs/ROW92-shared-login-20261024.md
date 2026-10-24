# Shared login inventory and first application

Owner api:4. Received 24 October 2026 at15:46Z. Original budget2h,
checkpoint16:06Z, budget deadline17:46Z. Wall time is not measured active time.
Source: lsrc:0's24October15:16:57Z direction, conversation
delivery:abd82f44005cd83e07e5b09369a5cd87, and lsrc:3's allocated AMUX92.
The broker and the Legacy app client are distinct. Jumpbook remains retired.

## Current delivery,24October17:00Z

Suggest's opt-in broker integration is published. App source00997c8 runs as
Worker e45b2fa8-71a6-4887-89fd-e08fcd7c2612 at100%. Broker source4944323
runs as aff8e4f1-2ce5-4668-87d9-cd13f98c4a4b at100%. Both health checks pass.
The new independent app credential was generated in memory and piped through
Wrangler secret put only to CLIENT_SECRET_SUGGEST and V1D_AUTH_CLIENT_SECRET;
provision-receipt.json confirms both steps. No value was printed and no copy was written to disk.

Verified:33 focused auth tests,134 broker tests,25 normal-release tests,
isolated and production canaries, strict changed lint0, builds, local actual
workerd linking/logout/broker login, and inspected390/1280 views. The local
account was synthetic; the broker transport checked PKCE and one-use codes.
A small local proxy translated captured redirects into browser navigations.
Live anonymous checks reached the real Google entry through the shared broker,
kept the old Google path, refused anonymous linking and invalid callbacks, and
matched the served JavaScript to the local release bytes. No paid provider probe.

**Done:** lsrc:0 completed the real existing-account Google login, explicit
Profile > Connect v1d, logout and broker login in Mattias's Chrome. Same owner,
project and counts203/14/17/154 were observed. Source: api:4 inbound
delivery:669f590002c0af7eea485294d9a5fde7 at16:51:20Z. His approximate clock
estimate was later than delivery; server timestamps below establish the times.

At16:59Z api:4 independently read both live authority databases using only
SELECT through Cloudflare Data Studio. The single broker mapping points to the
existing Suggest singleton owner and identity, both created14July07:29:32Z.
Its local subject equals the Google method subject of that exact enabled broker
identity; identifiers were compared only in memory. One mapping exists on each
side. Link completion is16:49:31.888Z; subsequent broker login is16:50:42.563Z.
Both durable transactions are consumed. The link transaction has the original
subject, session hash and browser hash. Published complete() requires the same
valid old session at callback, and the linked callback does not replace its
cookie. Production before/after cookie bytes were not captured; exact byte
continuity was separately proved in the local actual-workerd test.

server-identity-proof.json records these predicates without raw identifiers,
cookies or session hashes. Provider metadata confirms zero SQL rows written.
closeout-live.json confirms the unchanged published source and both health200.
No new release, credential write or personal-browser interaction by api:4 was
needed.92/92a are complete within the original deadlines17:30Z/17:46Z.
The old Google route remains available. Trackbook still waits for its other WIP
and uses Legacy; its later migration and final provider cleanup are outside92a.

Authoritative aggregate: /home/adelost/lsrc/.artifacts/shared-login-92-api4-20261024/receipt.json.
Normal app rollback is084b7a2a-c812-4877-957f-9ae7baa7a4bc; broker rollback is
dd0cd568-f2a0-41da-bca4-f4d157a564b4. Additive mappings are retained; no rollback,
secret write or deploy is repeated without its receipt.

## Scope

Map current code, live entry routes and configured secret names for sky,
skyvw,skybar,suggest. Preserve existing identity, memberships, sessions and
data. Reuse auth.v1d.io; Drive211 remains owned by lsrc:2 and has separate
consent. Only the scoped Suggest app credential was later authorized; no new
personal accounts, provider clients, real-data deletions or paid probes are authorized.

## Inventory at the15:54Z checkpoint

Anonymous live starts inspected24October15:50–15:54Z. No provider login,
consent, new account, real data change or session exchange was completed.
Provider client identifiers were compared only in memory; retained evidence
contains client labels and short one-way fingerprints, never their values.

| App/surface | Current login and owner | Observed use | Own row/timebox | First boundary |
|---|---|---|---|---|
| sky.v1d.io | Trackbook Better Auth Google, **Legacy app logins**; old browser bookmarks redirect to skyvw.app | trackbook-jump-proxy4836 requests over7days, including machine/scheduled traffic | Covered by92 inventory; future Trackbook migration must have its own named row | Preserve Better Auth user/account IDs, auth_links, passkeys, owner data and device tokens; coordinate existing WIP first |
| Skyvw / skyvw.app | Same Trackbook account service through trackbook-jump-proxy; skyvw-web owns the public frontend, not a second identity store | Same4836 proxy requests, not additional users or a second independent count | Same Trackbook migration boundary; canonical-only skydive-altimeter is read-only here | Public Google start returns the old sky.v1d.io/api/auth/callback/google callback; native pairing and release paths remain unchanged |
| skybar.v1d.io | **Already brokered**:302 to auth.v1d.io/authorize, app_id skybar, exact own callback | Public start verified; Pages human-use count not measured by this worker aggregate |92 inventory only; no duplicate migration row or release | Existing app-local sid and authorization remain owned by Skybar |
| suggest.v1d.io | Direct Google OIDC; provider client is **v1d Login**, the same client as the broker, not Legacy app logins | suggestions-v1d3324 requests over7days, including machine/scheduled traffic |92a api:4, 90min16:00–17:30Z; opt-in integration published, real-account proof pending | First candidate: custom auth is smaller than Trackbook's Better Auth/passkey/device seam and checkout has no WIP; needs explicit identity link and its own broker app registration/credential |

Period:17October15:50:44Z through24October15:50:44Z. Requests are sampled
Cloudflare aggregates, not unique people or proven human logins. The broker
itself had4165 requests. This establishes current service activity, not a
ranking of human adoption. Query shape follows [Cloudflare's Workers metrics
documentation](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).

**Do not remove Legacy app logins:** Trackbook still generates a login URL
using that client today. Suggest's direct login has a different issue: it
duplicates the provider integration using the broker's Google client. Both
must ultimately move, but they are not uses of the same old client.

## Secret names and deployment owners

Initial15:54Z inventory below. Only names were read from Wrangler and Cloudflare deployment metadata. The approved continuation added only CLIENT_SECRET_SUGGEST at the broker and V1D_AUTH_CLIENT_SECRET at Suggest.

| Deployment | Relevant configured secret names | Broker readiness |
|---|---|---|
| Pages trackbook | AUTH_PASS,AUTH_SECRET,AUTH_USER,BETTER_AUTH_SECRET,GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET | No named broker app credential; existing account store shared by sky/Skyvw |
| Worker trackbook-jump-proxy | SKYVW_RELEASES_TOKEN | Edge/release forwarding only; it does not own Google credentials |
| Pages skyvw-web | None | Public frontend; do not add a second account store |
| Pages skybar-original-test | ADMIN_EMAILS,CAFE_SESSION_SECRET,GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,MANIFEST_PASSWORD,RENTALS_LINK_KEY,SBF_API_KEY,V1D_AUTH_CLIENT_SECRET | Existing broker app and credential; legacy Google secret names remain provisioned, no deletion performed |
| Worker suggestions-v1d | ADMIN_TOKEN,AGENT_READ_TOKEN,GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,IDENTITY_PEPPER,OWNER_BOOTSTRAP_EMAIL,RATE_SALT,SESSION_SECRET_CURRENT,SESSION_SECRET_PREVIOUS | No named broker app credential or Suggest app registry entry |
| Worker v1d-auth | APP_CLIENT_SECRETS,CLIENT_SECRET_AGENTMUX_LINK,CLIENT_SECRET_CUT,CLIENT_SECRET_DEVCUT,CLIENT_SECRET_HAUNT,CLIENT_SECRET_PL4N,CLIENT_SECRET_SKYBAR,CLIENT_SECRET_STATS,CLIENT_SECRET_STOCKS,GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,IDENTITY_PEPPER,OWNER_BOOTSTRAP_EMAIL | Health200; app registry covers existing consumers, not Suggest or Trackbook |

Names present do not prove which legacy fallback paths still consume them.
The old APP_CLIENT_SECRETS aggregate was not decrypted or inspected. No
undocumented provisioned Suggest/Trackbook credential is assumed.

Source seams: Trackbook src/lib/server/auth/better-auth.ts,
src/lib/server/auth/auth-links.ts and deploy/jump-proxy/wrangler.toml;
Skybar src/lib/server/v1d-auth.ts and deploy/original-test/wrangler.toml;
Suggest worker/auth.ts,worker/authority-identity.ts,worker/authority-schema.ts;
broker client/worker.ts,src/identity-methods.ts and docs/deployment.md.
Exact inspected Git heads and production Pages deployment IDs are in the
sanitized receipts below; source HEAD is not claimed to equal deployment HEAD.

## First-app boundary

Suggest is the proposed first new broker consumer. Its current singleton
owner, project memberships, creators, agent grants and user fleet keys all
refer to the existing Google subject. Replacing that value with principal.id
would create another person and strand those relationships.

The smallest safe migration keeps those local keys and adds a unique mapping
from broker identity to existing subject. An explicit link requires both an
existing valid app session and a fresh broker proof tied to the same short-lived
transaction. Consume that transaction and insert the unique mapping atomically;
refuse conflicts. Do not infer or merge by email. Existing signed cookies and
signing keys remain accepted; roles are still read from current app authority.
Unmapped broker logins cannot create a replacement owner or silently claim data.
The existing direct Google route remains during the controlled transition.

Use the existing auth-client for PKCE and exchange; do not copy provider files.
Required proof includes wrong state/origin/callback, expiry and replay, conflicting
links, email changes without identity change, old cookie continuity, owner/editor
separation, creator/data ownership and logout. Before release, run the app's
normal local canary/build/lint and record exact source, rollback and live result.
That canary and a real linked login have **not** run in this read-only phase.

The missing prerequisite at the initial checkpoint was concrete: Suggest has no broker registry entry and
no documented matching app credential. The existing deployment contract requires
an independent per-app credential before registration; registering first breaks
global broker health. AMUX92 explicitly forbids new secrets. A different app's
secret, a Google secret or a personal Drive token cannot fill that gap.
Consequently92a was blocked before code/activation until the narrow authority
decision recorded below. Speculative app code is not a completed migration.

Trackbook's checkout is dirty on fix/live-session-consent with another feature's
work. No files were changed, stashed, moved or copied. The skydive-altimeter
canonical checkout is clean but lists noncanonical historical worktrees; their
ownership was not established because this task makes no native edits or release.
No cleanup was attempted. Any later native change must resolve that before writes.

## Evidence and limits

Sanitized artifacts under
/home/adelost/lsrc/.artifacts/shared-login-92-api4-20261024/:

- live-inventory.json: public routes,7-day request aggregates, Pages deployment
  IDs/source metadata, configured secret names.
- login-boundaries.json: exact callback destinations, provider-client label
  comparison, broker/Suggest secret names and inspected Git heads.
- broker-settings.json: initial15:54Z production registry and secret names only.
- server-link-read.json and server-identity-proof.json: independent24October
  server predicates from app and broker, one unique existing-owner mapping,
  matching verified Google subject, consumed link/login and zero SQL writes.
- operator-real-account-proof.json: source-bound real-account UI proof bylsrc:0;
  no email, credentials or raw identity values copied into the receipt.
- closeout-live.json: exact unchanged app build and health readback at completion.
- inspect-live.py and check-login-boundaries.py: repeatable read-only probes;
  no cookie, auth code, token or raw provider client ID is retained.

At the initial checkpoint no deployment, secret change, account mutation, console
cleanup or paid API execution had occurred. That prerequisite blocker is historical;
the current completed result and real-account/server proof are stated above.
Original92 timebox is retained rather than restarted.

## Authorized continuation,24October15:59Z

Lsrc:0 authorizes one independent Suggest app credential, generated in memory
and piped only into Wrangler secrets for broker and Suggest, then its own
registry entry. This narrowly supersedes the credential blocker above.
No secret value or disk copy. Keep current Google login until explicit linking
passes on a test account; preserve every existing session. Trackbook waits for
its other WIP.92a starts16:00Z,90min until17:30Z within92's original17:46Z cap;
checkpoint16:20Z. Files: new broker route/authority feature, additive schema,
existing router/session helper, shared auth-client dependency, relevant tests.
UI adoption is separate from replacing the existing Google route.
