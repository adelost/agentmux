---
name: amux-accounts
description: Read subscription quota and switch or log in Claude/Codex accounts through AMUX. Use for kvot, usage, limit, rate limit, slut på kvot, veckokvot, which account a pane runs on, byta konto, rotate, /byt, free reset, prenumeration, förnyelse, logga in ett konto; not for model or effort changes (amux model).
---

# AMUX accounts and quota

Mattias pays per account, and a switch costs a full prompt-cache miss. Read
first, recommend the cheapest action, and switch on his word. When he
activates an account and says it should be used, that word covers every pane.

## 1. Read before any quota claim

- `amux quota` (Discord: `/quota`): every account's session and weekly use,
  and under each account the panes that run on it right now ("i bruk: …",
  read from the live process). "Utloggade:" lists logins no pane uses.
- An error text, a stopped pane or a guess is not a quota reading. Quote the
  numbers and their reset time.
- Before any claim about what costs tokens or quota, read
  `~/.openclaw/workspace/memory/references/claude-subagent-cache-2026-10-10.md`
  and run `~/bin/claude-cache-report <hours>`. Quote its numbers.
- Price weights on Opus 5.5 and Sonnet 5.5: cache read 0.05x, main-pane cache
  write 2x (1 h cache). How the subscription quota weighs reads is not
  documented, so API-price shares are not quota shares.
- The compaction thresholds change only with new measurements against that study.

## 2. Cheapest action first

1. Pace lasts until the weekly reset: do nothing.
2. A free full reset exists: Mattias presses it on claude.ai or chatgpt.com
   under Settings, Usage. No cache is lost. amux cannot see free resets.
3. Only then a switch, to the account with the most room before its reset.

When Mattias writes in a pane channel, amux answers there for each account
panes run on at `AMUX_QUOTA_WARN_PERCENT` (default 80 % weekly used) or more:
at most every 6 h below 90 %, every 3 h from 90 %. Warnings and forecasts alone
never switch; the verified wind-down compact below is the exception.
Mattias authorized Codex automatic recovery on 2026-10-12: an actual usage
refusal plus reached weekly quota and verified spare capacity may switch that
one pane. Transfer its exact session, or save its task and replies before a
labeled fresh Sol/xhigh session. `AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false`
disables this recovery.
Mattias authorized Claude automatic recovery on 2026-10-19: an actual limit
banner plus a reading after it that shows the pane's own week spent moves that
one pane to the logged-in Claude account with the most weekly room below
`AMUX_QUOTA_RESERVE_PERCENT`, in its exact session; its parked messages follow.
A session window moves a pane only after a verified wind-down compact. `AMUX_CLAUDE_LIMIT_RECOVERY_ENABLED=false`
disables banner recovery. Other rotations still require his instruction.
Mattias 2026-10-21 (day file 03:49Z): when the quota park or floor holds
panes because their account's week is spent and another logged-in account
has room, move them there at once without asking, then report it. Paid
credits still need his yes.
Mattias authorized quota wind-down on 2026-10-20: the nearer week or session
window warns at 5 % left and nudges once at 3 %. A move requires a VERIFIED
compact of this session in this episode, an idle pane, an empty composer, no
live delivery and another account with room in both windows read after the
compact. The exact session continues there. `AMUX_QUOTA_WIND_DOWN=off|dry|on`
(default dry: it only logs `would-*` lines to `~/.agentmux/pause-compact.jsonl`)
controls wind-down; `AMUX_QUOTA_WIND_DOWN_MOVE=false` disables its moves while
keeping notices and worthwhile compacts.
At `AMUX_QUOTA_FLOOR_PERCENT` left on the week (default 3 %, 0 is off) amux
starts no new automatic delivery to panes on that account and the quota park
compacts them at their turn end; the owner's own message still goes through.
A reading with room (a reset or a free reset) lifts it and resumes parked panes.
A Codex account past a spent 5h or week window would draw paid credits: the
same hold applies, idle compacts included, until its reset, unless
`AMUX_CODEX_CREDITS=allow` (lsrc:0 2026-10-20). `amux quota` shows the balance.
With `AMUX_IDLE_CAPACITY_TARGET=agent:pane` the bridge tells that pane once per
episode when a pane has been stopped or parked for 15 minutes while an account
of its engine has room. It never wakes or moves anything itself.

## 3. Switch only on Mattias's word

- When Mattias activates an account and says it should be used, that is his
  word for all panes: move the quota-stopped panes in the same turn with
  `amux accounts rotate claude:<login>`, and do not ask him again
  (2026-10-18: six panes waited 5.8 h on a spent account for that question).
- Make an account decision about a pane on the `amux quota` "i bruk" line,
  never on a note or an earlier reading.
- Show the plan first: `amux accounts rotate claude:<login|email> --dry`,
  or have him write `/byt <login>` in Discord. Nothing changes.
- He confirms with `/byt <login> ok` within 10 minutes, or tells you to run
  the same command without `--dry`. A changed plan is shown again.
- What the verdicts cost:
  - `would-dormant` / `would-already-selected`: new account at the next start, free.
  - `would-running`: restart now, cold cache or small context, so the miss is small.
  - `would-compact-then-restart`: verified compact on the old account, then restart.
  - `would-select-for-quota-recovery`: a pane stopped at its limit gets the new
    account; quota recovery restarts its exact session there within a poll.
  - `blocked`: left alone (working, live delivery, unknown context). Messages
    parked by the pane's own limit do not block it.
- Codex: `amux accounts switch codex:2 PROJECT -p N --dry`, then the same
  command without `--dry` after the operator's instruction. Omit `-p N` for
  the project, or use `--all` instead of PROJECT for the configured Codex fleet.
  Running panes compact on the source first, then keep model/effort and their
  exact portable session. Otherwise a saved, labeled fresh-session handover
  uses the same rollback/model checks. Busy panes keep a durable request for
  the existing journal watcher; dormant selections never wake an engine.
  `--continue-file PATH` is single-pane only and queues once after verification.
  Discord `/switch` remains available. Reached-weekly-limit recovery works in
  both directions; a forecast moves a pane only after the verified wind-down compact.

## 4. Logins

- One account per config dir: `~/.config/agent/account-profiles/claude/<login>`.
  Never copy credentials between dirs, never run `/logout` (it can revoke the
  refresh token), never log a dir in as a second account.
- New or expired login: `amux accounts login claude:<login>` prints
  `CLAUDE_CONFIG_DIR=<dir> claude auth login`. Run it with a pty, open the URL
  in the browser logged in as that account, through the windows-desktop skill.
  `amux quota` shows each login's email, read from its local profile; which
  Windows browser holds which account is in the private workspace note
  `memory/references/amux-accounts.md`, not in this public skill.
  Mattias authorizes and pastes the code; you do not choose his Google account.
- Verify with `CLAUDE_CONFIG_DIR=<dir> claude auth status` and `amux quota`.

## 5. Renewal and money

Renewal dates and free resets live on claude.ai/settings/usage (Billing) and
chatgpt.com/settings/usage. Cancelling, buying credits or upgrading is
Mattias's decision; give him dates and numbers, not the click.
