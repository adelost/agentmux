# Link on CircleKit 0.3.82: round back layer

CircleKit 0.3.82 moves the round back to a fixed escape at 12 o'clock and
derives smaller row text (docs/decisions/2026-09-14-round-menu-back-layer.md in
adelost/circlekit, PR #184). This branch consumes it and moves the watch turn
reader's top inset below that escape.

Captured from this branch's debug build in phone WATCH EXACT on phone34play
(API 34), using `qa_state=active` demo data, at 192 and 360 dp faces:

- `settings-*-top`, `settings-*-scroll60`, `settings-*-scroll120`: the round
  Settings list at rest and after two 60 dp slow drags.
- `devhost-*`: the DISPLAY PREVIEW route, which had no round back before.
- `devhost-preview-*`: the shared CircleKit DEV HOST screen pushed from it.
- `turn-*-top`, `turn-*-scroll60`: REPLY opens the watch turn reader; its text
  starts below the escape and is clipped there while scrolling.

The debug APK was installed as `io.agentmux.audioinbox.menuqa` through a
local Gradle init script. This left the existing release installs and their
data untouched. It is not a product change.
