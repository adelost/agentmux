# Agentic engineering guide

This is practical design guidance for medium and large agent-owned changes. It
complements the Suggestions work loop; it is not a second assignment, review or
approval protocol.

The guidance was distilled from Dexter Horthy's discussion of program design
and context engineering in *Ex-NASA dev reveals his Agentic Engineering
Workflow* (David Ondrej, 2026-08-09), then adapted to Agentmux's owner-driven
workflow.

## Core principle

Make the expensive decisions while context is still small. Before an agent has
written hundreds of lines, decide what the user should experience, how the
system should behave, where the responsibility seams belong and how the result
will be verified from outside the implementation.

The normal shape is:

```text
user outcome -> product/UX proof -> architecture -> program design
             -> small runnable slice -> external verification -> delivery
```

The amount of ceremony is proportional to risk. A trivial reversible fix does
not need a design document. A new workflow, state transition, storage format,
security boundary or multi-surface feature does.

## Before implementation

For a medium or large change, record the following in the ticket or a linked
design file:

1. **Outcome and golden case** — the concrete user problem, one representative
   input/output or before/after example, and explicit non-goals.
2. **Product and UX proof** — the intended visible states, including loading,
   empty, error and narrow-screen behavior. Use a mockup when visual judgment is
   material.
3. **Architecture** — the data flow, ownership boundaries, persistence and
   external dependencies. State which existing seam is reused.
4. **Program design** — state transitions, call sequence, types or function
   signatures, file placement, failure behavior and race handling. Prefer
   small declarative tables or diagrams over speculative implementation code.
5. **Verification** — focused tests plus the external observation that proves
   the feature works: browser behavior, real protocol response, measured
   performance, served build SHA or another product-level signal.

These are design inputs, not mandatory human approval gates. The owner chooses
reversible defaults and escalates only a genuinely irreversible product,
security or cost decision.

## During implementation

- Deliver a narrow vertical slice that can be exercised end to end before
  expanding the feature. Re-steer when the trajectory is cheap to change.
- Keep one authoritative implementation and one declared state model. Do not
  hide workflow in conditionals spread across unrelated files.
- Test the product from outside its implementation boundary. Unit tests prove
  local contracts; they do not prove that a user can see, operate or receive
  the feature.
- Preserve the owner's understanding of the system. A green gate does not
  replace the ability to explain the data flow, state transitions and failure
  modes.
- Keep durable context in the repository: architecture decisions, external
  system shape, contracts and fixtures. Do not depend on a long chat transcript
  as the only source of truth.

## Context discipline

Good context is correct, relevant and as small as the problem permits. Prefer
deterministic file discovery and bounded summaries over copying entire chat
histories into every turn.

When an agent repeatedly applies the same failed hypothesis, loses the current
product goal or approaches context exhaustion, stop and re-anchor a clean
session from the ticket, design, current diff and observed failure. More turns
inside stale context are not progress.

## Throughput discipline

Optimize delivered user value, not agent utilization. More workers do not help
when the bottleneck is product judgment, review, merge, deployment or live
verification. It is valid for an agent to be idle while the actual bottleneck
is resolved.

Keep work in progress bounded. Finish, verify and deliver an existing slice
before opening another overlapping implementation lane.

## Delivery receipt

A useful completion receipt answers four questions:

- What changed for the user?
- What is the authoritative data/state flow now?
- What external evidence proves it works?
- Which exact commit/build is delivered, and what is the rollback path?

“Tests passed” alone is not a product receipt.
