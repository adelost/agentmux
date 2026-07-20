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
Statefil `~/.agentmux/memory-guard.json` med bootId/observedAt, TTL 75 s; stale/mismatchad bootId/future
timestamp = fail closed för automatiska starters, manuell start = explicit override.
Transition-only-larm (bryggan postar till `AMUX_MEMORY_ALERT_CHANNEL` om satt, annars logg) + ett
synligt initial-larm om första verdicten är non-normal.
**Slice-1-scope (ärligt):** endast post-boot pane-revive är gated idag (live-sample,
`bin/memory-guard.mjs check --class pane-revive --reserve-mib 8192`). Det är INTE fullt OOM-skydd
mot QEMU/Chrome/CUDA ännu — bredare admission-integration (browser/emulator/gate-starters) är T12.

### T2 — Pinned release + boot identity (LEVERERAD i denna branch)
Återanvänder `core/release-install.mjs` + `bin/install-release.mjs` (git-archive → npm pack → embedded
`.agentmux-release.json` med sourceSha + filhashar → non-symlink-install → host receipt → byte-verify).
`identityDecision()`: allowBridge=alltid (recovery-kanal), allowRevive=endast vid ok, med exakt orsak.
`bin/verify-release-identity.mjs` är gate i `bin/post-boot-revive.sh`: vägrar panel-revive vid fel
identity, recovery-kanalen lever. Externa config/secrets pinnas: `~/.agentmux/.env` +
`~/.agentmux/agentmux.yaml` (0600, `AMUX_DISCORD_ENV`/`AGENTMUX_YAML` override); package-kopia = endast
migreringsfallback (en `npm install -g .` får aldrig mer vara enda vägen till credentials).
Heartbeat projicerar manifest-SHA (fanns redan; kräver manifest).

### T3 — Windows guardian (SRC-0123, implementation pågår)
**Hård säkerhetsgräns (lsrc:3, bindande):** guardian är transport + observation + säker
egenåterställning — ALDRIG autonom maskinåterställning.
Tillåtet: observera, durable NTFS-kö, Windows-side `amux send`, svara via Discord/LLM, klassificera
bridge-vs-WSL-vs-host-fel, starta om SIN EGEN lilla Windows-process.
Aldrig automatiskt: `wsl --shutdown`, döda tmux/panes, reboota Windows, reparera diskar, retry av
tvetydiga skrivningar. En timeout är bevis på okänt tillstånd, inte tillstånd att mutera det.
WSL-reset kräver explicit mänskligt kommando (eller evidensbaserad LLM-rekommendation + explicit
godkännande). Eventuell framtida automatisk återställningsåtgärd: separat opt-in, bounded ett
försök, bevara diagnostik/arbete, eskalera vid osäkerhet. Host/disk död → mark OFFLINE/STALE +
köa; påstå aldrig recovery.
Bygg ut `bin/windows-discord-restarter.ps1` inom dessa ramar. Tunn konsument av samma
health-beslut (heartbeat + memory-guard state + release identity).
**Synligt foreground-läge är kanoniskt:** brygga och framtida Windows-räddning öppnas i en
synlig terminal (`amux serve` i förgrunden); `--detach` är opt-in, aldrig default.

Det versionerade kommandot, threat model och operatörsflödet finns i
[`docs/WINDOWS-RESCUE-BRIDGE.md`](./WINDOWS-RESCUE-BRIDGE.md). `_windows_` är en separat
Windows-ägd Discord-kanal och får inte förekomma i WSL:s genererade kanalmap.

### T11 — Controlled WSL restart (nästa version, PLANERAD – ej påbörjad)
Use case: en säker WSL-omstart som låter alla Codex-paneler ladda om delade credentials,
utan att besöka paneler individuellt. Tre explicita faser, aldrig autonom vid timeout:
1. `amux restart-ready` (WSL, non-destructive): inventera aktiva turer/leveranser/smutsiga
   worktrees/auth-status; be aktiva paneler checkpointa durabelt; vänta bounded eller returnera
   BLOCKED med exakta paneler. Persista redacted resume-manifest + färsk readiness-kvittens
   (boot/fleet-generation-bunden, inga secrets). Dödar aldrig arbete.
2. `amux-windows restart-wsl --receipt <id>` (Windows): validera kvittsen, exakt EN `wsl --shutdown`,
   starta WSL med hårda timeouts, stoppa vid klassificerat fel. Inga loopar, inga retry av
   tvetydiga skrivningar, ingen restart bara för att en heartbeat timat ut.
3. Verifierad återställning: Windows-transport först i synlig terminal, sedan `amux serve` i
   förgrunden (kanoniskt; `--detach` är opt-in, aldrig default); identity-check
   av installerad release; återskapa konfigurerade tmux-sessioner; resume från persistade
   sessioner/journal; dränera durable meddelanden; publicera RECOVERED / PARTIAL / BLOCKED.
   Påstå aldrig recovered från processexistens.
