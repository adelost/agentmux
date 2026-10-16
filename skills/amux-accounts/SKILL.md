---
name: amux-accounts
description: Read subscription quota and switch or log in Claude/Codex accounts through AMUX. Use for kvot, usage, limit, rate limit, slut på kvot, veckokvot, which account a pane runs on, byta konto, rotate, /byt, free reset, prenumeration, förnyelse, logga in ett konto; not for model or effort changes (amux model).
---

# AMUX accounts and quota

Mattias pays per account, and a switch costs a full prompt-cache miss. Read
first, recommend the cheapest action, switch only on his word.

## 1. Read before any quota claim

- `amux quota` (Discord: `/quota`): every account's session and weekly use,
  and under each account the panes that run on it right now ("i bruk: …",
  read from the live process). "Utloggade:" lists logins no pane uses.
- An error text, a stopped pane or a guess is not a quota reading. Quote the
  numbers and their reset time.

## 2. Cheapest action first

1. Pace lasts until the weekly reset: do nothing.
2. A free full reset exists: Mattias presses it on claude.ai or chatgpt.com
   under Settings, Usage. No cache is lost. amux cannot see free resets.
3. Only then a switch, to the account with the most room before its reset.

When Mattias writes in a pane channel, amux answers there for each account
panes run on at `AMUX_QUOTA_WARN_PERCENT` (default 80 % weekly used) or more:
at most every 6 h below 90 %, every 3 h from 90 %. Warnings and forecasts
never switch.
Mattias authorized Codex automatic recovery on 2026-10-12: an actual usage
refusal plus reached weekly quota and verified spare capacity may switch that
one pane. Transfer its exact session, or save its task and replies before a
labeled fresh Sol/xhigh session. `AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false`
disables this recovery. Other rotations still require his instruction.

## 3. Switch only on Mattias's word

- Show the plan first: `amux accounts rotate claude:<login|email> --dry`,
  or have him write `/byt <login>` in Discord. Nothing changes.
- He confirms with `/byt <login> ok` within 10 minutes, or tells you to run
  the same command without `--dry`. A changed plan is shown again.
- What the verdicts cost:
  - `would-dormant` / `would-already-selected`: new account at the next start, free.
  - `would-running`: restart now, cold cache or small context, so the miss is small.
  - `would-compact-then-restart`: verified compact on the old account, then restart.
  - `blocked`: left alone (working, queued delivery, unknown context).
- Codex: `amux accounts switch codex:2 PROJECT -p N --dry`, then the same
  command without `--dry` after the operator's instruction. Omit `-p N` for
  the project, or use `--all` instead of PROJECT for the configured Codex fleet.
  Running panes compact on the source first, then keep model/effort and their
  exact portable session. Otherwise a saved, labeled fresh-session handover
  uses the same rollback/model checks. Busy panes keep a durable request for
  the existing journal watcher; dormant selections never wake an engine.
  `--continue-file PATH` is single-pane only and queues once after verification.
  Discord `/switch` remains available. Reached-weekly-limit recovery works in
  both directions; it never switches on a forecast.

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
