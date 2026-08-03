# This checkout is sparse — and it lies about what exists

This working copy is a sparse checkout that includes **only root-level
files**. The Android product — Agentmux Link, a real shipped app — lives at
`android/audio-inbox` on `origin/master` but is NOT present on disk here.

Modules on origin/master that this checkout hides:

- `android/audio-inbox/app` — the phone app
- `android/audio-inbox/wear` — the Wear OS app
- `android/audio-inbox/link-core` — shared reducer/state
- `android/audio-inbox/link-transport` — shared mailbox transport
- `android/audio-inbox/link-session-android` — shared session store

**Rule (learned the hard way, skyvw:1 2026-08-02):** an existence claim —
"repo X has no app/module Y" — must be verified against the git tree, never
against this filesystem. The check is one line:

```sh
git ls-tree -r origin/master --name-only | grep -i <what-you-are-looking-for>
```

To see the Android tree in a working copy, create a worktree instead of
editing this sparse spec by hand:

```sh
git worktree add /tmp/agentmux-android origin/master
```
