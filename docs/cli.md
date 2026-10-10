# CLI Reference

`amux` is the command-line interface for controlling agentmux sessions. `ax` is
installed as a shorter alias for the same binary.

Subscription status, isolated login and explicit account switching are in
[the account profile guide](accounts.md).

## Session Overview

```bash
amux ps
amux top
amux timeline
amux done --since 2h
amux lint
```

| Command | Purpose |
|---|---|
| `amux ps` | Show agents, panes, status, context use, and labels |
| `amux top` | Sort panes by context usage |
| `amux timeline` | Show recent events across panes |
| `amux watch` | Follow the timeline live |
| `amux done` | Summarize commits, active panes, finished panes, and waiters |
| `amux asks` | Show recent human asks/directives with status and jsonl location |
| `amux search` | Search memory, sessions, and the durable delivery ledger |
| `amux lint` | Run default repo linters, starting with WHAT/WHY/DTO/debt contracts |
| `amux churn` | Show WARN-only young-test and rewrite-hotspot signals from git history |
| `amux churn functions\|check\|verdict` | Function hotspots (6+ trunk commits in 60 days); a commit to one needs a recorded REWRITE/SPLIT/KEEP verdict (Claude panes are held by a PreToolUse hook) |

## Bridge Lifecycle

```bash
amux serve            # visible foreground process; Ctrl+C stops it
amux serve --detach   # managed tmux-free background supervisor
amux doctor           # health, tmux geometry/clients, heartbeat, version, and ownership
amux stop             # intentional stop; watchdog does not revive it
amux sync             # sync through the running bridge without changing ownership
amux sync --offline   # standalone sync; safely bounces managed bridges only
```

Foreground is the default so startup failures and restart loops remain visible.
The detached supervisor is identity-proven through its private process receipt,
and the bridge remains discoverable by PID and heartbeat. Agents use `amux
doctor` rather than assuming the bridge must exist inside tmux.
For a manually owned bridge, standalone sync refuses to stop the foreground
process. Passing `amux sync --offline --detach` is the explicit instruction to
transfer it to managed background ownership.

## Search and drill-down

```bash
amux search "restart WSL"
amux search --show 2
amux search "previous decision" --raw     # original lexical search only
amux search "vem organiserade Bumbi" --lexical   # skip the semantic layer
amux search "old raw pane detail" --deep
amux search --reindex
amux search --eval ~/.agentmux/search-eval/golden.jsonl --split heldout
```

Source-bound notes in `memory/topics/`, when published, provide a compact
orientation layer alongside lexical memory and durable-ledger results. `--raw`
omits it; `amux memory topics --json` shows each note's state and deciding DSL
cell. Topic expansion revalidates both page and original sources. See [memory](memory.md).

When there is no exact Markdown phrase match, the same command ranks the
items of current Markdown notes from configured curated (`semantic: true`)
roots: each bullet, `**Name** — …` entry, table row or paragraph is one unit
and carries its title, heading path and entry name. Scores are BM25 over
Swedish word stems, weighted by how much of the question's rare vocabulary a
unit covers, at most two units per file. `--show N` checks the original file
hash and shows the unit inside its section (bounded to 2400 characters); if
the file changed, search again. A relevant passage is evidence, not an
automatic answer or proof that every later correction has been found.

Natural questions also use the local semantic layer: the same units embedded
with `bge-m3` (multilingual, Swedish and English in one space), fused with the
lexical ranking by normalised score. A cross-encoder then rereads the
candidates together with the question: `bge-reranker-v2-m3` on the GPU (top
100, up to six units per note so the answering bullet can beat its
neighbours, and every served topic page whether or not it shares a word with
the question), or the smaller
`mmarco-mMiniLMv2-L12-H384-v1` on the CPU (top 30, blended with the first-stage
order). Dense retrieval's top 50 always enter that pool, so an English line
answering a Swedish question is judged even when lexical matches fill the
budget. The reranker reads each unit with its headings, its entry name and
the lines just around it (at most 800 characters, about what fits in its 256
tokens), so "- Kommunicerar på engelska" is judged as part of Smara's entry. Proper names (capitalised words, and names of people in the
people notes) are matched as written or in the genitive, never stemmed:
"Elina" does not match "Elin". Names written apart, joined or hyphenated ("Cut kit", "cutkit",
"cut-kit") match each other, and a long question word matches compounds that
start with it ("fallskärm" → "fallskärmshoppning"). Identifiers and one- or
two-word names stay lexical; an exact Markdown hit opens the units most about
the phrase (density, a heading or bold lead naming it, decision words)
across all matching notes, with recency only breaking ties.

