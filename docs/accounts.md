# Subscription profiles

`amux quota` (Discord `/quota`) shows provider usage and reset windows for the
configured profiles. Tokens stay in provider-owned files, never in memory or
reports. Profile labels are routing names, not proof of distinct subscriptions.
Agents load the `amux-accounts` skill for reading quota, switching and logins.

Codex recovery rechecks unresolved provider errors even when the rollout has
not changed: its SQLite error can arrive after the journal's final write.
Before new delivery, a cached exhausted weekly window is confirmed through a
fresh provider read. An idle pane then resumes its exact session on an
authenticated account with verified room, under the delivery lease. No extra
prompt is added and post-submit fences are never bypassed. Explicit account
switches likewise skip a source compact only at a confirmed reached weekly
limit (`would-resume-after-weekly-limit`); other switches still compact first.
`AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false` disables automatic switching.

## Reached Claude limit

An actual Claude limit banner, plus a usage reading taken after it that shows
the pane's own week spent, moves that one pane to the logged-in Claude account
with the most weekly room below `AMUX_QUOTA_RESERVE_PERCENT` (default 90 %).
Another dir of the same login is the same spent week and does not count. The
quota sidecar selects the account under the pane's delivery lease and resumes
the exact session there; its parked messages follow the continuation in FIFO
order. A failed restart retries on the new account at the next poll. A session
window never moves a pane, and forecasts never do.
`AMUX_CLAUDE_LIMIT_RECOVERY_ENABLED=false` disables it.

The quota park compacts a pane at its turn end before its account stops it for
longer than the pane's prompt cache lives. It parks at 3 % left, or earlier when a
window's pace since it opened says it runs out within 20 minutes: a reading can be
ten minutes old, and twenty panes spend Claude's last 3 % of five hours in minutes.
A running subagent or background job does not hold that compact, and an idle
pane's cache counts from its last activity. A compact a usage limit refused spent
nothing; it runs again after the reset Claude names, while the cache is still warm.

A Claude pane the quota park compacted and told to stop has no limit receipt.
The park is recorded in `~/.agentmux/quota-parks/`, and the quota sidecar sends
that pane the same same-session recovery prompt as soon as a reading taken after
the park shows more room than the park saw (a free reset, any early room) or the
window's reset time passes. When that room comes, a pane that is working on a later request
or has a message in its queue is left alone; a message it already finished does not
count. A park notice still in the queue is cancelled either way.

A message sent to a pane stopped at its Claude limit is queued as before, and
the CLI adds a warning on stderr: the recipient cannot read it until it
recovers, so the sender keeps any role it hands over until the recipient
acknowledges.

## Quota floor

At `AMUX_QUOTA_FLOOR_PERCENT` left on an account's week (default 3 %, `0` turns
it off) amux starts no new automatic delivery to panes on that account: their
messages wait in the queue, and the owner's own message still goes through. A
working pane finishes its turn and the quota park compacts it there; nothing is
cut off mid-turn. The floor lifts by itself on the first reading with more than
the floor left, after the reset or a free reset, and parked panes then get the
same-session recovery prompt. A pane that quota recovery moved to an account
with room is judged by the account it runs on now. Messages the floor holds do not stop `accounts rotate`
from compacting and moving a large pane; they follow it and are delivered on the new account.

A Codex account past a spent 5h or week window keeps working on its paid
credit balance, and Codex refuses nothing while credits last. amux holds new
automatic deliveries and idle compacts on it until that window resets, whatever
the floor setting, unless `AMUX_CODEX_CREDITS=allow` is set for the bridge
(lsrc:0, 2026-10-20: about 1 200 credits an hour at 375.96 SEK per 1 000). The
owner's own message still goes through. `amux quota` shows the balance beside
the windows.

