# amux search: his messages as units, the conversation log in the daemon, 30 minutes warm while memory is free

Version: 3 · 2026-10-20 08:20Z · owner of the design: api:0 · page: none yet
<!-- stale: -->

## 1. Goal

lsrc:0's decision on his question of 20 Oct (daily log 2026-10-20, lsrc:0's headings on amux search), from sandman:0's
review of 20 Oct (https://claude.ai/artifact/5zFCbJGLAyRyRMShphPAbp). In the review, the 47 blind round-6 questions
(sha256 bae5e685) give 94 % hit@3 and 87 % hit@1 warm on 1.25.274. The median is 5.46 s and p95 is 9.14 s, against
1.18 s on 10 Oct. 3.9 s of that is the conversation-log scan from f568d7c0, which reads all 238 MB on every question.
18 of 69 real searches in 48 h ran cold, because the daemon closes after 2 minutes, and the cold path gives 70 % hit@3.

His questions of 20 Oct 07:12Z about the memory a warm daemon holds, and his answer at 07:26Z that leaves the choice to
api:0 and asks for everything to be written down (daily log 2026-10-20, api:0's heading on the search daemon's
memory), add outcome 3.

The outcome:

1. The daemon follows the canonical conversation log incrementally and reads only new lines. His messages become
   their own searchable units in the same layers as the notes (BM25, bge-m3, the reranker), so his exact words can
   come up in step one. No question rescans the whole log.
2. The daemon stays warm for 30 minutes after the last search, not 2.
3. The daemon holds memory only while the machine has room. It does not start without room for its peak, and it
   closes when free memory falls under a floor.

Principles, in the order they decide:

1. Same answers, less time. A change that loses hit@1 or hit@3 on the 47 blind questions does not ship.
2. No memory the machine needs. The daemon gives its RAM back before anything else runs short; a cold answer is the
   price.
3. One writer per derived file. The log stays the only source; derived files can always be rebuilt from it.
4. Reuse the note pipeline. His messages become Markdown units, so parsing, BM25, the live overlay, the nightly
   reindex, the reranker and `--show` work unchanged.
5. Honest output. A layer that did not run says so on the result, as the semantic layer does today.

Non-goals:

- No PRIORITIES.md root, no correction links and no recency weight. Those are the review's items 2, 3 and 5.
- No model change, and no history beyond the conversation log's 30-day window.

## 2. UX

n/a: a command-line tool with no screens. The result lists keep their form. What changes for the reader:

| Place | Product text | Max length | Stage |
|---|---|---|---|
| Result source of a message of his | `~/.agentmux/search-human/2026-10-20.md:14` and the snippet `**HH:MM:SSZ agent:pane voice** <his words>` | 220 | v1 |
| Warning when the daemon is cold and no `--source conversation` | `ℹ conversation log is searched by the warm search daemon; it is starting, so this answer leaves it out` | 110 | v1 |
| `amux search --help` | "The search daemon stays loaded for 30 minutes after the last question" in place of "exits when idle" | 80 | v1 |
| `amux search --help`, appended to the line above | ", while at least 8 GB RAM is free" | 40 | v2 |
| Notice when the guard keeps the daemon down | `ℹ 6.2 GB RAM free, the search daemon starts at 12 GB; lexical only this time; showing first-stage order` | 110 | v2 |
| The daemon's own log line when it closes for memory | `search-embedder: closing, 7.4 GB RAM free is under the 8 GB floor` | 80 | v2 |

## 3. Use cases

- **UC-1 Warm question.** An agent runs `amux search "vad sa Mattias om autocompact-gränsen"` while the daemon is up.
  - Today the answer takes 5.46 s median, 3.9 s of it scanning 238 MB of log.
  - After: the daemon answers the conversation step from memory in under 50 ms, and the median is about 1.6 s
    (*estimated*: 5.46 − 3.9).
  - Cost: no network, no money. Stage v1. Sequence: §5 seq-warm.
- **UC-2 His exact words in step one.** An agent asks `amux search "vad sa Mattias exakt om att Opus planerar och
  Sonnet utför"`.
  - His 19 Oct message on who carries out plans is a unit in `search-human/2026-10-19.md`. It competes in BM25,
    bge-m3 and the reranker like a note bullet, and `--show N` prints it whole with its time and pane.
  - Today the same words come only from the word-AND step, after the agents' rows.
  - Stage v1. Sequence: §5 seq-warm.
- **UC-3 A new message.** He writes to a pane at 10:00:00Z, and an agent searches for it at 10:00:40Z.
  - The bridge appends the row. The next question makes the daemon read the new bytes, add the bullet to the day file
    and index its words. The live overlay embeds it within its 30 s scan, so it is found lexically at once and
    semantically within about 30 s.
  - Stage v1. Sequence: §5 seq-new.
- **UC-4 Cold question.** The first question after 30 minutes idle.
  - The CLI starts the daemon in the background and answers with notes and his messages through BM25. The agents'
    conversation rows are left out, and a warning says so.
  - With `--source conversation` the CLI still scans the log as today, because the reader asked for it.
  - Stage v1. Sequence: §5 seq-cold.
- **UC-5 Night.** The nightly reindex first brings the derived files up to date, then embeds them on the GPU with
  the notes. Stage v1. No sequence: one local process, no new boundary.
- **UC-6 Memory runs short.** A build fills RAM until 7 GB is free while the daemon is warm.
  - Within 30 s the daemon closes, after any question in flight, and gives back about 3 GB RAM and 2.3 GB VRAM
    (*measured* warm, §7). Its log says why.
  - Questions get the cold answer with the guard's notice until 12 GB is free; none of them starts the daemon.
  - Cost: cold answers (70 % hit@3) while memory is short. Stage v2. No sequence: each process reads
    `/proc/meminfo` itself, no new boundary.
- **Unhappy cases:**
  - Log rotation (a 32 MB file is renamed and a new `ask-ledger.jsonl` starts): the reader follows the renamed file
    by inode to its end, then starts the new file at 0.
  - A partial last line, mid-write: kept as a remainder and parsed when its newline arrives.
  - A rewritten log (size smaller than the saved offset, or an unknown inode at a known path): read again from 0.
    Duplicates are dropped by row id.
  - Two callers at once (the daemon, the CLI cold path and the reindex): one file lease. Whoever does not get it
    reads the files as they are.
  - Disk full while appending a day file: the error surfaces once. The offset is saved only after a successful
    write, so nothing is lost.
  - A delivery and its pane-hook copy: one unit, by the same rule as `coalesceAskLedger` (same agent, pane and
    authored text within 15 minutes).
  - Agents' briefs (`[from …]`), task notifications and system wrappers are never his units (`inferAskOrigin`,
    `isSystemNoiseDirective`).
  - The daemon dies mid-session: the next question is cold (UC-4) and restarts it.

