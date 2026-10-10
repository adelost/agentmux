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

amux warns once per account and week when an account panes run on passes
`AMUX_QUOTA_WARN_PERCENT` (default 80 % weekly used). It never switches by
itself, and neither do you.

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
- Codex panes switch per pane with Discord `/switch` (slots 1 and 2).

## 4. Logins

- One account per config dir: `~/.config/agent/account-profiles/claude/<login>`.
  Never copy credentials between dirs, never run `/logout` (it can revoke the
  refresh token), never log a dir in as a second account.
- New or expired login: `amux accounts login claude:<login>` prints
  `CLAUDE_CONFIG_DIR=<dir> claude auth login`. Run it with a pty, open the URL
  in the browser logged in as that account (Windows: Chrome = adelost@gmail.com,
  Firefox = mattias.wetterlind@gmail.com, through the windows-desktop skill).
  Mattias authorizes and pastes the code; you do not choose his Google account.
- Verify with `CLAUDE_CONFIG_DIR=<dir> claude auth status` and `amux quota`.

## 5. Renewal and money

Renewal dates and free resets live on claude.ai/settings/usage (Billing) and
chatgpt.com/settings/usage. Cancelling, buying credits or upgrading is
Mattias's decision; give him dates and numbers, not the click.
