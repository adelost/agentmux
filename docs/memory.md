# amux memory — design (2026-07-11)

## Implementationsverdict (kritisk review)

**Riktningen godkänd, fyra detaljer ändrade före implementation:**

1. Fullversioner bankas i en path-scopad batch-commit före någon LLM-körning.
   Befintligt staged WIP stoppar körningen; orelaterat unstaged/untracked WIP
   följer aldrig med. En innehållsjämförelse stoppar overwrite vid samtidig edit.
2. LLM:n får inga verktyg (`claude --print --safe-mode --tools ""`), källan
   skickas som data via stdin och output skrivs först efter schema- och
   invariantsvalidering.
3. `~5`/`~20` betyder semantiska innehållsrader. Dagfilens obligatoriska ram
   ger upp till fem fysiska rader extra. Annars var 5-radersmålet oförenligt
   med lintens obligatoriska metadata och sektionsrubriker.
4. Bash-wrappern pensioneras inte. Den är en tunn, stabil heartbeat-entrypoint;
   all logik och alla tester ägs av amux.

## Problem

Minnesunderhållet är idag splittrat över tre halvor som inte pratar med varandra:

1. `amux dream` (i amux): nattlig digest per panel till dagfilen. Funkar, har radbudget.
2. `scripts/memory/lint.sh` (workspace-bash): varnar korrekt för stora filer,
   men outputen har ingen konsument — varningar från MARS står obesvarade i juli.
3. Manuella konventioner ("dagfiler >30d → ~5 rader"): ingen mekanism kör dem.

Uppmätt kostnad: dagfilen 2026-07-10 = 659 rader/124KB ≈ ~30k tokens.
Sessionsstart-rutinen "läs dagens + gårdagens" gör det till en skatt VARJE
panel betalar VARJE morgon. MEMORY.md ligger på 6KB mot sin 4KB-cap.

Rotorsak: **varningar utan aktör** + mekanism utanför amux (otestad bash,
ingen versionering, ingen som äger den).

## Princip

**amux äger mekanismen, workspace äger policy + innehåll.**
Samma split som canonical hints: motorn är testad och versionerad i amux,
workspace bidrar med data (templates, policy-overrides, ignore-lista).

## Kommandofamilj

```
amux memory status          # storlekar, varningsantal, backlog-ålder, senaste dream/compact
amux memory lint [--json]   # port av lint.sh som data-drivna regler; exit 1 vid varningar
amux memory compact [--dry] # AKTÖREN: konsumerar lint-fynden, max N filer/körning
```

### Policy som data (defaults, överstyr via `memory/.memory-policy.yaml`)

| Yta | Gräns | Åtgärd |
|-----|-------|--------|
| `MEMORY.md` | 4KB | warn (manuell curation, ALDRIG auto-compact) |
| dagfil idag/igår | — | fredad, rörs aldrig |
| dagfil 2–30d | >100 rader | compact → ~20 rader |
| dagfil >30d | >30 rader | compact → ~5 rader |
| `references/*` | >500 rader | warn-split (aldrig auto) |
| `people/*` | >500 rader | warn (aldrig auto — känsligt innehåll kräver omdöme) |

Endast dagfiler auto-komprimeras: lägst risk, git-bankade, och deras varaktiga
innehåll ska ändå graduera till references/people via routing-reglerna.

### Compact-flödet per fil

1. **Banka fullversionen i git** — flera dagfiler är otrackade; utan
   bank-commit vore komprimering destruktiv. Git-historiken ÄR arkivet.
2. LLM-komprimering (headless `claude -p`, strikt prompt): behåll
   `> summary:`/`> why:`, beslut, lärdomar, länkar; mål-radantal per policy.
3. **Validering**: radantal inom mål, header intakt, template-tagg kvar.
   Olösta todos och befintliga `memory/*.md`-länkar får inte tappas. Vid
   valideringsfel har produkten ännu inte skrivits; compact-commit-fel
   återställer från bank-commiten när filen fortfarande matchar vår produkt.
4. Compact-commit med tydligt meddelande (fullversion = föregående commit).

Äldst först, max 3 filer/natt (bounded work) → mars–juni-backloggen dräneras
automatiskt på ~2 veckor, sen är systemet självunderhållande.

### Nattkedjan (dream-cron.sh)

```
amux dream  →  amux memory compact  →  amux memory lint
```

Lint-resultatet routas till en YTA SOM LÄSES: en rad i dagens dagfil,
`memory: X varningar, backlog Y filer, komprimerade Z inatt`. Det stänger
"varning utan aktör"-hålet från båda håll: natten agerar, morgonen ser resten.

## Följdförbättringar (ingår i paketet)

- **Dream retry-pass**: 04-passet kör med deferred sentinel och släpper locken.
  Cron-processen väntar till ~05, kör `dream --retry` bara för markerblock som
  saknas och skriver därefter den kumulativa sentineln.
- **Dream block-validering**: warn när ett panelblock överskrider
  ~10-radersbudgeten som prompten redan kräver.
- **Loggnings-konvention i AGENT_HINTS**: bullets inte stycken, max ~10 rader
  per manuell sektion. Mätningen visar att bloat-källan är panelernas manuella
  loggning, INTE dream-blocken (dream har redan budget).

## Migration

1. `amux memory lint` byggs med tester; `scripts/memory/lint.sh` blir en tunn
   wrapper som anropar den (heartbeat-integrationen orörd).
2. `amux memory compact` byggs + kedjas in i dream-cron.
3. Backloggen dräneras automatiskt.
4. Wrappern ligger kvar som kompatibilitetsyta; den innehåller ingen policy.

## Status

Implementerad i 1.20.77 efter oberoende kritisk review. Dream-abort-buggen
(en trög panel avbröt resterande paneler) var redan fixad separat.
