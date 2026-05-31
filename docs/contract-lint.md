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

## WHAT

`WHAT:` says what the symbol does or represents locally.

Good starts:

- `Tracks`
- `Filters`
- `Builds`
- `Normalizes`
- `Stores`
- `Routes`
- `Carries`
- `Names`
- `Calculates`

Keep it short. Do not say `class`, `helper`, `object`, or `thing`.

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

The baseline suppresses known findings. New or changed findings still show up.
Debt findings can be baselined too, but that should be a temporary ratchet:
each cleanup milestone should shrink both the normal finding count and the debt
count.
