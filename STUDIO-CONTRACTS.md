# Product Studio: one command from this checkout

Use the matching CircleKit `feat/studio-contracts-takeover-20260922` branch.
Keep the ordinary AMUX bridge and its agents running unchanged.

```bash
# Once, in the shared Studio checkout:
(cd ../circlekit/product-studio && npm ci)
# AMUX's normal locked dependencies must already be installed.
node studio.mjs check
node studio.mjs
```

Non-sibling checkout locations: set `STUDIO_ROOT` to `circlekit/product-studio`
and `AMUX_ROOT` to this AMUX checkout. Missing packages produce an actionable
error; opening Studio never installs anything or calls a provider.

The source check validates **11 Link service declarations**, including the
parameterized wake-word factory. WHAT/WHY belongs above each actual `service()`
call. The factory's source contract is checked without inventing `${product}`.
Its concrete model identity needs the product owner's exact source map.

The checker reuses `core/contract-lint.mjs`. Existing one-line comments and
optional policy-table intent remain valid; no new service obligation is imposed
on decision tables, instances, ports or cells. `tools/product-contracts.mjs`
remains supported. No bridge startup, generic lint, release hook or dependency
pin was changed.

## Optional evidence from an ordinary selected test run

The shared reporter supports the installed Vitest 4 public reporter API and
existing bdd-vitest 2 source descriptions. It preserves failed/skipped/retried
results instead of manufacturing a current-model pass:

```bash
STUDIO_REPOSITORY=adelost/agentmux node node_modules/vitest/vitest.mjs run \
  test/product-contracts.test.mjs \
  --reporter default --reporter ../circlekit/product-studio/reporters/vitest.mjs
node studio.mjs laws --product amux-link --output test-results/link-laws.json
```

These are explicit test/check commands, never run by the viewer. Reports use
`bdd.run.v1`; unknown or dirty Git revision stays unknown. Existing Kotlin JUnit
XML can be imported with `node studio.mjs junit ...`; the shared guide documents
source roots, timezone validation and generated-ID association.

Open **More views > Intent & behavior**, or select a node. Shared library
selections are attached separately; they are not silently treated as the
currently installed package revision. Source references, optional `@covers`,
generated declaration laws and recorded traces retain distinct labels.

Design, limits and full acceptance checklist:
`../circlekit/product-studio/LIVING-DOCUMENTATION.md`.
