# Conversation log

One compact, durable record of everything that passes through amux, the same
for every engine: what was asked of a pane (`ask`) and what amux posted to
Discord (`post`). It lives in the existing ask ledger,
`~/.agentmux/ask-ledger.jsonl` (override: `AMUX_ASK_LEDGER_PATH`), mode 0600,
rotated beside itself at 32 MiB. Archives are kept: they are the record of
what was said.

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

`event: "post"`, outbound, one row per message amux posted:

| Field | Meaning |
|---|---|
| `agent`, `pane` | the pane that owns the channel, `null` for a DM or an unbound channel |
| `channelId`, `messageId` | the Discord ids |
| `via` | `bridge` or `cli`, the send point that posted it |
| `kind` | `reply` (an agent's turn), `mirror` (a prompt or brief shown in the channel, a voice transcript), `file` (an image or file), `voice` (`amux say`), `notice` (status, receipts, warnings) |
| `text` | the text exactly as posted |
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

A post is recorded after Discord accepted it. A failed record is printed as a
warning and never turns into a second post.

## Readers

- `amux asks`, revive and the ask backfill read `ask` rows and skip `post` rows.
- `amux dream` runs a shadow on the log beside its current journal source.
  Panes that posted an answer in their window are built from asks and the
  `reply`/`file`/`voice` posts after each ask; Dream's own prompt and the
  curator's reply to it are left out. Panes without such posts, or whose
  answers belong to an ask from before their window, fall back to the
  provider journal. Every delivered ask starts a turn in the log, while a
  journal folds messages delivered mid-turn into the running turn and defers
  it, so the log can show a busy pane the journal leaves for the next night. The shadow prints its comparison in `amux dream --dry`
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