## 4. Architecture

```mermaid
%% id: arch
flowchart LR
  L[(conversation log: ask-ledger*.jsonl)] ==> T[ledger-tail.mjs: new rows since the saved offsets]
  T ==> H[search-human-words.mjs: his messages to day files]
  H ==> F[(~/.agentmux/search-human/YYYY-MM-DD.md)]
  T ==> W[conversation-window.mjs: rows and an inverted word index]
  F --> P[search-passages BM25] --> R[reranker]
  F --> V[live index and nightly reindex: bge-m3]
  W ==> D[search-embedder daemon: op conversation]
  M[memory guard: MemAvailable] ==> D
  D --> C[cli/search.mjs collectSearchHits]
  P --> C
  V --> C
  %% solid = exists, thick = new
```

- Identity:
  - a log row is its `id`;
  - a unit of his is the bullet carrying that `id`;
  - a log file is its inode, never its path, because rotation renames it.
- Ownership:
  - `search-human-words.mjs` is the only writer of `~/.agentmux/search-human/` and its `state.json`, under one file
    lease;
  - `conversation-window.mjs` owns the daemon's rows and index.
- One exit: n/a: nothing leaves the machine. The derived files are mode 600 in `~/.agentmux`, like the log.
- Switches:
  - `AMUX_EMBEDDER_IDLE_MIN` decides how long the daemon stays up after the last question (default 30, was 2);
  - `AMUX_SEARCH_HUMAN=0` leaves the human root out of every search and stops the sync;
  - `AMUX_EMBEDDER_MIN_FREE_GB` decides the memory floor (default 8). The daemon starts only with the floor plus
    4 GB free, because its measured peak is 3.8 GB, and closes within 30 s when free memory falls under the floor.
    0 turns the guard off.
