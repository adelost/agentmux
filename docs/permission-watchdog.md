# Permission watchdog

## Beställning (Mattias, Discord 2026-09-12, ordagrant)

> hade den fastnat eller vad var problemet??? borde inte det vara inbyggt i amux? att kicka igång om det är uppenbar promt.. såg bara att du skickade "1" typ...

> borde i alla fall finnas i amux på något sät.. detta kostade oss väldigt stor skade 20 minuter.. får inte hända igen...

> stata jobbet är du snäll..

## Vad hände

lsrc:0 startade 16:48 en betald Modal-träning i samma Bash-block som
`Q=/mnt/q/...; rm -f "$Q"/*.md`. Claude Code stoppar `rm` med variabel i
sökvägen med frågan "Dangerous rm operation on possibly-empty variable path"
även i bypass-läge. Panelen kan inte svara på sin egen fråga och ingen del av
amux läste skärmen. Frågan stod obesvarad till 17:09.

## Vad vakten gör

Var 30:e sekund läser den varje tmux-panels skärm. När `detectPaneStatus`
säger `permission` och botten av skärmen är en Claude-fråga med numrerade
alternativ, startar en klocka per fråga (signatur = frågans text). Efter
två minuter:

- **Auto-svar "1"** bara för det enda mönstret som är bevisat ofarligt:
  skälet är "possibly-empty variable path" och samma kommandoblock sätter
  variabeln till en absolut litteral sökväg med minst tre led, och varje
  rm-mål är `"$VAR"/något`. Då skickas `1` + Enter under deliveryBroker-lås,
  och en rad postas i panelens Discord-kanal.
- **Larm** för allt annat: DM till Mattias via `notifyUser` med panel, skäl
  och kommandoraderna, en gång per fråga. Ingen tangent skickas.

Stale scrollback matchar inte: frågan måste ligga i skärmens sista rader
utan en composer-prompt under sig, samma regel som `core/dismiss.mjs`.

Miljö: `AMUX_PERMISSION_WATCHDOG_ENABLED=false` stänger av,
`AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER=false` gör den larm-only,
`AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS` (120000) och `_POLL_MS` (30000).
