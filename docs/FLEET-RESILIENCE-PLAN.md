# Fleet resilience plan (målbild)

Status: levande dokument. Ägare: lsrc:10 (kod), lsrc:3 (mätning/verifiering).
Beslutat efter WSL-OOM 2026-07-20 (48 GiB RAM + 4 GiB swap slut; qemu/Chrome/CUDA/agenter;
tmux var en liten process; Windows överlevde, WSL dog).

## Arkitekturbeslut

**Vald väg: (A) stabiliserad tmux + engine-adapters, med (D) native/pull som strategisk riktning.**

- (C) zellij/screen/WezTerm: samma scrape-klass i alla multiplexers; löser varken OOM eller TUI-scraping.
- (B) egen PTY-daemon: bygger om ~20 % av tmux sämre och tappar mänskligt inspekterbara panes
  (som fungerade när bryggan dog).
- (D) native/pull-only: rätt sluttillstånd (suggestions-board pull-modellen) men inte som big bang.
- Skärmen är observation, aldrig sanning, när JSONL/hooks/native runtime finns.

## Regler för allt nedan

- Filer < 500 rader; shell/PowerShell endast tunn I/O.
- En state machine per pelare; inga dubbla truth sources.
- Ta bort bypass-vägar hellre än kompatibilitetslager.
- Fokuserade unit-tester på rena beslut + manuell recovery; ingen tung CI.
- Vakter dödar/startar aldrig aktivt arbete; människan är alltid override.

## Tickets

### T1 — Memory admission guard (LEVERERAD i denna branch)
`core/memory-guard.mjs`: observeMemory → classify(normal|warn|blocked|critical) → canStart(class,reserveMiB).
Trösklar (relativa, 48 GiB-host): warn <17 % MemAvailable; blocked <11 %, eller <17 % + SwapFree <25 %;
critical <6 % + SwapFree <10 % ×2 samplingar. Hysteres: clear efter 3 samplingar >21 % (swap ignoreras).
Statefil `~/.agentmux/memory-guard.json` med bootId/observedAt, TTL 75 s; stale = fail closed för
automatiska starters, manuell start = explicit override. Transition-only-larm (bryggan postar till
`AMUX_MEMORY_ALERT_CHANNEL` om satt, annars logg). Post-boot revive är första integrerade automatiska
heavy-startern (`bin/memory-guard.mjs check --class pane-revive --reserve-mib 8192`, live-sample).

### T2 — Pinned release + boot identity (LEVERERAD i denna branch)
Återanvänder `core/release-install.mjs` + `bin/install-release.mjs` (git-archive → npm pack → embedded
`.agentmux-release.json` med sourceSha + filhashar → non-symlink-install → host receipt → byte-verify).
`identityDecision()`: allowBridge=alltid (recovery-kanal), allowRevive=endast vid ok, med exakt orsak.
`bin/verify-release-identity.mjs` är gate i `bin/post-boot-revive.sh`: vägrar panel-revive vid fel
identity, recovery-kanalen lever. Externa config/secrets pinnas: `~/.agentmux/.env` +
`~/.agentmux/agentmux.yaml` (0600, `AMUX_DISCORD_ENV`/`AGENTMUX_YAML` override); package-kopia = endast
migreringsfallback (en `npm install -g .` får aldrig mer vara enda vägen till credentials).
Heartbeat projicerar manifest-SHA (fanns redan; kräver manifest).

### T3 — Windows guardian (nästa)
Bygg ut `bin/windows-discord-restarter.ps1`: ärlig sond (WSL offline vs bridge offline vs fleet
degraded; timeout på ALLA wsl.exe-anrop — häng = WSL-degraded), bounded backoff-restart, senaste
godkända agentöversikt på NTFS med observedAt/stale-markering. Tunn konsument av samma
health-beslut (heartbeat + memory-guard state + release identity). Hard reset ENDAST när WSL-probe
faktiskt är unresponsive.

### T4 — `amux triage` overview
Read-model över befintliga signaler (queue/asks/wire-aktivitet/worktree-dirt):
NEEDS YOU / STALE WORKING / DIRTY+IDLE / DUPLICATE / DELIVERY BLOCKED / OFFLINE / DONE CLEAN /
ACTIVE HEALTHY. Dubbletter markeras, stoppas aldrig automatiskt. Återanvänder done/ps/asks.

### T5 — Engine quirk-registry (refactor)
Deklarativ profil per engine (Claude/Codex/Kimi): composer markers, busy/idle-evidence,
paste-placeholder-grammatik, submit/queue-key, receipt-källa, probe-policy, kända races.
Mina Kimi-tillägg (paste-placeholder-kvitto, collapsed-composer-draft, probe+nonce) flyttas in i
Kimi-profilen. Ny modell-CLI = ny adapter + profil, inte if-satser. Ingen beteendeändring.

### T6 — agentus.service
Crash-loopar (status=200/CHDIR, saknad `/home/adelost/lsrc/agentus`). Beslut: disable eller peka om
WorkingDirectory. Trivial men egen ticket; guardianen i T3 ska känna till rätt sanning.

### T7 — Pull-mailbox / native cutover (strategiskt)
Suggestions-boardets pull-modell som leveranskanal; gradvis cutover från TUI-injektion.
Kopplas till suggestions-bantningen (eget spår).

### T8 — Panel sleep/hibernate (från Adelost)
60 paneler samtidigt är minnesbördan. Idle-paneler ska kunna sleepas: kör `/compact` först
(resume from summary är kravet), sedan stoppas processen, och bryggan väcker on demand när ett
meddelande adresserar panelen. Kräver: pålitlig idle-detektion (wire-journal, inte skärm),
compact-som-funkar-kvittering, och väck-väg via befintlig durable queue. Även: tile/geometri —
44/76 paneler är för små enligt doctor; färre/större aktiva fönster åt gången.

### T9 — JSONL/log-trim (från Adelost)
Stora json-filer (wire.jsonl, sessions, delivery-queue-arkiv, logs) växer utan tak:
rotation/bounded tail per fil, arkivering av terminala jobb, storleksbudget per session.
Mät först vilka filer som faktiskt växer (kandidater: ~/.kimi-code/sessions, ~/.agentmux logs).

## Nuvarande driftstatus (2026-07-20)

- Brygga: 1.25.25 live med probe+nonce-fix (paste-placeholder-kvitto, collapsed-composer-draft,
  ingest-probe, park-aldrig-drop). #139-granskning: PASS (levererad till claw:3).
- Global install: reparerad till riktig kopia efter symlink-incidenten; .env + agentmux.yaml
  återställda. Manifest saknas tills T2-branchen mergats och officiell install körts — doctor
  visar "no valid exact-SHA release manifest" tills dess, vilket är KORREKT refusal-beteende.
- Efter merge: `node bin/install-release.mjs --sha <origin/master SHA>` → verifiera med
  `amux doctor` (release identity ok, heartbeat sourceSha != null) + manuell boot-revive-test.