- Invariants:
  - **I-1** No question reads a log byte twice in a warm daemon. Enforced in `ledger-tail.mjs`, guarded by
    `core/ledger-tail.test.mjs`, "reads only bytes appended since the last call".
  - **I-2** Each message of his is exactly one unit (split only by the 1 600-character cap), with its words unchanged
    apart from the bridge's voice prefix. Enforced in `search-human-words.mjs`, guarded by
    `core/search-human-words.test.mjs`, "writes each message of his once, word for word".
  - **I-3** Warm conversation hits equal what `searchConversationLog` returns for the same rows. Enforced in
    `conversation-window.mjs`, guarded by `core/conversation-window.test.mjs`, "finds the same rows as the scan".
  - **I-4** The daemon never starts without room for its peak, and never stays more than 30 s under the floor.
    Enforced in `core/search-embedder.mjs` (`memoryRoom`), guarded by `core/search-embedder-lifecycle.test.mjs`,
    "does not start without room for its peak" and "closes when free memory falls under the floor".

## 5. Behaviour (UML)

```mermaid
%% id: seq-warm
sequenceDiagram
  participant A as agent
  participant C as cli/search.mjs
  participant D as search-embedder daemon
  participant T as ledger-tail.mjs
  participant L as ask-ledger.jsonl
  A->>C: amux search "question" (UC-1, UC-2)
  C->>D: op conversation, query
  D->>T: tail()
  T->>L: read from saved offset to end
  L-->>T: new bytes only
  T-->>D: new rows
  D->>D: human sync appends day files; window adds rows to the word index
  D-->>C: conversation hits
  C->>D: passages, semantic, rerank, as today
  D-->>C: ranked units, his messages among them
  C-->>A: hits #1 to #12
```

```mermaid
%% id: seq-new
sequenceDiagram
  participant B as bridge
  participant L as ask-ledger.jsonl
  participant D as search-embedder daemon
  participant F as search-human day file
  participant V as live index
  B->>L: append his row (UC-3)
  D->>L: next question: read the new bytes
  D->>F: append his bullet
  D->>V: refresh: the day file changed
  V->>V: embed the new unit within 30 s
```

```mermaid
%% id: seq-cold
sequenceDiagram
  participant A as agent
  participant C as cli/search.mjs
  participant H as search-human-words.mjs
  participant D as search-embedder daemon
  A->>C: amux search "question", daemon down (UC-4)
  C->>D: connect fails
  C->>D: start in the background
  C->>H: sync under the lease (new bytes only)
  C->>C: BM25 over notes and his day files; no conversation scan unless --source conversation
  C-->>A: hits, with the warning that the conversation log was left out
```

```mermaid
%% id: state-daemon
stateDiagram-v2
  [*] --> Down
  Down --> Loading: a question finds no socket, and the floor plus 4 GB is free
  Down --> Down: a question finds no socket, and less is free (lexical answer)
  Loading --> Warm: model, vectors and the conversation window loaded
  Warm --> Warm: a question resets the 30-minute timer
  Warm --> Down: 30 minutes without a question, nothing pending
  Warm --> Down: free memory under the floor at a 30 s check, after the question in flight
```

## 6. Pseudocode

