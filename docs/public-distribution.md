# Public distribution contract

Agentmux core is a local, fully autonomous coordinator for coding-agent CLIs.
Full-autonomy flags are an intentional product choice; this work does not
replace them with approval prompts or a sandbox.

## Core must stand alone

A fresh installation may require Node.js, tmux and at least one supported
coding engine. Discord is optional. It must not require OpenClaw, a V1D domain,
the author's home-directory layout, a private task board, or Agentmux Link.

Core defaults belong under `~/.agentmux` and the standalone tmux socket is
`/tmp/agentmux-tmux.sock`. OpenClaw paths remain supported only when the
operator explicitly supplies `OPENCLAW_WORKSPACE` or related compatibility
configuration.

## Optional integrations

Suggestions-compatible boards are enabled only by an explicit
`SUGGEST_BASE_URL` or a `baseUrl` in that integration's YAML. Any HTTPS origin
is valid. With no configured origin, no board request is made and the bundled
mutation guard is inert.

Agentmux Link (`link/` and `android/audio-inbox/`) is a separately deployed
first-party application. It is source-visible in the monorepo but excluded
from the installed Agentmux core package. Its mailbox, authentication, storage
and release host are deployment concerns, not core defaults.
Historical Link QA evidence and tests may name the maintainer's deployment;
that evidence is not a service dependency or a default offered to public users.

## Operator-owned policy

Generated `CLAUDE.md` and `AGENTS.md` contain product-level coordination rules,
never a named person's identity or an assumption that a work board exists.
Workspace-specific rules remain below the generated marker and survive sync.

## Release gate

The public-distribution test rejects private service hosts, author-specific
paths/names and legacy OpenClaw socket defaults in production core files. A
clean-home smoke must prove setup/config generation without using the author's
real home directory or credentials.

## Support boundary

The supported public surface is the standalone core plus documented,
explicitly configured integration seams. See [`SUPPORT.md`](../SUPPORT.md) for
the diagnostic bundle and [`SECURITY.md`](../SECURITY.md) for private reports.
