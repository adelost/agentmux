# contract-lint handoff (from ai:0)

Advisory only. ai:0 built and proved the v0 validator + corpus that the current
`core/contract-lint.mjs` replaced. This file hands the proven behavior to the
implementer. ai:0 will NOT edit `core/contract-lint.mjs` or its test.

## Merge gate (do not merge until ALL green)

The current dirty version regresses. A test that already fails in the new suite:
`accepts short WHAT/WHY with a real boundary` (SimpleTracker) — because the
boundary patterns reject 3 of the 11 hand-approved gold WHYs. Gate:

- [ ] 11 gold contracts → **0 error findings** each
- [ ] 3 bad contracts → **≥1 error finding** each
- [ ] 3 false-positive regressions → **0 error findings** each
- [ ] skydive banned-phrase count stays ≈1 (was tuned 9 → 1), not back to 9

Recommended: expose a pure `evaluateContract(doc, { name }) -> findings[]` and
unit-test the corpus at that level (no temp files). It is the testable core.

## Keep from the current (newer) version — do not rip out

baseline/ratchet (`loadBaseline`/`writeBaseline`/`filterBaseline`), repo config,
generated-marker detection, `collectSourceFiles`, CLI plumbing, the
`dto-not-pure` shallow guard. The infra is better than v0. Only the validator
rules + corpus need porting back.

## Two regressions to fix

### 1. Boundary check: require a boundary VERB, not verb+preposition

The compound patterns (`/\bkeeps?\b.+\b(from|out of|independent|...)\b/`) reject
real WHYs. These hand-approved gold WHYs fail them:

- SimpleTracker: "Keeps fallback video workers stable **when** a backend lacks instance IDs"
- WarmupRule: "Prevents green warmups **from** targeting containers..." (pattern wants `prevents.+when`)
- AltitudeReferenceCalculator: "Keeps recovery math testable **across** forecast and METAR sources"

Replace with presence-of-a-boundary-verb (any one satisfies):

```
keeps separates avoids prevents isolates hides limits preserves decouples guards stops
so that · otherwise · because · instead of · without · independent · lets
```

Do NOT add bare `from` / `shared` — too broad ("Calculates X **from** Y" would falsely pass).
All 11 gold pass presence; all 3 bad still fail (they have no boundary verb at all).

### 2. Banned phrases: word-boundary + position, not bare `.includes()`

`.toLowerCase().includes(phrase)` re-introduces false positives that v0 already
tuned out (skydive 9 → 1). Split into two lists:

**ALWAYS-banned** (word-boundary regex, match anywhere):
`it exists as`, `it exists to`, `this class`, `this helper`, `helper for`,
`provides a way to`, `lightweight fallback`,
and truthful as a **predicate only**: `/\btruthful\b(?!\s+[a-z])/i`
(catches "keeps it truthful." but NOT "truthful boundary" / "truthful indicator").

**LEADING-banned** (match only at the START of the WHAT or WHY value, or an untagged doc):
`/^used to\b/`, `/^(?:is )?responsible for\b/`, `/^serves as\b/`, `/^acts as\b/`
("wall-clock **used to** compute" and "caller **is responsible for**" are legit mid-sentence.)

**Adjectives** `simple clean nice proper` → warning **only when the WHY has no boundary marker**.
Bare-banning `simple` fails Mattias's own example: "Keeps migrations **simple** and settings inspectable."
Also `.includes("simple")` matches "simpler"/"simplify" — use `\bsimple\b`.

## Classifier: author-declared DTO + shallow guard only

Do not infer `domain_state` vs `boundary` by suffix or body analysis (semantic-oracle trap).
Mattias's rule: everything without a `DTO:` tag needs WHAT/WHY. The author DECLARES `DTO:`;
the linter only shallow-guards it (no public methods beyond serialization — the current
`dto-not-pure` check is the right shape). Suffix lists like `Result/Meta/Detail/Row`
auto-classifying as DTO is too permissive (a `MatchResult` can hold logic).

## The acceptance corpus (paste into the test)

```js
// 11 GOOD — every one must yield 0 error-level findings.
const GOOD = [
  ["SimpleTracker", "Assigns stable IDs to boxes with greedy IoU matching.", "Keeps fallback video workers stable when a backend lacks instance IDs."],
  ["OperationSpec", "Describes the pool function, request model, and handler for one operation.", "Keeps FastAPI routes from embedding Modal dispatch details."],
  ["WarmupRule", "Maps one warmup request to the pool that will serve matching clicks.", "Prevents green warmups from targeting containers that never handle the request."],
  ["NoopOperationContext", "Stubs progress, cancellation, and event hooks for on-demand handlers.", "Keeps single-result pool calls independent from the streaming job runtime."],
  ["mediaPathAliases", "Expands one media identifier into comparable local, Modal, and URL aliases.", "Keeps source matching independent from deployment path shapes."],
  ["mediaPathsMatch", "Compares media identifiers after normalization and alias expansion.", "Keeps job ownership checks from duplicating path and proxy-cache rules."],
  ["CompassEngine", "Filters compass and rotation-vector samples into a stable heading.", "Keeps map rotation and compass UI from depending on raw sensor quirks."],
  ["AltimeterState", "Carries live altitude, pressure, vertical-speed, and sensor-health values.", "Separates safety math from display smoothing and diagnostics."],
  ["AltimeterEngine", "Turns barometer pressure into relative altitude and vertical speed.", "Keeps sensors, HUD, and tests on one altitude pipeline."],
  ["FlightSettingsStore", "Defines persistence for flight-planning settings.", "Keeps the calculator independent from Android storage."],
  ["AltitudeReferenceCalculator", "Calculates active and restorable altitude references from pressure history.", "Keeps recovery math testable across forecast and METAR sources."],
];

// 3 BAD — every one must yield >=1 error-level finding.
const BAD = [
  ["exists+echo", "Assigns stable IDs to boxes.", "It exists to assign stable IDs when tracking is needed."],
  ["echo restate", "Describes one operation.", "Used by operations to describe operations."],
  ["truthful filler", "Provides context to handlers.", "This keeps context truthful."],
];

// 3 FALSE-POSITIVE regressions — every one must yield 0 error-level findings.
// These are what the bare-substring bans re-broke. They must pass.
const FP_OK = [
  ["used-to mid-sentence", "Holds the wall-clock used to compute drift.", "Keeps drift math off the render path."],
  ["caller responsible-for", "Loads PMTiles for a region.", "Keeps failures explicit so the caller is responsible for translating them."],
  ["truthful as adjective", "Draws the dashed coverage ring.", "Keeps the ring from reading as a truthful boundary it cannot guarantee."],
];
```

Evidence for the corpus: run was `node bin/contract-lint.mjs ~/lsrc/skydive-altimeter/app/src/main`
→ banned-phrase findings dropped 9 → 1 after the two fixes above; the remaining 1 is a real
`"this class is the thin Android orchestration"` hit. Same runner on `~/lsrc/ai-dsl/src/ai_tools`
flags the real targets: `tracking.py:24` "It exists as the lightweight fallback" and
`ondemand.py:164` "This keeps warmup truthful".
