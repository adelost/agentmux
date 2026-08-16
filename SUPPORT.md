# Support

Agentmux core supports a local installation with Node.js 20+, tmux 3.2+, and
at least one of Claude Code, Codex CLI, or Kimi Code. Discord, a Suggestions
board, OpenClaw, Agentmux Link, and every `v1d.io` service are optional.

Before opening an issue, run:

```bash
amux doctor
npm list --global agentmux --depth=0
node --version
tmux -V
```

Include the operating system, installation method, the smallest reproduction,
and sanitized output from those commands. Never post `.env`, bearer tokens,
session files, private conversation logs, or `~/.agentmux/secrets/`.

The maintainers can support the public core contract and the documented
self-hosting seams. They cannot provide access to a maintainer's private V1D
services, Cloudflare resources, Discord server, fleet configuration, or
credentials. Deployment-specific apps bundled in the source monorepo are not
part of the installed npm core unless their own setup is explicitly followed.

For suspected security vulnerabilities, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.
