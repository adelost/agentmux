# amux lint

`amux lint` runs repo checks that keep coding agents from adding vague
architecture comments. The first default check is the contract check:
important symbols need short `WHAT:` and `WHY:` contracts, `DTO:` for pure
transport shapes, or an explicit debt tag when the symbol should not be
rescued yet.

## Commands

```bash
amux lint
amux lint .
amux lint ~/lsrc/skydive-altimeter
amux lint ai
amux lint --all-agents
amux lint --changed --strict
amux lint --baseline .amux-lint-baseline.json --strict
amux lint --update-baseline
```

Targets:

- no target: current working directory
- path: that file or directory
- agent name: the agent `dir` from `agentmux.yaml` / `agents.yaml`
- `--all-agents`: every configured agent directory

## Contract Format

Default:

```text
WHAT: <local responsibility>
WHY: <boundary, coupling, duplication, failure mode, or risk it prevents>
```

Pure transport shapes may use:

```text
DTO: <payload or schema shape>
```

Known code that does not deserve a pretend `WHY:` yet may use an action-tagged
debt state:

```text
REMOVE: <why this has no future + evidence>
REFACTOR: <wrong boundary + target direction>
MERGE: <duplicate overlap + canonical home>
DEPRECATED: <replacement + compatibility reason>
DEBT: <remove/refactor/merge/deprecate ...>
```

`WHAT:` is explicit on purpose. It is the same kind of forced structure as
Given/When/Then in tests: the tag reminds agents to fill the contract, not
write prose.

A symbol must choose exactly one state:

1. `WHAT:/WHY:` for code that should stay and has a real boundary.
2. `DTO:` for a pure transport/schema/data shape.
3. One debt action (`REMOVE:`, `MERGE:`, `REFACTOR:`, `DEPRECATED:`) for code
   that should not be rescued yet.
4. Deleted.

Do not combine states. `DTO:` plus `WHAT:/WHY:` is ambiguous; use `DTO:` only
for pure shapes, otherwise write `WHAT:/WHY:`. Debt tags are also exclusive:
do not add `REFACTOR:` next to `WHAT:/WHY:` or stack `REMOVE:` with `MERGE:`.

## WHAT

`WHAT:` says what the symbol does or represents locally.

Good starts:

- `Tracks`
- `Builds`
- `Carries`
- `Calculates`
- `Dispatches`
- `Fetches`
- `Filters`
- `Indexes`
- `Normalizes`
- `Parses`
- `Routes`
- `Schedules`
- `Stores`

Keep it short. Do not say `class`, `helper`, `object`, or `thing`.

`WHAT:` should start with an approved active verb. Unknown verbs are warnings,
not hard failures: a repo-domain verb such as `Stitches` or `Embeds` may be
valid, but the warning forces an explicit choice instead of drifting into
`Handles`/`Manages`/`Does`.

To approve a recurring domain verb for one repo, add `.amux-lint.yml` at the repo
root:

```yaml
contract:
  allowedWhatVerbs:
    - Stitches
    - Embeds
    - Quantizes
```

Add a verb when it is a real repeated domain action. Rewrite the contract when
the verb is just vague (`Handles`, `Manages`, `Does`, `Supports`).

## WHY

`WHY:` says what boundary or failure mode the symbol protects outside itself.
It must not restate `WHAT:`.

Preferred shapes:

- `Keeps X from Y`
- `Separates X from Y`
- `Prevents X when Y`
- `Avoids X across Y`
- `Keeps X independent from Y`
- `Lets X share Y`

Good:

```python
class SimpleTracker:
    """WHAT: Assigns stable IDs to boxes with greedy IoU matching.

    WHY: Keeps fallback video workers stable when a backend lacks instance IDs.
    """
```

Bad:

```python
class SimpleTracker:
    """WHAT: Assigns stable IDs to boxes.

    WHY: Assigns IDs when boxes need tracking.
    """
```

## DTO

`DTO:` is only for pure transport shapes:

- API request/response
- wire payload
- DB row
- generated schema
- field-only config/payload

Allowed:

```python
class Point(BaseModel):
    """DTO: Pixel coordinate in segmentation request payloads."""
```

Do not use `DTO:` for domain state, settings, runtime state, stores, tracks,
engines, policies, repositories, or calculators. Those need `WHAT:/WHY:`.
Do not write both `DTO:` and `WHAT:/WHY:` on the same symbol; choose the
stronger state.

Good domain data:

```kotlin
/**
 * WHAT: Carries live altitude, pressure, vertical-speed, and sensor-health values.
 * WHY: Separates safety math from display smoothing and diagnostics.
 */
data class AltimeterState(...)
```

Good sealed state:

```kotlin
/**
 * WHAT: Names the self-update workflow states shown in settings.
 * WHY: Keeps checking, downloading, install-ready, and failure UI mutually exclusive.
 */
sealed class UpdateState
```

