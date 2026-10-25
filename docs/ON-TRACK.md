# Source-bound on-track reviews

Source: Mattias's 25 October 2026 request at 10:34:08Z, ask
`delivery:6ec7081b7e35e50004e918bddd042d55`, and lsrc:0's protocol at
`~/.claude/on-track-protocol.md` (workspace commit `2eb445d6`).

AMUX owns an hourly schedule for each registered project and one named reviewer.
The existing bridge heartbeat advances these schedules. There is no agent-owned
reminder, additional polling process, self-rating or release gate.

## Registration

`amux on-track configure /absolute/projects.json` validates an array like:

```json
[{"id":"cutkit","root":"/home/adelost/lsrc/cutkit","ref":"origin/master",
  "ledger":"docs/TASKS.md","reviewer":"lsrc:3","dispatcher":"lsrc:0",
  "askAgents":["lsrc","skyvw"],"livePaths":["open-film","play","export-test-project","speak"],
  "probes":{}}]
```

Only registered projects run. The same data contract supports other projects.
Their existing owner must name the reviewer, routing agents and main live paths.
Set `enabled:false` when preparing a handover. Activation uses the same validated
configuration with `enabled:true`, after the prior review schedule's terminal
handoff. An unrelated billing or dispatcher wake may remain active.
After lsrc:0's25Oct C1 correction, only original human Discord/voice orders count.
Provider hooks, engine mirrors, cron, peer relays and machine notices do not.
Declared project panels, project terms or actual repository bindings select the
project. Another project's binding stays with its own reviewer. Cutkit's terms
include cut, Cutkit, export, Bumbi and the Modal wrapper. Exact routing data is
visible in registration; general-dispatch messages need project text or binding.
Ask identity reuses the canonical source reader and preserves original aliases.
No second task database is introduced.

Source classification is shared with normal `amux asks`. Claude scheduled inputs
are classified from their native journal metadata and exact event identity.
Existing external automation can register its reserved queue idempotency prefix,
producer script, verified SHA-256 and authority pointer with
`amux on-track register-producers FILE`. The actual queue job must match. Neither
the prompt's words nor a guessed name make an order disappear. Changed/missing
producer code loses the registration's evidential force. Non-original observations
remain inspectable with `asks --all-sources`; they do not become C1 orders.

Native lookup reads bounded journal tails and retains only matching user events.
An unavailable older native event remains unknown. Proven provider/backfill and
delivery aliases retain every original ID and existing bindings. `asks --list`
prints source aliases; the frozen cycle retains both excluded automation evidence
and unresolved original identities. Raw ledgers are never rewritten.

Configuration lives in `~/.agentmux/on-track/projects.json`; atomic review state,
original submissions, command captures and transport receipts live beside it in
`state.json`. These records can contain private task evidence and are not public.

## Fixed checklist and receipt

Every reminder contains C1–C5. C1 maps every frozen ask-ID to the actual TASKS
Done-when, owner and estimate. C2 reads the preceding 24h of TASKS Git history,
including changes later reverted, and requires a human source for changed
outcomes. A missing baseline or ambiguous historical table is UNKNOWN; the
original SHA and read error remain in the cycle. C3 reads every open row and the latest
posted owner log. C4 requires fresh green source evidence for every main live
path. C5 retains prior deviations until resolved with evidence or owned.

`amux on-track show cutkit` returns the frozen cycle, original asks, Git identities,
previous deviations, deadline, submitted JSON and validation. Submission is:

```text
amux on-track submit cutkit /absolute/review.json
```

The caller must be the configured reviewer. JSON follows the protocol envelope:

```json
{"project":"cutkit","cycle":"FROM-SHOW","at":"ISO UTC",
 "checks":[{"id":"C1","result":"PASS","evidence":[]}],
 "deviations":[{"check":"C4","row":"export","owner":"lsrc:3",
   "action":"Obtain a current existing export receipt","impact":"unknown"}],
 "asks":[],"rows":[],"live":[],"outcomeChanges":[],"resolved":[]}
```

All five checks are required exactly once. `amux on-track --help` gives the full
field shapes. FAIL and UNKNOWN require an owner and action. Missing evidence is
invalid; it never becomes PASS. TASKS quotations name a full Git SHA, relative
file, exact line number, exact quote and observation time. AMUX reopens Git itself.
Mappings use the cycle's frozen TASKS SHA. History evidence can use the recorded
history SHAs. A newly created receipt cannot refresh an old live observation.

`amux on-track capture cutkit PROBE` runs only an explicitly registered command
array, without shell interpretation, and retains its actual exit code and stdout
hash. Nothing submitted in a receipt is executed. Configuration must only register
already authorised, bounded, read-only probes. There are no default paid probes.
Use `capture-owner cutkit lsrc:4` for the fixed read-only canonical owner-log
reader. Its command result names the actual latest posted response, not a claimed
working duration. Git wall time is never treated as active model work.
Role annotations in a TASKS owner cell retain the single pane identity; multiple
different pane identities remain ambiguous. An explicit human owner is preserved
and receives actionable deviations through the existing human notifier. A verified
human-decision stop does not require pretending the human has an agent log.

For machine-verifiable C4, a captured native receipt or immutable JSON file must
contain `live:[{path,result,at}]`. The path IDs match the registration; the source
observation must be green and no more than 60 minutes old. A project with another
native receipt shape needs a small read-only adapter in its own registered probe;
until then it reports UNKNOWN. Copying a timestamp into the review is insufficient.
This does not authorise a new paid journey every hour.

Every frozen original ask-ID has exactly one disposition: `row` with TASKS ID,
`answered` for a question without a requested outcome and a link to its actual
frozen canonical reply, or `missing` with `row:null` and an owned FAIL. C1 UNKNOWN
requires a source read failure recorded by AMUX. An unmapped readable order is
not UNKNOWN. The first broader review remains historical and is not rewritten.

## Validation, sampling and escalation

AMUX validates every source, timestamp, ask mapping, open-row coverage and prior
deviation. It selects one PASS using system randomness and independently reopens
its sources and reruns its contract checks. Disagreement invalidates the entire
receipt. If there is no PASS, no sample is invented.

This verifies source integrity and mechanical contracts. Natural-language outcome
equivalence and whether a log describes meaningful progress still require the
reviewer's judgment. A process sharing the same OS user can edit local files;
these receipts do not claim protection against a malicious account owner.

At 20 minutes, absent/invalid receipts escalate to the dispatcher and reviewer.
Invalid submissions escalate immediately. Valid deviations go to their named
owners with actions. User/money impact, or an explicitly red live path, also
notifies the human immediately. Otherwise there are no all-green messages; one
short daily summary goes to the existing human notification channel.

Each accepted/invalid validation also records the installed validator manifest.
Each send has a stable idempotency key and separate persisted transport receipt.
Queued is not delivered. An uncertain send is never blindly repeated; existing
queue evidence may resolve it. Restart retains the deadline, and missed hours are
recorded without flooding catch-up reminders. A late correction cannot erase the
original missing/invalid state.

`amux done --on-track` or `amux on-track stats` shows deviations/24h, measured
ask-to-row Git creation latency, and documented waiting without a real stop. Existing
binding latency is retained separately and never substituted for row creation. Missing
timing remains null/unknown. The latter is wall time in a documented wait, never
active work time.
