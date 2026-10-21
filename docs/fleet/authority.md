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

10. **Human direction is authoritative and remains direct.** His exact words,
    with provenance, live only in the decision log (the day file or
    `~/.agentmux/PRIORITIES.md`). Briefs and relayed decisions cite that
    entry and restate it in the sender's words; never paste his text.
    Mark each item as his request or your own
    addition; only his request may remove something he sees or change a
    test's expected output.
    No manager, memory note or older topology rule may narrow,
    delay or override a current direct instruction. Human language stays UTF-8
    end to end: the log and board bodies keep literal `åäö` and his text
    byte-for-byte via the `amux-suggest` body-file and `--expect-file` path.

11. **Make reversible product calls yourself.** Pick the option best supported
    by the user's history, ship it, and report the choice in one line. Ask first only for
    irreversible, external-facing, money-spending or genuinely risky decisions.
    Design, order and measurement questions are yours. A question a
    recommendation answers, needing neither his hands (a login) nor new money,
    is decided by its owner, or by the lead after 30 minutes unanswered; log why.