The floor holds only new deliveries, so a turn already running when its window
runs out would go on drawing credits (claw:5, 27 Oct 2026: 61 model calls and
88.723 credits from 07:56:59Z to 09:01:45Z). The credit guard
(`channels/codex-credit-stop.mjs`, every 10 s) reads each working Codex pane's
own journal, where every model call records the windows and the credit balance.
A spent 5h or week window with credits flowing and no tool call open earns one
Esc (again after 15 s, three times at most; an approval prompt is left alone).
The work is stored first. With another Codex account that has room (read fresh:
5h window at least 20 % left, week under 90 % used) the pane gets an explicit
account switch that carries the continuation and moves the exact session at its
next idle boundary, without a paid compact. With none, one `codex-credit-stop`
job waits and the floor holds it for the reset. An idle pane with a message the
credit hold keeps back is moved the same way. The spent window is also stored for
the floor, so new work waits before the 15-minute snapshot shows it. A usage
refusal at a spent 5h window moves the pane like a spent week. At most one model
call, the one in flight at the boundary, can still draw credits.

Mattias's own turn is never stopped (lsrc:0, 2026-10-27). His message passes the
floor, and a turn that any of his plain messages began or steered runs on; so does
a turn nobody can place (its start lies beyond an 8 MiB look back). The ask ledger
decides whose a prompt is, since the account switch types its continuation as
plain text. Every case, stopped or left running, goes to
`~/.agentmux/codex-credit-stop.jsonl` with the credits at the first spent call,
at Esc and once the turn is over, and `amux quota` ends with the week's sum. A sum
over 5 credits in a week builds the hold for his message in delivery-wake; it must
read the quota without blocking his input (`core/delivery-storage-recovery`).
`AMUX_CODEX_CREDIT_STOP=off|dry|on` sets the guard (dry logs what it would do),
`AMUX_CODEX_CREDITS=allow` turns it off.

## Idle capacity

With `AMUX_IDLE_CAPACITY_TARGET=agent:pane` in the bridge environment, the
bridge checks every configured Claude and Codex pane every five minutes. A pane
with a persisted limit receipt, messages parked by a usage limit, an open quota
park, or a stopped process with queued messages for 15 minutes, while an account
of its engine has room below the reserve, earns one notice to that pane per
episode. The notice names the pane, the reason, the account and the command that
moves it. When the room is on the account the pane already runs on, it names the
resume amux sent, or why it did not, instead of a rotate. It never
wakes, moves or restarts a pane. `AMUX_IDLE_CAPACITY_ALERT_ENABLED=false` turns
it off.

## Foreign drafts

Every minute the bridge reads each Claude pane's composer. A draft no waiting
message owns, with messages waiting behind it for 10 minutes, earns one notice
per draft to `AMUX_FOREIGN_DRAFT_TARGET`, else `AMUX_IDLE_CAPACITY_TARGET`. The
notice names the pane, how long, how many wait, the draft's first lines and,
for a collapsed paste, the first lines of the one matching copy in Claude's
paste cache (written only for pastes over 1024 characters). amux never types
into, clears or restarts the pane: the draft may be Mattias's.
`AMUX_FOREIGN_DRAFT_ALERT_ENABLED=false` turns it off.

## Which account is in use

Under each account `amux quota` prints the panes that run on it right now, for
example `in use: api:0–2, claw:0`, or `no pane`. It reads the config dir of
the live engine process under each tmux pane (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`KIMI_CODE_HOME`, else the default home), not the selection a pane gets at its
next start. A logged-out login no pane runs on is folded into one last line,
`Logged out: Kimi 1 · Kimi 2`. A pane on a dir no profile knows
is named with that dir.

## Logins

One account per dir. `amux accounts login claude:<1|2|login|email>` prints the
command for that dir, `CLAUDE_CONFIG_DIR=<dir> claude auth login`; a new login
name gets its own dir, `~/.config/agent/account-profiles/claude/<login>`. Open
the printed URL in the browser that is logged in as that account, approve, and
paste the code back. `amux quota` then shows the account. Never copy credentials
between dirs and never run `/logout`, which can revoke the refresh token.
Codex and Kimi slots keep `amux accounts login codex:<1|2>` / `kimi:<1|2>`.

