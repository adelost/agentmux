# Conversation log

One compact, durable record of everything that passes through amux, the same
for every engine: what was asked of a pane (`ask`) and what amux posted to
Discord (`post`). It lives in the existing ask ledger,
`~/.agentmux/ask-ledger.jsonl` (override: `AMUX_ASK_LEDGER_PATH`), mode 0600,
rotated beside itself at 32 MiB. Archives are kept: they are the record of
what was said. The log stays on this machine: it is raw conversation, so the
nightly backup of distilled memory skips it (0600 files are not copied).

Three stores, one role each:

| Store | Role | Retention |
|---|---|---|
| delivery queue (`~/.agentmux/delivery-queue/`) | transport state: pending, submitted, receipt, at-most-once fences | acknowledged jobs pruned after 7 days |
| conversation log | what was said, in and out | never pruned, rotated at 32 MiB |
| event log (`~/.agentmux/events.jsonl`) | loss-tolerant hints: prompt/stop, permissions, session start | rotated at 8 MiB |

A row points at a delivery by `deliveryId`; it never copies transport state.
A posted answer is not an engine ingestion receipt or proof of task completion.

## Rows

Every row is one JSON line with `version: 1`, `event`, `ts` (ISO time) and `id`.

`event: "ask"`, inbound, unchanged:

| Field | Meaning |
|---|---|
| `agent`, `pane` | the pane that received the prompt |
| `source` | `discord`, `cli`, `pane-hook`, `dream`, ... |
| `verbatim` | the exact prompt text |
| `sender`, `origin` | who sent it, human or agent |
| `sessionFile`, `sessionId`, `deliveryId`, ... | where it went |
| `completionStatus`, `completionAt` | terminal evidence once known |
| `completionReply` | legacy 100-character preview; read, to be retired |

`event: "post"`, outbound, one row per send attempt, edit or verified observation:

| Field | Meaning |
|---|---|
| `agent`, `pane` | the pane that owns the channel, `null` for a DM or an unbound channel |
| `channelId`, `messageId` | the Discord ids |
| `via` | `bridge` or `cli`, the send point that posted it |
| `kind` | `reply` (an agent's turn), `mirror` (a prompt or brief shown in the channel, a voice transcript), `file` (an image or file), `voice` (`amux say`), `notice` (status, receipts, warnings) |
| `text` | Discord's accepted text after success, or the attempted text after failure |
| `status`, `error` | `sent`, or `failed` with the error code and message |
| `deliveryId` | the delivery the post belongs to, when known |
| `files` | posted file paths, never their contents |
| `truncated`, `textBytes` | set only when `text` passed 64 KB; a Discord message is at most 2000 characters, so this marks a pathological payload |
| `askId` | the ask it answers, when known (not yet written) |
| `recoveredAt` | time an existing Discord post was independently observed; `ts` remains its actual creation or edit time |

## Writers

- **pane hook, delivery queue, Discord inbound**: `ask` rows, before delivery.
- **Bridge Discord adapter** (`channels/discord.mjs`, `channels/normalize.mjs`):
  every `send`, `replyTo`, successful edit and reply to a person's message calls `onSent`, and
  the bridge records it through `recordDiscordPost` (`channels/post-ledger.mjs`).
  The pane watchers tag agent turns `reply` and their image groups `file`.
- **CLI REST posts** (`cli/send-notify.mjs`): `discordPost` and
  `discordPostFile` record through the same `recordDiscordPost`. Mirrored sends
  are `mirror`, `amux image` is `file`, `amux say` is `voice`, the rest `notice`.

A post is recorded after the send attempt: `sent` with the Discord ids and
accepted content, or
`failed` with the error, and the caller still sees the failure. A failed
record is printed as a warning and never turns into a second post.

Only `core/ask-ledger.mjs` reads or writes the file: `appendAskLedger`,
`appendPost` and `readWindow({ since, until, agents })`. A test fails if any
other module names the file. `readWindow` opens only the files whose first and
last rows overlap the window, read from a 64 KB probe at each end, and returns
rows ordered by (`ts`, `id`). Rows are appended in about time order, so a
window edge can be off by the few seconds a delivery waits in the queue.
Verified historical observations use `appendPost` in a separate chronological
recovery archive named by `postRecoveryArchivePath`. They never rewrite live
history, queue state or provider receipts. Unknown original kinds stay `notice`,
not invented answers. Earlier records may differ by boundary whitespace; the
writer now records accepted content rather than the pre-send payload.

## Readers

- `amux log PROJECT -p N` reads canonical input and posted output, even for a
  stopped pane. Defaults: last three input groups, seven days, 64 KiB of display.
  Narrow with `--since` or `--grep`, or raise `--max-bytes` to at most 1 MiB.
  Truncation is visibly labelled and does not change stored rows. `--full`
  stays canonical; `--raw` explicitly selects the provider journal, and
  `--tmux -s 60` inspects a live composer or dialog.
- `amux asks` derives answer status from successful `reply`/`file`/`voice`
  posts. `--full` shows the complete posted answer, not the legacy preview.
  `--raw` is the explicit old-reader diagnostic. Engine compact summaries,
  task notifications and relays do not become human asks.
- `amux search "exact words"` includes canonical rows from the last 30 days.
  The warm search daemon answers from a word index it keeps in memory and
  follows the log by inode and byte offset, so a question never rescans the
  log; a cold answer leaves these rows out and says so. His messages are also
  copied word for word to `~/.agentmux/search-human/YYYY-MM-DD.md`, a derived
  copy that can be deleted and rebuilt (`AMUX_SEARCH_HUMAN=0` turns it off).
  `--source conversation` scans the log itself, without starting neural
  readers. `--show N` expands the immutable row id and event time, preserving
  its source and Discord id after rotation. The log stays the only source.
- `amux memory status` shows the file sizes, the last day's posts and posting
  panes, failed sends, and the share of settled human asks answered by a post.
  It warns when meaningful settled input has no later successful post for ten
  minutes. This is an observable gap, not proof that the writer caused it.
- `amux dream` reads the log first by default.
  Panes that posted an answer in their window are built from asks and the
  `reply`/`file`/`voice` posts after each ask; Dream's own prompt and the
  curator's reply to it are left out. Panes without posted work, or whose
  requested window predates logging, use the provider journal; the source is
  exposed in the packet. A post after the cursor with an older input retains
  that input as explicitly quoted context, not a fabricated new human ask.
  Consecutive inputs from the same origin before their first
  output form one logical turn, with every original `logId` preserved in
  `logIds`. The output is stored once; repeated authored inputs remain distinct.
  A different origin or a Dream prompt starts a separate turn. Engine paste
  envelopes are decoded only for observation matching and origin classification,
  never rewritten in the ledger. Task notifications do not become human asks
  or separate an input from its answer. The shadow prints its comparison in `amux dream --dry`
  and saves it per run in `~/.agentmux/dream-shadow/`, including the actual
  `primarySource`. `AMUX_DREAM_SOURCE=raw` selects the raw-source retreat;
  an unknown value is refused. The comparison never moves a receipt.
- Revive, timeline and ask backfill retain their existing diagnostic paths
  during the two-night transition. A conversation row never authorizes resend.
- Window reads go newest file first and stop at the first archive rotated
  before the window.

## Switching sources

Before activation, compare actual Discord message ids and accepted content
against canonical rows at both writer seams. Every observed post must be
recorded, no pane omitted, and the Dream packet at most 96 KiB. Record the
installed source and actual activation time. The unanswered-input percentage
is health, never a source-switch gate.

Keep `AMUX_DREAM_SOURCE=raw`, `amux log --raw` and `amux asks --raw` as the
documented way back. Legacy deletion and final stale-link cleanup require two
genuinely new green scheduled nights after activation, with validated saved
Dream snapshots, no lost pane and actual post-completeness evidence. Recovered
historical posts or a recalculated old night do not count as a new night.

Coverage measures settled human inputs accompanied by successfully posted
output, not whether an agent fulfilled every requirement in the input. Failed
posts, agent relays, maintenance and task notifications do not inflate it.
Several human messages before one reply can share that output without losing
any original ask. An unrelated agent reply cannot close an earlier human gap.
Nightly coverage uses that run's requested time window, not all history since
the first post. It proves posted output accompanied the input, not that every
requirement was fulfilled.