```
tail(state, files):                                   # ledger-tail.mjs
  for file in ledger spans in time order:
    id = inode(file); known = state[id]
    if known and known.size > size(file): known = none     # rewritten: read again, ids dedupe
    start = known ? known.offset : 0
    if start == size(file): continue                         # nothing new: no read
    bytes = read(file, start, size - start)
    text = known.remainder + bytes; lines = complete lines; remainder = after the last newline
    rows += parse(lines) where row.version is current
    state[id] = { path: file, size, offset: size - len(remainder), remainder }
  forget state entries whose inode no longer exists
  return rows
  # tests: ledger-tail.test.mjs "reads only bytes appended since the last call",
  #        "follows a rotated file by inode", "keeps a partial line until it ends", "reads a rewritten file again"

syncHumanWords(dir, now):                             # search-human-words.mjs
  lease = acquire(dir/.lease) or return "busy"
  rows = tail(state.tail, spans since now - 30 days)
  for ask in rows where isHumanAsk(ask) and ts within the window:
    text = authoredPromptText(ask.verbatim) without the bridge voice prefix
    if seen(ask.id) or a written ask has the same agent, pane and text within 15 min: continue
    append "- **HH:MM:SSZ agent:pane[ voice]** text" (continuation lines indented 2) to dir/<UTC date>.md
    remember (ask.id, agent, pane, hash(text), ts)
  delete day files older than 30 days; prune the remembered keys to the window
  save state only after every append succeeded; release lease
  # tests: search-human-words.test.mjs "writes each message of his once, word for word",
  #        "drops agents' briefs and system wrappers", "merges a delivery with its pane-hook copy",
  #        "deletes days past the window", "resumes after a failed append without losing a message"

conversationWindow.search(query, max):                # conversation-window.mjs (daemon)
  add(tail(...)) first: rows into the 30-day window, tokens into an inverted index (token -> row ids)
  words = unique searchTokens(query); empty -> []
  for word: rows matching tokenMatches(word, token) for any indexed token (exact, or a 4+ letter prefix either way)
  candidates = intersection over words; drop rows older than 30 days
  score each as searchConversationLog does; sort and cut to max
  assert result equals searchConversationLog over the same rows        # I-3
  # tests: conversation-window.test.mjs "finds the same rows as the scan", "finds a row appended after warm-up"

collectSearchHits conversation step:                  # cli/search.mjs
  if daemon answers op conversation: ledgerHits += its hits
  else if flags.source names conversation: ledgerHits += searchConversationLog(content)      # explicit request
  else: warn the conversation log was left out; syncHumanWords() so his day files are current
  # tests: search.test (cli) "uses the daemon's conversation hits when it is warm",
  #        "leaves the scan out when cold unless --source conversation"

memoryRoom(needGb):                                   # search-embedder.mjs
  floor = AMUX_EMBEDDER_MIN_FREE_GB (default 8); floor == 0 -> { room: true }          # guard off
  free = MemAvailable of /proc/meminfo, in GB
  unreadable -> { room: true }, and the daemon logs "memory guard off: no /proc/meminfo" once
  return { room: free >= needGb, free }

startEmbedder():
  r = memoryRoom(floor + 4)
  not r.room -> return { unavailable: "<free> GB RAM free, the search daemon starts at <floor + 4> GB; lexical only this time" }
  spawn as today

daemon, every 30 s while up (unref'd timer):
  not memoryRoom(floor).room -> log "closing, <free> GB RAM free is under the <floor> GB floor";
                                close at the first moment no question is in flight, by the idle timer's close
  # tests: search-embedder-lifecycle.test.mjs "does not start without room for its peak",
  #        "closes when free memory falls under the floor", "a floor of 0 turns the guard off"
```

## 7. Platform limits

- Log size: 238 MB in 30 days, 9 files, 28 337 asks and 266 929 rows. *Measured* by sandman:0, 20 Oct.
- Rotation at about 32 MB: the active file is renamed and keeps its inode. *Measured*: `ls -l ~/.agentmux/ask-ledger*`,
  20 Oct, files of 33 554 527 to 33 556 189 bytes. Same filesystem, so rename keeps the inode (*documented*:
  rename(2)).