## Every Claude login

`amux quota` shows each Claude account once, by the email Claude Code stored at
login, with the launch slots that use it. A login dir under
`~/.config/agent/account-profiles/claude/` that is in no slot is shown too,
marked "ingen plats" until a pane is switched to it. A dead login shows its
reason instead of failing the view. A login dir named like a slot ("2") is
never a launch target, so it cannot shadow that slot.

The CLI, Discord `/quota` and quota recovery share one usage call per account
per five minutes (`~/.agentmux/quota-budget/claude/`). A pane parked on its
limit never resumes on a reading taken before the limit. amux refreshes a
Claude token only while it holds Claude Code's own refresh locks
(`<config>/.oauth_refresh.lock` and `<config>.lock`). While a pane holds them,
the read reports `refresh_busy` and writes nothing.

## Claude rotation

From Discord, `/byt <login|email>` replies with the `--dry` plan below and
changes nothing. `/byt <login> ok` from the operator (the Discord user in
`~/.openclaw/credentials/discord-allowFrom.json` or `AMUX_NOTIFY_USER_ID`), within
10 minutes and while every pane's verdict is unchanged, runs the switch and
replies with the outcome per pane. A late or changed confirm shows the plan
again instead.

The target is a slot id, a login dir name or the account email `amux quota`
shows: `amux accounts rotate claude:wetterlind`, `claude:2` or
`claude:wetterlind@example.test`. An email held by two slots picks the
first; both are the same account.

`--dry` reads target access and prints each pane's plan without preparing
profile links, refreshing OAuth, compacting, starting processes or changing
selected profiles. It briefly uses the delivery lease so the view is
consistent with the delivery controller.

A switch is a full prompt-cache miss for every moved pane (Mattias
2026-10-10: "det kostar pengar att byta subscription.. blir en cache miss").
Each pane gets the cheapest safe action from `policies/account-switch-cost.mjs`,
on the limits `policies/context-cost.mjs` documents (80k tokens, one hour):

| Pane | Action | Output |
|---|---|---|
| already on the target account, in any of its dirs | stays where it is | `would-already-selected (same-account)` |
| asleep or offline | selection only, for its next ordinary wake | `would-dormant` / `selected-for-next-wake` |
| stopped at its limit, with only the messages that limit parked | selection only; quota recovery restarts its exact session on the target | `would-select-for-quota-recovery` / `selected-for-quota-recovery` |
| idle for an hour or more | restart on the target, no compact (its cache is cold anyway) | `would-running (cache-cold …)` |
| warm and at most 80k | restart on the target, no compact | `would-running (context-small …)` |
| warm and above 80k | verified `/compact` on the source, then restart | `would-compact-then-restart` |
| warm and above 80k, source stopped at its limit | restart without compact; the source cannot answer | `would-running (source-limited:…)` |
| compact not admissible or context unknown | stays on its source | `blocked (compact-refused:…)` / `blocked (context-unknown)` |

The compact is the verified nightly pass on its own pane lease, outside the
project's rotation lease, with receipts under
`~/.agentmux/account-switch-compact/`. A failed or unverified compact blocks
that pane only; it is never retried automatically. A context that grew again
between its compact and the restart is blocked rather than compacted twice.

The real switch then requires idle/empty-composer observations, no pending
delivery and an exact complete persisted session. Prompts the quota floor holds
unsent, the held one and every untried one queued behind it, are not pending
delivery: they move with the pane and are delivered on the target under their
own job ids. A drafted or submitted message still holds the pane. Profile history links are
prepared only after preflight. Immediately before each restart it rechecks the
pane and journal fingerprint, with another check at the actual restart
boundary. The CLI resumes the existing transcript under the new profile.