Auth-kontrakt: `codex login` görs en gång explicit (delad `~/.codex/auth.json`); efter kontrollerad
omstart laddar Codex-paneler om den. `codex login status` är observation, inte bevis att varje
connector funkar — verifiera connector/app-auth separat; WSL-omstart lagar inte `codex_apps`-401.
Acceptans: aktiva paneler/smutsiga worktrees blockerar restart-ready tills checkpointat; krasch
mellan shutdown/start lämnar manifestet intakt + Windows rapporterar host/WSL offline; resume
träffar exakta sessionsidentiteter utan dubblett; stale/fel-generation-kvittens refuseras;
saknad release-identity vägrar panel-revive men håller recovery-kanalen vid liv; en manuell
repetition med engångsflotta om 2 paneler; fokuserade unit-tester.

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
60 paneler samtidigt är minnesbördan. Design (Mattias/lsrc:3): manager-AI får FÖRESLÅ
long-idle/done-kandidater, men en deterministisk controller verifierar ensam: ingen aktiv
turn/permission/input, ingen levande leverans, compact slutförd med exakt kvitto — först då
sleepas panelen. Auto-sleep ALDRIG för dirty/rebasing/ambiguösa paneler. Nytt meddelande väcker
exakt målpanelen via samma gated path som durable delivery (wake-admission). Även:
tile/geometri — 44/76 paneler är för små enligt doctor; färre/större aktiva fönster åt gången.

### T12 — Bredare admission-integration
T1:s canStartHeavy utökas från slice-1 (endast post-boot revive) till bevisade automatiska tunga
starters: browser/visual-gates, emulator/QEMU, tunga CI-gates. En grov flock runt automatisk
heavy-start om samtidighetsrace bevisas. Fortfarande: aldrig kill/restart från memory guard.

### T13 — Recovery-slice efter `amux stop --all`-incidenten (LEVERERAD i denna branch)
Incident: `amux stop --all` dödade kodprocesserna och kraschade sedan med `cmdUnserve is not
defined`; flottan revivades delvis felaktigt ("no tasks" trots sex verkligt avbrutna).
- `amux stop --all` atomisk: hela stop-planen resolvas före första kill, bryggan stoppas via
  bridgeLifecycle.stop (cmdUnserve-dödssymbolen är borta även i offline-sync-pathen).
- Klassificering: planRevive täcker nu alla engines — ledger (Claude) + Codex rollout +
  Kimi Wire — via `journalInterruptionFromTurns`; `amux revive --dry` visar avbrutna med
  evidenskälla istället för "inga".
- Selektiv revive som default: endast klassificerade avbrutna paneler revivas; övriga startas
  on demand; `--all` är legacy whole-fleet. cmdRevive flyttad till cli/revive.mjs.
- Wake-admission (T8-sömmen): durable meddelande till stoppad pane väcker exakt målet, men
  fail-closed — release-identity + minnesvakt måste passera först, annars ligger meddelandet
  kvar köat med klassificerad `wake-refused:<orsak>`, aldrig falskt ACK. Körs i brokern
  (`bridgeDir`-wiring), gatebar per test via `wakeAdmission`-option.
- Kvar till T13-fortsättningen: manager/recovery-agent som konsumerar samma klassificering
  (T10-spår), samt `amux triage` (T4).

### T9 — JSONL/log-trim (från Adelost)
Stora json-filer (wire.jsonl, sessions, delivery-queue-arkiv, logs) växer utan tak:
rotation/bounded tail per fil, arkivering av terminala jobb, storleksbudget per session.
Mät först vilka filer som faktiskt växer (kandidater: ~/.kimi-code/sessions, ~/.agentmux logs).

### T10 — Fleet-overseer + kanalnamn (från Adelost)
En manager-kanal per modell man kan prata med i Discord: `_mgr-kimi`, `_mgr-codex`, `_mgr-claude`
(underscore sorterar överst). Overseern är en vanlig agentpane med fleet-manager-prompt i sin
workspace (AGENTS.md): hur man läser `amux triage/done/asks/doctor`, hur man petar en panel
(`amux <agent> -p N`), vad den ALDRIG får (merge/deploy/kill utan eskalation till människan),
och eskalationsväg. Den är INTE T3-guardianen: guardian på Windows är dum och överlever allt,
overseern är en LLM i WSL som dör med resten — olika lager, olika jobb.
Kanalnamn retroaktivt: bindningen i agents.yaml sker via channel-ID, inte namn, så rename är
säkert. Schema: `<modell>-<flotta>-<pane>` (kimi-lsrc-10, codex-skyvw-4, claude-claw-1) +
`_mgr-*` överst. Engångsscript via Discord API som läser agents.yaml och döper om, torr körning
först. Nuvarande läge: mix av suffix (`lsrc-10-kimi`) och inget alls — rörigt men billigt att fixa.

## Nuvarande driftstatus (2026-07-20)

- Brygga: 1.25.25 live med probe+nonce-fix (paste-placeholder-kvitto, collapsed-composer-draft,
  ingest-probe, park-aldrig-drop). #139-granskning: PASS (levererad till claw:3).
- Global install: reparerad till riktig kopia efter symlink-incidenten; .env + agentmux.yaml
  återställda. Manifest saknas tills T2-branchen mergats och officiell install körts — doctor
  visar "no valid exact-SHA release manifest" tills dess, vilket är KORREKT refusal-beteende.
- Efter merge: `node bin/install-release.mjs --sha <origin/master SHA>` → verifiera med
  `amux doctor` (release identity ok, heartbeat sourceSha != null) + manuell boot-revive-test.
