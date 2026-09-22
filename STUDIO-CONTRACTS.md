# Product Studio from AMUX

Use sibling checkouts of the matching CircleKit evidence branch and this AMUX branch.

```bash
(cd ../circlekit/product-studio && npm ci)
npm ci

node studio.mjs check
node studio.mjs laws --product amux-link --kernel-root android/audio-inbox/product-spec --output test-results/link-laws.json
node scripts/verify-studio.mjs
node studio.mjs
```

For non-sibling layouts set `STUDIO_ROOT` to `circlekit/product-studio`. AMUX is itself the wording-grammar owner, so `AMUX_ROOT` normally resolves to this checkout.

## Service intent

The source check covers the **11 Link ProductSpec service declarations**, including the parameterized wake-word factory. WHAT/WHY is attached to the actual `service()` source call. A computed concrete ID is an identity limitation, not a reason to execute the factory.

The checker still delegates wording to `core/contract-lint.mjs`. Decision tables, instances, ports and cells do not gain a second ProductSpec-specific prose obligation.

## Generated declaration laws

```bash
node studio.mjs laws   --product amux-link   --output test-results/link-laws.json
```

The report is generated from the currently loaded ProductSpec model. Link has real node types even when it has no decision-table facets, so node-type structural laws remain meaningful.

The command resolves Link's installed ProductSpec from `android/audio-inbox/product-spec`, verifies it against that package's lockfile, and requires its **0.3.64** version to match the artifact's embedded producer version. Mismatch is skipped, never silently revalidated with Studio's compiler.

## Existing Vitest runs

The viewer never starts Vitest. To collect one owner-selected run:

```bash
STUDIO_REPOSITORY=adelost/agentmux STUDIO_REPOSITORY_ROOT="$PWD" STUDIO_BDD_REPORT=test-results/bdd-run.json node node_modules/vitest/vitest.mjs run test/product-contracts.test.mjs   --reporter default   --reporter ../circlekit/product-studio/reporters/vitest.mjs
```

The custom reporter is optional. Failed/skipped/pending status is preserved. A test-body ProductSpec ID is only a source-reference association.

## Existing Kotlin/JUnit results

After a normal Android/Gradle owner has already produced JUnit XML, import it without rerunning tests:

```bash
node studio.mjs junit   --input path/to/TEST-suite.xml   --source-root android/audio-inbox/link-ui/src/test/java   --repository adelost/agentmux   --output test-results/link-junit.json
```

The workspace explicitly attaches the generated Link port-ID catalog so literal references such as `GeneratedLinkNativeLegoCatalog.PortIds.*` can be associated with exact ProductSpec IDs.

No name-to-ID guessing is allowed. Optional `@covers` and `@proof` are available only when exact source references are insufficient.

## Evidence boundary

- generated law = declaration/compiler evidence
- Vitest/JUnit = producer-reported test evidence
- source-reference / `@covers` = association only
- recorded trace = observed execution evidence

None of these is promoted into another category.

Shared semantics: `../circlekit/product-studio/EVIDENCE.md`.
Living-documentation rationale: `../circlekit/product-studio/LIVING-DOCUMENTATION.md`.
