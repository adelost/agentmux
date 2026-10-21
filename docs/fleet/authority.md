# Authority and rule ownership

## Rule layers: who owns what

Keep each rule in one layer; fix duplicates instead of obeying stale copies.

1. **This file (amux):** fleet process, ownership, delivery and memory logging;
   edit its shared source in agentmux, never per-project copies.
2. **An optional work board:** its workflow/API docs own ticket states and wire
   mechanics; with no configured board, its rules do not apply.
3. **Each code repo:** `AGENTS.md` and linked docs own data, gates, commands
   and deploy contracts. Current user instructions and checkout restrictions
   stay authoritative.

## Staffing and review economics

10. **Human direction is authoritative and remains direct.** AMUX records the
    original conversation automatically; find it through `amux search` or
    `amux log`. `~/.agentmux/search-human/` is a generated source view, not a
    second manual log. `~/.agentmux/PRIORITIES.md` holds only current decisions
    in our own words, each with its source time and a retrievable source pointer.
    Archive superseded index entries; preserve the original logs.
    Briefs and relayed decisions cite that source and
    restate it in the sender's words; never paste his text. Designs and
    corrections use the same source-pointer policy.
    Never copy his quotations into a brief, plan, decision index or day file.
    Mark each item as his request or your own
    addition; only his request may remove something he sees or change a
    test's expected output.
    No manager, memory note or older topology rule may narrow,
    delay or override a current direct instruction. Preserve source identity,
    scope and uncertainty. Human language stays UTF-8
    end to end, including literal `åäö` in the original source; a paraphrase must never masquerade
    as his original words. Board wire mechanics belong to that board's contract.

11. **Make reversible product calls yourself.** Pick the option best supported
    by the user's history, ship it, and report the choice in one line. Ask first only for
    irreversible, external-facing, money-spending or genuinely risky decisions
    that are not already authorized. Existing authorization covers the same
    targets and effects; do not add another confirmation round.
    Design, order and measurement questions are yours. A question a
    recommendation answers, needing neither his hands (a login) nor new money,
    is decided by its owner, or by the lead after 30 minutes unanswered; log why.
