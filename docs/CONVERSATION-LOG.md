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

`event: "post"`, outbound, one row per send attempt:

| Field | Meaning |
|---|---|
| `agent`, `pane` | the pane that owns the channel, `null` for a DM or an unbound channel |
| `channelId`, `messageId` | the Discord ids |
| `via` | `bridge` or `cli`, the send point that posted it |
| `kind` | `reply` (an agent's turn), `mirror` (a prompt or brief shown in the channel, a voice transcript), `file` (an image or file), `voice` (`amux say`), `notice` (status, receipts, warnings) |
| `text` | the text exactly as posted, or as attempted |
| `status`, `error` | `sent`, or `failed` with the error code and message |
| `deliveryId` | the delivery the post belongs to, when known |
| `files` | posted file paths, never their contents |
| `truncated`, `textBytes` | set only when `text` passed 64 KB; a Discord message is at most 2000 characters, so this marks a pathological payload |
| `askId` | the ask it answers, when known (not yet written) |

## Writers

- **pane hook, delivery queue, Discord inbound**: `ask` rows, before delivery.
- **Bridge Discord adapter** (`channels/discord.mjs`, `channels/normalize.mjs`):
  every `send`, `replyTo` and reply to a person's message calls `onSent`, and
  the bridge records it through `recordDiscordPost` (`channels/post-ledger.mjs`).
  The pane watchers tag agent turns `reply` and their image groups `file`.
- **CLI REST posts** (`cli/send-notify.mjs`): `discordPost` and
  `discordPostFile` record through the same `recordDiscordPost`. Mirrored sends
  are `mirror`, `amux image` is `file`, `amux say` is `voice`, the rest `notice`.

A post is recorded after the send attempt: `sent` with the Discord ids, or
`failed` with the error, and the caller still sees the failure. A failed
record is printed as a warning and never turns into a second post.

Only `core/ask-ledger.mjs` reads or writes the file: `appendAskLedger`,
`appendPost` and `readWindow({ since, until, agents })`. A test fails if any
other module names the file. `readWindow` opens only the files whose first and
last rows overlap the window, read from a 64 KB probe at each end, and returns
rows ordered by (`ts`, `id`). Rows are appended in about time order, so a
window edge can be off by the few seconds a delivery waits in the queue.

## Readers

- `amux asks`, revive and the ask backfill read `ask` rows and skip `post` rows.
- `amux memory status` shows the file sizes, the last day's posts and posting
  panes, failed sends, and the share of settled human asks answered by a post.
- `amux dream` runs a shadow on the log beside its current journal source.
  Panes that posted an answer in their window are built from asks and the
  `reply`/`file`/`voice` posts after each ask; Dream's own prompt and the
  curator's reply to it are left out. Panes without such posts, or whose
  answers belong to an ask from before their window, fall back to the
  provider journal. Consecutive inputs from the same origin before their first
  output form one logical turn, with every original `logId` preserved in
  `logIds`. The output is stored once; repeated authored inputs remain distinct.
  A different origin or a Dream prompt starts a separate turn. Engine paste
  envelopes are decoded only for observation matching and origin classification,
  never rewritten in the ledger. Task notifications do not become human asks
  or separate an input from its answer. The shadow prints its comparison in `amux dream --dry`
  and saves it per run in `~/.agentmux/dream-shadow/`. It never changes the
  packet the curator receives.
- Window reads go newest file first and stop at the first archive rotated
  before the window.

## Switching sources

The order is: post rows (no reader changes), one night of shadow, then Dream
and `amux asks` switch to the log, with `AMUX_DREAM_SOURCE=raw` kept for a week
as the way back. The switch needs the shadow to show at least 95 % of settled
`discord` and `pane-hook` asks answered by a post, no pane omitted and the
packet within 96 KB. Legacy readers are removed only after two green nights.

Coverage measures settled human inputs accompanied by successfully posted
output, not whether an agent fulfilled every requirement in the input. Failed
posts, agent relays, maintenance and task notifications do not inflate it.
Several human messages before one reply can share that output without losing
any original ask. An unrelated agent reply cannot close an earlier human gap.
Nightly coverage uses that run's requested time window, not all history since
the first post. Recalculating an old night with a corrected reader is diagnostic
evidence, not permission to skip a new real shadow night.