Provider-disabled, inaccessible or unknown target access blocks before pane
changes. Startup/composer readiness is not proof that a subsequent model turn
will have quota. No model, effort or API-billing fallback is selected here.
An unfinished transition retains its exact session for retry; failed startup
attempts rollback to the previous profile, and partial outcomes stay explicit.

The fleet command currently targets tmux Claude. Native runtime and Codex
account switching have their own adapters; this command does not provision
native sessions or rewrite their configured identity. Repeated profile names
or equal usage numbers do not prove two different accounts.

## Quota warnings

When the human writes in a pane's Discord channel, the bridge checks Claude and
Codex weekly quota after his message is handled and answers in that channel.
The check never delays his delivery, never posts before the catch-up notice and
never wakes a pane.

An account warns when a running pane uses it and its weekly use is at least
`AMUX_QUOTA_WARN_PERCENT` (default 80 %). Between two warnings for one account
it waits 6 hours below `AMUX_QUOTA_RESERVE_PERCENT` (default 90 %) and 3 hours
from there, as Mattias set on 2026-10-16. A durable sent-store keeps the wait
across bridge restarts, and checks run one at a time, so two quick messages
warn once. Several due accounts arrive in one message.

Each account line gives usage and reset, and the least-used account of the
same provider below the warning level. Claude uses `/byt <email>` for a plan
and `/byt <email> ok` to confirm. Codex uses `//switch <1|2>` in the channel of the pane it names.
Without such an account, one line says that none has room.

The check reads the same snapshot as `amux quota`, through Claude's five-minute
and Codex's fifteen-minute shared budget, so it adds at most one usage read per
account and budget window, and only when he writes. A cache-only read would be
cold whenever nobody ran `amux quota` in the last minutes. A failed read posts
nothing. amux never switches by itself on a warning.
`AMUX_QUOTA_WARNING_ENABLED=false` turns it off.

## Manual billing facts

`account-profiles.json` keeps billing-page observations beside their login.
`freeResetsReadAt`, `renewsReadAt` and `planReadAt` are ISO times with an offset;
`freeResetsReadOn` remains supported for legacy day-only observations. `planTier`
can distinguish Max (20x) from a login's generic max label. Optional
`creditsBalance`/`creditsReadAt` and `autoReload`/`autoReloadReadAt` record manual
page observations separately from the live credit balance. `source` names the
evidence. Missing or future reading times have unknown age and are STALE.
Both quota surfaces show the reading time and age; more than 24 hours is STALE.
A past renewal day is INVALID, never advanced by guessing the next billing date.
A fresh usage response does not refresh manual facts. Reset recommendations
require a positive reset count with fresh evidence.

## A delivery held at the quota floor

The existing 30-second bridge identity heartbeat also observes quota-floor
holds. No additional polling timer is started. After strictly more than 30
minutes from the earliest proven refusal, one notice per account episode goes
to the human through notifyuser and to dispatcher lsrc:3 through the normal
queue. Waiting jobs/panes, dated resets and verified Codex capacity in both
windows are named; missing readings stay unknown. The original jobs never move
or replay. Existing automatic account policies are independent of this observer.

Episodes and independent recipient receipts use the existing atomic state
store (the bridge's configured STATE_FILE). Send intent is durable before I/O.
A lost response or interrupted send remains unknown and is not retried blindly;
a proven failure before sending may retry. The ordinary dispatcher queue ACK
is followed even after the original episode recovers. Fresh provider evidence,
not reset-time jitter, establishes recovery before a new episode can alert.

Compaction waiting for a quota-held delivery is evidence within that same
episode. The existing compact-held metadata and canonical posted notices own
its source/time. Cache age remains unknown without activity evidence; no
compaction or move rule changes. Detailed evidence remains in state when a
notice summarises several compact holds. Stats has a separate builder/release.