- His messages: about 7 400 in 30 days, about 2 million characters. *Measured* by sandman:0. A first count of mine
  over all files gave 8 854 in October, before the pane-hook copies merge, so the builder reports the real count.
- Daemon memory on 1.25.275, *measured* 07:15Z (`~/.agentmux/artifacts/search-daemon-2026-10-20/warm.log`): 1.67 GB
  RSS before the models, 1.95 GB with the query model, 2.8 to 2.9 GB warm with the GPU reranker, 3.4 to 3.8 GB while
  the live overlay embedded the day's changed notes, peak 3.81 GB. It was 4.1 GB on 10 Oct.
- GPU: RTX 3090, 24 GB. 3.94 GB in use without the daemon and 6.25 GB warm, so the reranker holds 2.3 GB. Back to
  3.94 GB when the daemon closed 2 minutes after the last question. *Measured* (`nvidia-smi`), same run.
- CPU: one start with three questions used 323 s user and 16 s system CPU in 192 s. Each start embeds every note
  changed since the nightly reindex again, because the overlay lives only in memory (`core/search-live-index.mjs`).
  *Measured*, same run.
- Cold first question: 9.6 s at load 3. *Measured*, same run.
- Machine: the WSL VM has 54.2 GB, with 39.5 GB available and 12.9 of 16 GB swap used at 07:15Z. *Measured*
  (`free -m`). MemAvailable is the VM's view and does not see pressure on the Windows side. *Documented*: WSL2 runs
  Linux in a VM with its own memory limit (https://learn.microsoft.com/en-us/windows/wsl/wsl-config, `memory`).
- Search pattern: 229 `amux search` calls in the agents' transcripts (Claude and Codex, subagents included) in the
  48 h before 07:15Z. *Measured* (`search_times.py` in the same folder). sandman:0 counted 69 by another method.
- CPU embedding in the live overlay: at most 4 000 units per 30 s scan (`MAX_UNITS_PER_SCAN`). The first backfill
  runs as one GPU reindex instead.
- Load: the machine runs the fleet's tests, load about 20 on 24 cores at 06:5xZ. *Measured*. Timings are compared
  only before and after in the same window, with the load average beside them.

## 8. Alternatives

| Option | Cost per question | Build | Decided by | Reopen when |
|---|---|---|---|---|
| A. As today: scan 30 days on every question | 3.9 s, growing daily | 0 | the cost that the review measured | never |
| **B. Derived Markdown for his words, plus an in-memory word index in the daemon (chosen)** | under 50 ms | 3h | reuses every layer and the reindex; nothing new to rank | the derived files disagree with the log in a test |
| C. His messages as a new unit type inside the semantic index, with no files | under 50 ms | 5h | needs new code in BM25, the overlay, the reranker text and `--show` | the Markdown form loses his words' exactness |
| D. SQLite FTS over the whole log | about 10 ms | 4h | a native dependency, and it gives no semantic units of his | the window grows past 1 GB |
| E. QMD (github.com/tobi/qmd) as the engine | *to be measured*, row 47 | 1h to compare | its keyword mode was tried on 20 Sep: 17/20 first and 20/20 in three on 20 keyword questions, 1/20 on whole questions; its hybrid mode was never tried | its hybrid mode beats ours on the 47 blind questions at a similar median |

The approach that already worked was the 10 Oct pipeline at 1.18 s. B is that pipeline with one more root.

Warm time, decided by the table in §10: 30 minutes cuts cold searches from 71 % to 10 %, and the memory guard gives
the RAM back whenever anything else needs it. Reopen when the daemon logs a close for memory more than once a day, or
when he asks for less.

## 9. Risks

- **R-1 His words are changed or lost in the copy.** Possible, costly: the point is exactness.
  - Mitigation: verbatim text, only the bridge's voice prefix removed; offsets saved after the write.
  - Detection: "writes each message of his once, word for word"; the three verbatim questions v14 to v16.
  - Fallback: `--source conversation` still reads the log itself. Owner api:0.
- **R-2 Agents' words are counted as his.** Possible.
  - Mitigation: the same predicate as the Dream answer statistic (`HUMAN_ASK_SOURCES` and `inferAskOrigin`), moved
    to one exported function.
  - Detection: "drops agents' briefs and system wrappers".
  - Fallback: `AMUX_SEARCH_HUMAN=0`. Owner api:0.
- **R-3 The daemon's memory grows with the window.** Likely, small.
  - Mitigation: rows keep only the fields the scan uses, and the index holds row ids.
  - Detection: RSS and VRAM measured warm, written in §10.
  - Fallback: shorter window for agents' rows. Owner api:0.
- **R-4 Warm for 30 minutes holds 2.8 to 3.8 GB RAM and 2.3 GB VRAM while no one searches.** Certain, 34 of 48 h.
  - Mitigation: the memory guard (I-4) gives the RAM back when free memory falls under 8 GB.
  - Detection: "closes when free memory falls under the floor"; the daemon's log line of §2.
  - Fallback: `AMUX_EMBEDDER_IDLE_MIN` and `AMUX_EMBEDDER_MIN_FREE_GB`. Owner api:0.
- **R-5 Cold answers lose the agents' conversation rows.** Certain, for the first question after 30 minutes.
  - Mitigation: his messages stay in the cold path through BM25, and the warning says what was left out.
  - Detection: the `--lexical` and cold runs in §12.
  - Fallback: `--source conversation`. Owner api:0.
- **R-6 A rewritten or truncated log duplicates or skips rows.** Unlikely.
  - Mitigation: inode and size checks, dedupe by id.
  - Detection: "reads a rewritten file again".
  - Fallback: delete `state.json`, and the next sync rebuilds. Owner api:0.
- **R-7 The guard flaps: the daemon starts, loads 3.8 GB, falls under the floor and closes, again and again.**
  Possible when free memory sits near the floor.
  - Mitigation: a start needs the floor plus 4 GB, more than the measured peak of 3.8 GB.
  - Detection: "does not start without room for its peak".
  - Fallback: raise `AMUX_EMBEDDER_MIN_FREE_GB`. Owner api:0.
- **R-8 The guard misses memory pressure on the Windows side.** Possible, because MemAvailable is the VM's view (§7).
  - Mitigation: the 30-minute timer still bounds the time the memory is held.
  - Detection: none in the code. His report, or the Windows task manager's figure for the WSL VM.
  - Fallback: a lower `AMUX_EMBEDDER_IDLE_MIN`. Owner api:0.

## 10. Cost and time

- Money: none. Local CPU and GPU.
- Time per question: today 5.46 s median warm (*measured*, review). After: about 1.6 s (*estimated*).
- Daemon resources while warm, *measured* on 1.25.275 (§7): 2.8 to 3.8 GB RSS, 2.3 GB VRAM, and 323 CPU-s for one
  start with three questions. With the conversation window: *to be measured* after v1 and written here.
- Warm time against the real pattern (§7, 229 searches in 48 h), with RAM at 3 GB while warm. *Measured* pattern,
  *estimated* average:

| Timer | Cold searches | Warm of 48 h | RAM on average |
|---|---|---|---|
| 2 min (until v1) | 163 (71 %) | 6.3 h | 0.4 GB |
| 10 min | 72 (31 %) | 21.4 h | 1.3 GB |
| 15 min | 50 (22 %) | 26.3 h | 1.6 GB |
| 30 min (chosen) | 24 (10 %) | 34.4 h | 2.2 GB |
| 60 min | 8 (3 %) | 41.7 h | 2.6 GB |

- Starts fall from 163 to 24 per 48 h, and with them the CPU each start spends embedding the day's changed notes
  again. *Estimated* from the code (§7).
- Time, from the file list:
  - New `core/ledger-tail.mjs` (70 lines) and its test, 45 min.
  - New `core/search-human-words.mjs` (110 lines) and its test, 75 min.
  - New `core/conversation-window.mjs` (90 lines) and its test, 60 min.
  - Changed `core/search-embedder.mjs` (op conversation, idle 30 min, 25 lines), `cli/search.mjs` (20 lines),
    `core/search.mjs` (the human root, 15 lines), `core/ask-origin.mjs` and `core/dream-conversation.mjs` (the shared
    predicate, 10 lines), `core/search-semantic.mjs` (sync before reindex, 5 lines), 45 min.
  - The measurements before and after, 30 min.
  - The memory guard: `core/search-embedder.mjs` (`memoryRoom`, the start check and the 30 s check, 30 lines),
    `cli/search.mjs` (one help line) and three lifecycle tests, 40 min.
  - Total *estimated* 5.2h for Sonnet builders plus 30 min of api:0's review. The eval runs dominate the wall time.

## 11. Rollout and rollback

- Order: release, install, stop the daemon, one `amux search --reindex` on the GPU for the backfill, then the
  measurements. Everyone gets it at once.
- Switches: `AMUX_SEARCH_HUMAN=0` leaves the root out, `AMUX_EMBEDDER_IDLE_MIN=2` restores the old timer, and
  `AMUX_EMBEDDER_MIN_FREE_GB=0` turns the memory guard off.
- Turning it off leaves the day files in place. They are derived, never read again, and can be deleted.
- Migrations: none. The semantic index gains the new root's units on its next reindex.
- Texts in the same release: `SEARCH_HELP` (the daemon's lifetime and the human root).
- Rollback: install the previous release SHA (5f8a6776) with `bin/install-release.mjs`.

## 12. Tests

| Changed path | Tests that run |
|---|---|
| `core/ledger-tail.mjs` | `core/ledger-tail.test.mjs` |
| `core/search-human-words.mjs` | `core/search-human-words.test.mjs` |
| `core/conversation-window.mjs` | `core/conversation-window.test.mjs` |
| `core/search-embedder.mjs` | `core/search-embedder-lifecycle.test.mjs`, `core/conversation-window.test.mjs` |
| `cli/search.mjs` | `cli/search.test.mjs` |
| `core/search.mjs` | `core/search.test.mjs` |
| `core/ask-origin.mjs` | `core/search-human-words.test.mjs`, `existing ask-origin and dream-conversation tests` |
| `core/dream-conversation.mjs` | `existing ask-origin and dream-conversation tests` |
| `core/search-semantic.mjs` | `core/search-semantic.test.mjs` |

| Test | Guards | Level | Write min | Run s |
|---|---|---|---|---|
| `core/ledger-tail.test.mjs` | I-1, R-6, UC-3 | unit | 15 | 1 |
| `core/search-human-words.test.mjs` | I-2, R-1, R-2, UC-2, UC-3 | component | 20 | 2 |
| `core/conversation-window.test.mjs` | I-3, UC-1 | component | 15 | 2 |
| `cli/search.test.mjs` | UC-1, UC-4, R-5 | component | 10 | 3 |
| `core/search.test.mjs` | UC-2 | component | 5 | 3 |
| `core/search-embedder-lifecycle.test.mjs` | R-4, R-7, I-4, UC-6 | unit | 10 | 1 |
| `core/search-semantic.test.mjs` | UC-5 | component | 3 | 3 |
| `existing ask-origin and dream-conversation tests` | existing, R-2 | unit | 0 | 2 |

- Budget: write 78 min of the 330 min of build in chapter 13 (rows 43, 44 and 46; 24 %); targeted run 17 s.
- Full proof: none: no money, sign-in, deletion of user data or migration. The derived files are a private copy of
  his words on the same machine, in the same folder as their source, mode 600.
- Touched tests: `existing ask-origin and dream-conversation tests` are kept unchanged; the predicate moves without
  changing a result.
- Hardest case: the real 30-day log (238 MB, rotation inside the window) through the real daemon, with the 47 blind
  questions warm.
- Rehearsal step: on the installed release, `amux search --reindex`, then `amux search --eval heldout-r6.jsonl` warm
  and `--lexical`, and the three verbatim questions; cap 600 s.
- Fixtures: a synthetic log of three files with a rotation (same inode, new path), a partial last line, a delivery
  and its pane-hook copy, an agent brief, a task notification, a voice message, a 2 000-character message and a row
  older than 30 days.
- Browsers and devices: n/a. Live categories touched: performance that must be measured.
- Small first:
  - [ ] Pieces: n/a: until the build; each test runs on the synthetic three-file log in seconds.
  - [ ] Edge cases: n/a: until the build; the fixtures above carry the real log's rotation, merges and prefixes.
  - [ ] Seams: n/a: until the build; the daemon socket and the real log are run by the rehearsal step.
  - [ ] Whole path: n/a: until the build; the installed CLI against the daemon on a copy of the log, cap 600 s.
  - [ ] Big input last: n/a: until the build; the real log and the 47 questions, once, last.

## 13. Tasks

| # | Task | Owner | State | Estimate | Spec | Done when |
|---|---|---|---|---|---|---|
| 43 | His messages as search units, and the conversation log in the daemon without rescans | api:0 | working: Sonnet builds, api:0 reviews | 4.5h | [Search §6](DESIGN-search-daemon.md#6-pseudocode) | warm median about 1.6 s with no loss in hit@1 or hit@3 on the 47 blind questions |
| 44 | Daemon warm for 30 minutes, with its RAM and VRAM measured | api:0 | working: Sonnet builds, api:0 reviews | 0.3h | [Search §11](DESIGN-search-daemon.md#11-rollout-and-rollback) | the daemon stays up 30 minutes after a question, and §10 holds its measured RSS and VRAM |
| 45 | Release with before and after on the same machine | api:0 | open | 0.5h | [Search §12](DESIGN-search-daemon.md#12-tests) | installed release; 47 questions and v14 to v16 warm and cold before and after, with load averages, in §10 |
| 46 | Memory guard: the daemon starts only with room for its peak and closes under the floor | api:0 | open: Sonnet builds after 43, api:0 reviews | 0.7h | [Search §6](DESIGN-search-daemon.md#6-pseudocode) | under 8 GB free the daemon closes within 30 s, and none starts under 12 GB; tests red before, green after |
| 47 | QMD's hybrid mode against the 47 blind questions | api:0 | open: after 45 | 1h | [Search §8](DESIGN-search-daemon.md#8-alternatives) | QMD hybrid's hit@1, hit@3 and median on the 47 questions stand beside ours in §8, with the choice |

## 14. Open questions

None for him. Calls made by api:0:

- His messages are copied as Markdown into `~/.agentmux/search-human/`, so every existing layer serves them.
- The window stays 30 days, as the conversation search has today.
- A cold question leaves out the agents' conversation rows instead of scanning 238 MB.
- 30 minutes warm, with a memory guard at 8 GB free and starts at 12 GB. He left the choice to api:0 at 07:26Z, and
  the table in §10 decided it.
- No change of engine now. QMD's hybrid mode is measured on the same 47 questions after the release (row 47).

## 15. Changes

- v1, 2026-10-20 07:05Z: first version, from lsrc:0's decision and sandman:0's review.
- v2, 2026-10-20 07:35Z: outcome 3 and the memory guard (principle 2, I-4, UC-6, R-7, R-8, row 46) after his
  questions on memory at 07:12Z and his answer at 07:26Z; measured RSS, VRAM, CPU and the timer table in §7 and §10;
  QMD as option E and row 47. Row 43's builder is not affected; row 46 gets its own brief.
- v3, 2026-10-20 08:20Z: two fragments of his words removed from §2 and UC-2. A public repo carries none of his
  text (fleet rule 10); they were mine in v1.
