# Subscription profiles

`amux quota` shows provider usage and reset windows for the configured profiles.
`amux accounts login claude:2` prints that isolated profile's provider login
command. Tokens stay in provider-owned files, never in memory or reports.
Profile labels are routing names, not proof of distinct subscriptions.

## Claude rotation

`amux accounts rotate claude:2 --dry` reads target access and inspects the
configured Claude panes without preparing profile links, refreshing OAuth,
compacting, starting processes or changing selected profiles. It briefly uses
the delivery lease so the view is consistent with the delivery controller.

The same command without `--dry` explicitly authorizes that target profile.
It checks the target's subscription usage endpoint (allowing the existing
same-profile OAuth renewal), then requires idle/empty-composer observations,
no pending delivery and an exact complete persisted session. Profile history
links are prepared only after preflight. Immediately before each restart it
rechecks the pane and journal fingerprint, with another check at the actual
restart boundary. No source-account compact/model turn is required: the CLI
resumes the existing transcript under the new profile. Dormant panes only get
the selection for their next ordinary wake; this command does not wake them.

Provider-disabled, inaccessible or unknown target access blocks before pane
changes. Startup/composer readiness is not proof that a subsequent model turn
will have quota. No model, effort or API-billing fallback is selected here.
An unfinished transition retains its exact session for retry; failed startup
attempts rollback to the previous profile, and partial outcomes stay explicit.

The fleet command currently targets tmux Claude. Native runtime and Codex
account switching have their own adapters; this command does not provision
native sessions or rewrite their configured identity. Repeated profile names
or equal usage numbers do not prove two different accounts.
