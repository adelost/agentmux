# Agentmux Link host preview and release parity

Source candidate: `feat/link-host-preview-version-parity`

## Stable checklist

- [x] `LHP-001` Phone exposes only `RESPONSIVE` and `WATCH EXACT`; Compact/Wide are derived by CircleKit from live bounds.
- [x] `LHP-002` The same Link settings route survives Responsive portrait → landscape → WatchExact without a preview renderer.
- [x] `LHP-003` WatchExact 216 and 400 use the shared `LinkWatchSurface`; 90° remains a round, single-column Watch surface.
- [x] `LHP-004` Real Wear uses the same Watch presenter and omits the meaningless DEV host selector.
- [x] `LHP-005` WatchExact persists over process restart, then the shared `AUTO` path restores Responsive and that state persists.
- [x] `LHP-006` Phone and Wear read one `linkVersionName`; their monotonic channel codes remain independent.
- [ ] `LHP-007` Exact merged release APKs and both signed public updater manifests attest version `1.2.0`.

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

## Named QA seam

Phone was driven through debug-only activity extras (`qa_page`, `qa_host`,
`qa_watch_diameter`, `qa_orientation`) delivered to the `singleTop` activity.
Wear used `qa_state=active` and `qa_page=settings`. No coordinate taps, mock
renderer, screenshot substitution, or raw input scripting was used.

The relevant shared CircleKit 0.3.15 unit contracts pin:

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