## Debt Tags

Debt tags are for honesty, not cleanup theatre. Use them when the symbol has no
clear contract yet and forcing a `WHY:` would create authoritative-looking
fiction.

Allowed actions:

- `REMOVE:` — unused or obsolete code with no valid future.
- `REFACTOR:` — useful behavior, wrong boundary or ownership.
- `MERGE:` — duplicate/overlapping shape; name the canonical home.
- `DEPRECATED:` — public or external API kept temporarily for compatibility.
- `DEBT:` — allowed only when the value starts with the action
  (`Refactor ...`, `Remove ...`, `Merge ...`, `Deprecate ...`). Prefer the
  action tag directly.

Good:

```python
class LegacySam2Path:
    """REMOVE: Unused legacy SAM2 path; no registered caller after SAM3 migration."""

class SearchHit:
    """MERGE: Duplicate result shape; canonical type should live in video/types.py."""

class SearchState:
    """REFACTOR: Move into VideoIndex; duplicate search state makes ownership unclear."""
```

Debt is still a finding. `amux lint` prints it in a `Debt:` section, and
`--strict` fails on new debt unless it is intentionally baselined. That keeps
old debt visible without letting new "temporary" debt arrive silently.

Use only one debt action per symbol. If code is both duplicate and wrong-shape,
choose the next action that should happen first (`MERGE:` or `REFACTOR:`) and
explain the rest in that one line.

Do not use generic tags such as `FLAG:`. A symbol must be one of these states:

1. `WHAT:/WHY:` — keep it; boundary is understood.
2. `DTO:` — pure transport/schema/data shape.
3. `REMOVE:/MERGE:/REFACTOR:/DEPRECATED:` — known debt with next action.
4. Deleted.

## Banned Phrases

The linter rejects AI-ish meta narration:

- `It exists as`
- `It exists to`
- `This class`
- `This helper`
- `Helper for`
- `Used to`
- `Provides a way to`
- `truthful`
- `simple`
- `clean`
- `nice`
- `proper`
- `lightweight fallback`

Prefer exact boundaries:

```text
WHY: Keeps FastAPI routes from embedding Modal dispatch details.
WHY: Prevents green warmups from targeting containers that never handle the request.
WHY: Keeps source matching independent from deployment path shapes.
```

## Examples

Kotlin:

```kotlin
/**
 * WHAT: Filters compass and rotation-vector samples into a stable heading.
 * WHY: Keeps map rotation and compass UI from depending on raw sensor quirks.
 */
class CompassEngine
```

Python:

```python
class OperationSpec:
    """WHAT: Describes the pool function, request model, and handler for one operation.

    WHY: Keeps FastAPI routes from embedding Modal dispatch details.
    """
```

JavaScript:

```js
/**
 * WHAT: Expands one media identifier into comparable local, Modal, and URL aliases.
 * WHY: Keeps source matching independent from deployment path shapes.
 */
export function mediaPathAliases(value) {}
```

## Baseline

Legacy code should not block all work. Use a baseline, then ratchet:

```bash
amux lint --update-baseline
amux lint --baseline .amux-lint-baseline.json --changed --strict
```

`--strict` exits non-zero for active errors and debt. Warnings are printed but do
not fail strict mode; they are guidance for style and local grammar.

The baseline suppresses known findings. New or changed findings still show up.
Debt findings can be baselined too, but that should be a temporary ratchet:
each cleanup milestone should shrink both the normal finding count and the debt
count.

## Changed-file PR ratchet

`--changed` compares the branch, staged changes, unstaged changes, and untracked
source files with trunk. It does not compare only the clean CI worktree with
`HEAD`; that would scan zero files after checkout. CI passes the exact pull
request or merge-queue base SHA through `AMUX_LINT_BASE_REF` and fails loudly if
that revision is unavailable.

The PR gate is therefore:

```bash
amux lint --changed --strict
```

Only changed source files need to be clean. Untouched legacy findings do not
block unrelated work.

## User-text punctuation

Source string literals reject two recurring prose defects:

- `STYLE001`: an em dash in user-facing text
- `STYLE002`: a single spaced hyphen used between prose on both sides

Comments are excluded, and command syntax such as `git -C` is not classified as
prose punctuation. Use a comma, colon, semicolon, or period instead.

## File-size ratchet

New source files have a 500-line cap. A legacy file already above 500 lines may
be recorded at its exact current size:

```yaml
fileSize:
  caps:
    worker/board.ts: 7421
```

The recorded cap is not a growth allowance. The linter rejects a cap above the
file's current line count and compares the configuration with trunk; an existing
cap may only decrease. When code moves out of a legacy file, lower its cap in
the same change. Adding a new exception above the 500-line default after initial
adoption is a cap increase and fails the gate.
