# Subscription profiles

`amux quota` (Discord `/quota`) shows provider usage and reset windows for the
configured profiles. Tokens stay in provider-owned files, never in memory or
reports. Profile labels are routing names, not proof of distinct subscriptions.
Agents load the `amux-accounts` skill for reading quota, switching and logins.

## Which account is in use

Under each account `amux quota` prints the panes that run on it right now, for
example `i bruk: api:0–2, claw:0`, or `ingen panel`. It reads the config dir of
the live engine process under each tmux pane (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`KIMI_CODE_HOME`, else the default home), not the selection a pane gets at its
next start. A logged-out login no pane runs on is folded into one last line,
`Utloggade: Claude attrois · Kimi 1 · Kimi 2`. A pane on a dir no profile knows
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
`claude:mattias.wetterlind@gmail.com`. An email held by two slots picks the
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
delivery and an exact complete persisted session. Profile history links are
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

## Weekly warning

The bridge checks the Claude accounts that panes run on every 15 minutes,
through the same five-minute usage budget, and tells Mattias once per account
and weekly window when it passes `AMUX_QUOTA_WARN_PERCENT` (default 80 %
weekly used). The forecast uses the account's own readings from the last day,
or the average since the window began when they span less than an hour. The
notice leads with the cheapest action: "ingen åtgärd" when the pace lasts until
the reset, otherwise a free reset on claude.ai if he has one (amux cannot see
those), and only then the target's own usage and `/byt <target>` for the plan. Past the
threshold, a second, stronger notice comes once when the limit is less than
`AMUX_QUOTA_WARN_URGENT_HOURS` (default 12) away and before the reset; below it,
a fast hour is treated as a burst. Nothing switches automatically.
`AMUX_QUOTA_WARNING_ENABLED=false` turns it off.
