# amux lint

`amux lint` runs repo checks that keep coding agents from adding vague
architecture comments. The first default check is the contract check:
important symbols need short `WHAT:` and `WHY:` contracts, or `DTO:` for pure
transport shapes.

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
