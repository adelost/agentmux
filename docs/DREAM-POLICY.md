# Dream activity policy

`amux dream` is one bounded, stateless nightly summarizer. It reads durable
session journals and never sends to, resumes, compacts, sleeps or wakes a coding
pane. Auto-compact and sleep remain independent controllers.

## Exact algorithm

1. Inspect configured Claude, Codex and Kimi panes through their journal
   readers. Pane liveness, tmux screen text and current context percentage are
   not inputs.
2. Inspect at most the latest 24 hours by default and only turns newer than the
   pane's last successful Dream receipt. Dream prompts, `/compact`, recovery
   plumbing and canonical system noise are not work.
3. For Claude, read a bounded tail from up to six recently active session
   files. This preserves work on both sides of a compact rotation without ever
   parsing an unbounded historical session.
4. Keep at most eight recent real turns and 5 KiB of source per pane. Sort panes
   by latest activity, include at most 48, and cap the complete prompt at 96
   KiB. Every omitted or unreadable pane is reported with an exact reason.
5. Invoke one no-tools, no-session-persistence summarizer process. Source text
   is explicitly untrusted data. Validate the response at 12 KiB and 60
   non-empty lines before it can enter memory.
6. The controller, not the model, atomically writes one marked fleet-summary
   block in the daily memory file.
7. Atomically advance receipts only for panes actually included, and only after
   the validated memory block is durable. Model, validation or write failure
   advances no receipt; fixed-limit omissions retain their old receipts.

`amux dream --dry` executes collection and budgeting, but invokes no model and
writes nothing. With no new real work Dream writes only its run sentinel and
does not invoke a model.

## Separate controllers

- `amux memory compact` still compacts daily memory according to its own policy.
- Pane auto-compact still responds to context pressure independently of Dream.
- Sleep may consume durable evidence, but must independently prove idle, empty
  delivery queue and safe worktree state. It never wakes a pane merely to sleep
  it, and suspected stalls are reported rather than killed.

## Rejected alternatives

- Waking every pane makes nightly bookkeeping consume each pane's context and
  turns inactive runtimes into unnecessary failure points.
- Context-percentage eligibility loses heavily used work after a prior compact.
- Reading only Claude's newest JSONL loses work when compact rotates the file.
- A permanent summarizer pane accumulates its own context. A fresh one-shot gets
  the same bounded cross-fleet view every night.
- Silent truncation creates a false receipt. Omitted material is explicit and
  never receipted.
