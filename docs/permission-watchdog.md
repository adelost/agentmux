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

## Beställning 2 (Mattias, Discord 2026-09-14, ordagrant röst)

> Kan du inte bygga in i amux att den godkänner RM automatiskt. Jag tycker inte detta är okej, det är sjukt jobbigt att den fastnar på de här sakerna. Det förstör jättemycket för oss. Kan du fixa till det så det löser sig automatiskt ordentligt.

claw:0 stod ungefär tio minuter på "Dangerous rm operation on statically-unresolvable target: /home/adelost/.openclaw/workspace/.agents/0/reply-audio/*". Vakten kände bara igen varianten "possibly-empty variable path", så den larmade i stället för att svara. I nyare Claude Code står dessutom skälet inne i ramen, uppdelat på två rader. Claude Code skriver själv att frågan "cannot be auto-allowed by permission rules", så det går inte att lösa i settings.json.

## Vad vakten gör

Var 10:e sekund läser den varje tmux-panels skärm. Frågan måste ligga i skärmens sista rader med numrerade alternativ och "Esc to cancel", utan en composer-prompt under sig. Då startar en klocka för frågan, och frågans text är dess signatur.

**Auto-svar "1" efter 10 s** för varje "Dangerous rm operation"-fråga (variabelväg eller mål som inte kan lösas statiskt) där varje rm-mål klarar alla fem kraven:

1. **Målet går att lösa upp till en litteral sökväg.** `$VAR` måste sättas till en absolut litteral sökväg i samma kommando. `~` räknas som hemkatalogen. Ett relativt mål måste stå efter ett `cd /absolut/sökväg` i samma kommando. Globben kapas vid första `*`, `?` eller `[`.
2. **Sökvägen går inte uppåt.** Den innehåller inga `..`, och ett relativt mål är inte hela arbetskatalogen.
3. **Sökvägen ligger minst tre nivåer ner** från filsystemets rot.
4. **Sökvägen är inte en skyddad plats.** Det gäller hemkatalogen och mappar direkt i den, till exempel `~/lsrc/*`, samt en enhet eller mappar direkt på den, till exempel `/mnt/q/apps/*`.
5. **Git behåller inga filer där.** `git ls-files --cached --others --exclude-standard` ska inte lista något. Spårade filer och nya filer som ännu inte är committade, till exempel dagens minnesanteckningar, räknas som användarens arbete. Mappar som git ignorerar är engångsdata. Om git misslyckas av något annat skäl än att sökvägen inte ligger i ett repo räknas det som "behålls".

Svaret skickas som `1` och Enter under deliveryBroker-lås, och en rad postas i panelens Discord-kanal.

**Ägarrouting efter två minuter** för allt annat: kommandosubstitution, variabler som inte kan lösas, skyddade platser och alla frågor som inte gäller rm. Om projektet deklarerar en annan `orchestrator`-panel skickas frågan dit en gång. Om ingen sådan panel finns eller leveransen nekas går frågan direkt till människan. Om ägaren inte löser frågan går ett DM via `notifyUser` efter totalt tio minuter. Ingen tangent skickas för dessa frågor.

Varje auto-svar kontrollerar under samma delivery-broker-lås att pane-sessionen och den hashade fullständiga prompten fortfarande är exakt de observerade. Ett sessionsbyte, en ändrad fråga eller en osäker session stoppar svaret. Ett påbörjat svar upprepas aldrig.

Projektets ägarpanel deklareras i den användarägda `agentmux.yaml`:

```yaml
agents:
  skyvw:
    orchestrator: 5
```

Miljövariabler:
- `AMUX_PERMISSION_WATCHDOG_ENABLED=false` stänger av vakten.
- `AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER=false` gör den till enbart larm.
- `AMUX_PERMISSION_WATCHDOG_ANSWER_AGE_MS` (10000) styr väntan före auto-svar.
- `AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS` (120000) styr väntan före larm.
- `AMUX_PERMISSION_WATCHDOG_HUMAN_AGE_MS` (600000) styr väntan före DM när en ägarpanel har fått frågan.
- `AMUX_PERMISSION_WATCHDOG_POLL_MS` (10000) styr hur ofta skärmarna läses.