GPU: ONNX Runtime's CUDA provider comes with onnxruntime-node's postinstall,
which a release install skips; agentmux keeps a copy in
`~/.cache/agentmux/cuda/onnxruntime-node-<version>` and restores it into the
installed package. The provider also needs cuDNN 9, kept in agentmux's own
directory. One-time setup:

```bash
uv pip install --target ~/.cache/agentmux/cuda nvidia-cudnn-cu12==9.*
# once per onnxruntime-node version, from a checkout whose npm install ran scripts:
(cd node_modules/onnxruntime-node && node script/install.js --onnxruntime-node-install=cuda12)
```

With it, the daemon runs the reranker on the GPU (about 2.3 GB VRAM, released
when the daemon exits idle) and `--reindex` embeds in a short-lived GPU
process (batch 4, about 3 GB VRAM while it runs; skipped in favour of the CPU
while the daemon holds the GPU). Without it, or when CUDA fails, the CPU models
answer and every result says so. `AMUX_SEARCH_GPU=0` turns the GPU off.
ONNX Runtime 1.24.3's CUDA provider aborts in its own exit-time destructors
(reproducible with raw onnxruntime-node and a released session), so a process
that used CUDA ends with SIGKILL after its work is written; the driver frees
its VRAM, and the reindex parent trusts the child's result file.
Relative time in a question ("i går", "i förmiddags", "i natt", "förra
veckan", "yesterday") is removed from matching and ranks that day's notes
first. File-level word-AND runs only for `--raw` or when fewer than three items
rank.

The models and index stay loaded in a per-user background process
(`bin/search-embedder.mjs`, Unix socket under `~/.agentmux/`) that starts on
the first question and exits after 30 idle minutes
(`AMUX_EMBEDDER_IDLE_MIN`). Until it is warm, that one question is answered
lexically and the output says so; a reranker that is still loading or failed
is reported the same way. While running, it re-embeds notes edited since the
nightly index in the background (at most 4 000 new units per 30 s scan),
reusing vectors of unchanged units, so today's note is searchable before the
next reindex. Models are cached in `~/.cache/agentmux/models`, outside the
install. `--reindex` (also run nightly) re-embeds only units whose text
changed, at most `AMUX_REINDEX_MAX_UNITS` (25 000 on the CPU, 200 000 on the
GPU) per run; a larger backlog continues on the next run and the output notes
the incomplete index. A full rebuild of about 39 000 units takes about six
minutes on an RTX 3090.
Reindexing is never an implicit side effect of a query.

`--deep` adds the much larger raw session archives. Result state is isolated per
terminal or tmux pane, so one agent cannot replace another agent's `--show N`
list. `--eval FILE` scores a private golden set (hit@1, hit@3, MRR, latency per
question kind); `#` lines in the set carry its provenance and labelling rules.
`--profile` adds per-stage median and p95 (BM25, dense query, rerank
tokenization and GPU pass, and more) and pool recall: how many answers
reached the reranker, and for each top-3 miss whether it was lost in the
first stage or in the rerank.

## Native cutover

```bash
amux cutover --all --runtime http://127.0.0.1:8813 --manage-services --drop-shells --allow-empty
amux cutover --all --runtime http://127.0.0.1:8813 --manage-services --drop-shells --allow-empty --apply
amux services status
amux cutover --rollback ~/.agentmux/native-cutovers/<receipt>.json
```

The first command is always read-only. `--apply` proceeds only after every
pane has two idle proofs and an empty durable lane. Existing engine sessions
must be imported exactly; `--allow-empty` permits a fresh session only where
both the session identity and persisted turn history are absent. See [the
full cutover and rollback contract](native-cutover.md).

## Sending Work

```bash
amux <agent> "prompt"
amux <agent> -p <pane> "prompt"
amux wait <agent> -p <pane>
```

Example:

```bash
amux api -p 1 "run backend tests and summarize failures"
amux wait api -p 1
amux log api -p 1
```

When `amux` is called from inside a tmux session, the receiver pane gets a
small provenance header showing which pane sent the brief.

## Reading Logs

```bash
amux log <agent>
amux log <agent> -p <pane>
amux log <agent> -p <pane> -n 10
amux log <agent> -p <pane> --since 30min
amux log <agent> -p <pane> --grep "deploy"
amux log <agent> -p <pane> --tmux
amux log <agent> -p <pane> --full
```

`amux log` defaults to structured jsonl history. Use `--tmux` only when you
need live terminal state, copy-mode output, progress bars, or modal prompts.

| Flag | Behavior |
|---|---|
| `-n N` | Last N structured turns, or lines with `--tmux` |
| `--since T` | Only turns at or after an ISO time or relative time such as `30min` |
| `--grep PAT` | Filter structured turns by case-insensitive regex |
| `--tmux` | Raw tmux capture |
| `--full` | Structured history plus current tmux state |
| `--text` | Legacy filtered text extraction |

## Timeline

```bash
amux timeline
amux timeline -n 100
amux timeline --since 30min
amux timeline --agent claw
amux timeline --agent claw --pane 2
amux timeline --grep "commit"
amux timeline --follow
amux timeline --since 2h --by-pane
```

`amux watch` is a shortcut for `amux timeline --follow`.

Use `--by-pane` when you want a post-mortem grouped by pane. Use plain
`timeline` when chronological order matters more.

## Ask History

`amux asks` answers "what did I ask, where did I ask it, and is it still
open?" Its default view is grouped by agent and shows the latest shortened
asks and replies across recently used panes, plus honest unresolved/unverified
counts. It first covers distinct panes, then fills remaining slots with the
next newest asks. This is the fast orientation layer; no model summarizes it.

Delivery and pane hooks first append the exact UTF-8 prompt to
`~/.agentmux/ask-ledger.jsonl`; provider session history is then joined only
to enrich that durable identity with reply/status and line anchors. If a
provider session was cleared, respawned, rotated, or reaped before completion
was observed, the ask remains visible as `unverified` and is included by
`--open`; absence of history never pretends that work was completed.

The first invocation after upgrading imports pre-ledger prompts from the
existing durable delivery queue, writes a versioned migration marker, and
prints the measured one-time cost. Later invocations read only the ask ledger.
Human/operator asks are the default view. Use `--all-sources` when auditing
inter-agent and automation directives too.

Whenever the live-history join proves an ask `done` or `answered`, that
terminal receipt and its short reply evidence are appended to the ledger
before rendering. Later compaction, respawn, and janitor passes therefore
cannot turn known-complete work back into `unverified`. Pre-ledger sessions
whose reply bytes were already trimmed remain honestly `unverified`; the
migration never fabricates completion.

```bash
amux asks
amux asks --open
amux asks claw --per-agent 5
amux asks --list --since 2h
amux asks --open --all-sources
amux asks --since 2h
amux asks claw --pane 3
amux asks --grep "bridge"
amux asks --full --since 30d
amux asks --all-repos --summary --since 30d
```

The deterministic preview strips transport wrappers and private attachment
paths, represents attachments as counts, and retains both the beginning and
end of long asks. `--list` exposes the flat exact-ledger drill-down; `--full`
also resolves full provider history and jsonl line anchors.

The ledger itself is append-only. Its renamed rotation archives and the
delivery-backfill marker are not janitor inputs. Default mode joins only a
bounded provider tail, so it is safe as an orientation command. Use `--full`
when you need exact live-history
answers or line anchors beyond that tail; it is no longer required to retain
old prompts. `--all-repos` includes removed agents and `--summary` groups the
selection by repository rather than agent/pane.

## Orchestrator Summary

`amux done` answers "what changed since I last checked?" by combining commit
history and pane state:

```bash
amux done
amux done --since 30min
amux done --since 2h
amux done --day
amux done --week
```

Output groups include:

- Commits across known repositories.
- Panes still working.
- Panes that finished.
- New waiters that likely need input.
- Idle panes.

## Recovery

```bash
amux esc <agent> -p <pane>
amux enter <agent> -p <pane>
amux clearline <agent> -p <pane>
amux keys <agent> -p <pane> Escape C-a C-k
amux wait <agent> -p <pane>
amux log <agent> -p <pane> --tmux
```

Composer control is intentionally narrow. `amux keys`, `amux enter`, and
`amux clearline` apply only to the tmux fallback backend. `amux keys` accepts
exactly `Escape`, `C-a`, `C-k`, `C-u`, and
`Enter`; arbitrary text, tmux flags, and other keys are rejected before the
pane is touched. `amux enter` submits an already visible composer.
`amux clearline` uses the fixed `Escape,C-a,C-k` recipe and never relies on
`C-u`, which does not clear the Codex composer. On tmux panes, `amux esc`
detects Codex's full-screen transcript/backtrack pager and exits it with its
internal `q` recipe in one invocation; native targets retain their existing
adapter-owned Escape path. Every tmux composer control has a durable requested/sent/failed
ledger identity and a best-effort Discord projection; composer text is never
copied into that audit record.

For Discord channels, the equivalent recovery commands are `/raw`, `/esc`,
`/dismiss`, and `//new`.

## Generated agent hints

```bash
amux hints-sync
```

Refreshes `.agents/CLAUDE.md` and `.agents/AGENTS.md` for every workspace root
in the canonical `agents.yaml`. Duplicate session roots are written once. The
generated block is replaced by content, while workspace-specific operator
rules below `<!-- amux-hints-end -->` in `CLAUDE.md` are preserved and mirrored
to `AGENTS.md`. Bridge startup runs the same sync automatically.

The CLI is a fresh process and therefore reads the current template from disk.
If a live bridge heartbeat reports an older or unknown hints version, the
command prints `bridge restart required`; otherwise that older in-memory
template could overwrite the refreshed files on a later pane spawn.

## Labels

```bash
amux label <agent> <pane> "purpose"
amux label <agent> <pane> --clear
amux labels
```

Labels make `amux ps` and `amux top` easier to scan when several panes are
working at once.

## Lint

```bash
amux lint
amux lint ~/lsrc/skydive-altimeter
amux lint ai
amux lint --all-agents
amux lint --changed --strict
```

`amux lint` scans the current repo by default. A target can be a file, a
directory, or an agent name from the agentmux config. The first default check
enforces short `WHAT:/WHY:` contracts, `DTO:` for pure transport shapes, and
explicit `REMOVE:/MERGE:/REFACTOR:/DEPRECATED:` debt tags for symbols that
should not get a fake `WHY:` yet.
With `--strict`, active errors and debt fail the command; style warnings are
reported without failing.
See `docs/contract-lint.md` for the writing rules.

## Churn visibility

```bash
amux churn
amux churn ~/lsrc/agentmux
amux churn --days 30 --young-days 14 --limit 8
```

`amux churn` reads git history without writing files or configuration. It shows
tests and test files removed or rewritten within their first 14 days, plus
source and test files touched by at least three commits in the selected window.
Every finding says `worth a look`: churn may be intentional, so the command is
WARN-only, always exits zero for findings, and is never a PR gate. Invalid
arguments or a non-git path still fail loudly as command errors.

## Worktree dependencies and gates

```bash
amux worktree-deps [path]
amux worktree-deps [path] --check
amux worktree-deps [path] --dry
amux gate --scoped [path]
amux gate --scoped [path] -- command arg...
amux proof --config proof.json --output attestation.json
```

`worktree-deps` scans tracked lockfiles, including nested UI package roots.
Relocatable npm installs use a content-addressed cache under the primary
repository root and outside `.git`; each worktree materializes an
`immutable-copy` locally with copy-on-write where supported and a safe copy
fallback. Dependency realpaths therefore remain inside the consuming worktree.
The cache key includes the exact manifest, lock, repository `.npmrc`, npm
version and runtime ABI. Workspace/file-linked npm trees stay local. Python
virtualenvs are never shared: the command replaces an unsafe `.venv` symlink
with a local `uv sync --locked` environment.

`--check` is mutation-free and exits non-zero for a missing, stale, or unsafe
root. `--dry` prints the provisioning plan. The standalone
`node bin/worktree-deps.mjs` entry point uses only Node built-ins, so it works in
the exact fresh-worktree state where the normal CLI's dependencies are absent.

`gate --scoped` performs the bootstrap, then runs the repo's full gate. It
prints `Skipped: none` on a complete run or names every root it could not
provision. Skips are never green. The gate also exports `UV_LOCKED=1` and hashes
all tracked npm/uv locks before and after execution, preventing an otherwise
green test command from dirtying the worktree's dependency contract.

`proof` takes an argv-only JSON recipe. It creates clean detached base/head
worktrees, asserts a named fixture anchor before applying the test-only patch,
rejects a no-op, runs the same real gate exactly once red and once green, and
requires the green gate to write a numeric margin to
`$AMUX_MEASUREMENT_OUTPUT`. Shell and source-grep commands are rejected. The
canonical output is bound to the ticket, assignment generation, commits,
fixture hash, gate output hashes and positive margin; it is the
`measurementBoundary` value accepted by Suggestions completion policy v2.
The gate must write exactly `metric`, `unit`, `operator`, `limit`, and
`observed` to the path in `$AMUX_MEASUREMENT_OUTPUT`; agentmux computes and
requires a strictly positive margin. `prepare` is optional and runs once per
detached worktree before either measured gate.

```json
{
  "schemaVersion": 1,
  "ticketId": "SRC-0092",
  "assignmentGeneration": 1,
  "repository": ".",
  "baseRef": "origin/main",
  "headRef": "HEAD",
  "fixturePatch": "./tmp/src-0092-red-first.patch",
  "anchor": {
    "path": "tests/assignment-watchdog.test.ts",
    "contains": "protocol 1.1 assignment roots"
  },
  "prepare": {
    "argv": ["node", "/opt/agentmux/bin/worktree-deps.mjs", "."],
    "cwd": "."
  },
  "gate": {
    "argv": ["npm", "run", "test:measurement"],
    "cwd": "."
  }
}
```
