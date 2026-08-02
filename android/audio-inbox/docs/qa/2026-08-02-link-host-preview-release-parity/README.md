# Agentmux Link host preview and release parity

Source candidate: `feat/link-host-preview-version-parity`

## Stable checklist

- [x] `LHP-001` Phone exposes only `RESPONSIVE` and `WATCH EXACT`; Compact/Wide are derived by CircleKit from live bounds.
- [x] `LHP-002` The same Link settings route survives Responsive portrait → landscape → WatchExact without a preview renderer.
- [x] `LHP-003` WatchExact 216 and 400 use the shared `LinkWatchSurface`; 90° remains a round, single-column Watch surface.
- [x] `LHP-004` Real Wear uses the same Watch presenter and omits the meaningless DEV host selector.
- [x] `LHP-005` WatchExact persists over process restart, then the shared `AUTO` path restores Responsive and that state persists.
- [x] `LHP-006` Phone and Wear read one `linkVersionName`; their monotonic channel codes remain independent.
- [x] `LHP-007` Exact merged release APKs and both signed public updater manifests attest final version `1.2.1` on CircleKit `0.3.17`.

## Pixel truth checked before committing

The screenshots must show all of the following:

- Responsive portrait and landscape show the same `LINK SETTINGS` state and callbacks; only bounds/presentation change.
- `DEV HOST` shows `LAYOUT`, `ORIENTATION`, and a surface derived from live bounds—there are no Phone Compact/Wide product modes.
- WatchExact exposes `AUTO, 192, 216, 240, 280, 320, 360, 400`; its 216 face stays round after the Phone rotates to 90°.
- WatchExact 400 survives restart and `AUTO` restores Responsive across the following restart.
- Real Wear is round, uses the same Link rows, and its settings contain only connection/update—not the Phone-only host selector.

Reviewed evidence:

- `phone-responsive-portrait.png`
- `phone-responsive-landscape.png`
- `phone-dev-host-responsive.png`
- `phone-dev-host-watch-exact.png`
- `phone-watch-exact-216.png`
- `phone-watch-exact-216-rotated.png`
- `phone-watch-exact-400.png`
- `phone-watch-exact-400-restart.png`
- `phone-responsive-restored-restart.png`
- `wear-watch-exact.png`
- `wear-watch-exact-settings.png`
- `phone-updater-detected.png`
- `wear-updater-detected.png`
- `phone-updater-after.png`
- `wear-updater-after.png`

## Named QA seam

Phone was driven through debug-only activity extras (`qa_page`, `qa_host`,
`qa_watch_diameter`, `qa_orientation`) delivered to the `singleTop` activity.
Wear used `qa_state=active` and `qa_page=settings`. No coordinate taps, mock
renderer, screenshot substitution, or raw input scripting was used.

The relevant shared CircleKit 0.3.17 unit contracts pin:

- 0°/180° → portrait bounds → `PHONE_COMPACT`;
- 90°/270° → landscape bounds → `PHONE_WIDE`;
- `SYSTEM` → Android `FULL_SENSOR`;
- Watch/WatchExact → `ROUND`, independent of Phone orientation;
- menu capacity and columns derive from `MenuGridSpec(surface, density, role)`.

## Release contract

Run `scripts/check-release-parity.sh` before packaging. It rejects a duplicated
Phone/Wear `versionName` while allowing separate monotonic `versionCode` values.
The public release step must record APK version, package, signer and SHA-256 for
both assets, then verify both signed `link.v1d.io` channel manifests.

## Terminal release attestation

- Product PR: [#249](https://github.com/adelost/agentmux/pull/249), merged as
  `5aca7246a20ff376da26b3633eac53844fc84968`; rollback is
  `3d6fbf16fc853fbefe4c4d091aa02c24007c6b50`.
- Final artifact-pin PR: [#251](https://github.com/adelost/agentmux/pull/251),
  merged as `2cb3a8ea5e8282d991d2a392da3ad2b4f9b4e9e4`; rollback is
  `2143b051ccea29bfae5e77f95691f31f07c873f9`.
- GitHub release:
  [agentmux-link-v1.2.1](https://github.com/adelost/agentmux/releases/tag/agentmux-link-v1.2.1).
- Phone asset:
  [Agentmux-Link-Phone-1.2.1.apk](https://github.com/adelost/agentmux/releases/download/agentmux-link-v1.2.1/Agentmux-Link-Phone-1.2.1.apk),
  package `io.agentmux.audioinbox`, version `1.2.1` (`9`), size `9,776,397`,
  SHA-256 `7ede293874b0d1a23bb9cb1b394d9d458e64736aa6ce1144f27f903da4aa9c72`.
- Wear asset:
  [Agentmux-Link-Wear-1.2.1.apk](https://github.com/adelost/agentmux/releases/download/agentmux-link-v1.2.1/Agentmux-Link-Wear-1.2.1.apk),
  version `1.2.1` (`7`), size `2,427,500`, SHA-256
  `f0a4cc86575d8e57b16b315c7ba7abcf16e1cab152ae183da761e7c4af230ba2`.
- Both APKs came from the exact merge SHA and share signer certificate SHA-256
  `b57a2862ab312bc970beeefcd55d4b48a974efd85b274b91394d4c9199484e97`.
- Public updater manifests:
  [Phone](https://link.v1d.io/releases/agentmux-link/phone/manifest-v1.json) and
  [Wear](https://link.v1d.io/releases/agentmux-link/wear/manifest-v1.json).
  Their public APKs are
  [phone code 9](https://link.v1d.io/releases/agentmux-link/phone/app-9.apk) and
  [wear code 7](https://link.v1d.io/releases/agentmux-link/wear/app-7.apk).
  Public bytes, signature, size and checksum matched the GitHub assets.

The terminal updater proof was an in-place signed upgrade without uninstall or
clear: Phone `1.2.0` (`8`) and Wear `1.2.0` (`6`) both detected
`V1.2.1 READY · TAP`, installed through their real ReleaseKit feeds, and showed
`V1.2.1 · UP TO DATE · TAP` after updater-driven restart. Semantic UiAutomator
selected the named update row and Android's named `android:id/button1`; no raw
coordinate taps were used. All four updater screenshots were inspected before
inclusion.
