# Security policy

Do not include vulnerability details, secrets, or private transcripts in a
public issue. Private vulnerability reporting is not currently enabled for the
repository; open a detail-free issue asking the maintainer to establish a
private reporting channel before sending technical evidence.

Agentmux intentionally launches configured coding engines in their full-
autonomy modes. This is not a hidden escalation: each engine runs with the
permissions of the local user who started Agentmux. Protect that user account,
review project-specific instructions, and keep `~/.agentmux` private.

The public core must not require or silently contact a V1D service. Optional
network integrations require an explicit HTTPS origin (or loopback HTTP for a
same-machine service) and their own revocable credentials. A report that shows core contacting an unconfigured external
origin, leaking credentials, or crossing one configured project boundary is a
security issue.
