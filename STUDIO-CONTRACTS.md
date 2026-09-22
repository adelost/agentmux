# ProductSpec service contracts

Ten Android Link service types now have adjacent WHAT/WHY comments. Instances do not duplicate them. The root Studio manifest selects the existing AMUX policy and Android Link graph; it does not turn the bridge into a second runtime.

The manual check reuses `core/contract-lint.mjs` for wording and the companion CircleKit Studio scanner for service discovery:

```bash
node tools/product-contracts.mjs . --studio-root /path/to/circlekit/product-studio --pretty
```

Use Node 22+ and installed Studio dependencies for this tool. AMUX bridge requirements, startup, current lint behavior, release rules and dependency pins are unchanged. Errors or wording warnings fail this manual command. The new Vitest test file is authored but was not executed here.

Open from the companion Studio branch:

```bash
node /path/to/circlekit/product-studio/bin/studio.mjs serve /path/to/agentmux
```

Write WHAT as responsibility and WHY as the boundary or failure mode. Do not copy port lists or use filler to satisfy the checker. Scanner presence is not proof the prose is true. Unsupported factories and external service types remain visible gaps.

The optional report path is `test-results/bdd-run.json`. Current runner/configuration may not emit `bdd.run.v1`; setting an environment variable alone does not install its reporter. Keep test execution/configuration separate. Studio reports statuses and revision correlation, never automatic service coverage.

Decision rationale and negative tests: `circlekit/product-studio/LIVING-DOCUMENTATION.md`. No app/test execution, model call, restart, package publication or merge was performed in this change.
