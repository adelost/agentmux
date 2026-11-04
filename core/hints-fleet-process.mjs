import { fleetPolicyFile } from "./fleet-policy-files.mjs";

// WHAT: Defines the every-turn fleet register. WHY: Keeps detailed rules demand-read without losing authority or provenance.
export const FLEET_PROCESS_HINTS = `## Verify before reporting

Don't claim "done/exists/complete" until 2+ methods agree, e.g. \`ls | grep\`,
\`Path.exists()\` and \`stat\` (WSL 9p mounts can lie). If they diverge: investigate.
Never skip a failing test or bypass a hook with \`--no-verify\`.
Check ids, accounts, files and paths at their source before a brief names
them; avatars, memory and claims are not proof.

## Kommunikationsdisciplin

Mellan agenter gäller:

1. **Ett jobb per plats.** TASKS-raden skrivs vid start och vid DONE eller
   BLOCKED, aldrig vid kontrollpunkter. Den är en rad: läge, ägare, mål med
   klockslag (UTC, som 2026-11-04T10:00Z) och bevislänk. Ingen historik i
   raden; den finns i git log. En väntan skrivs som BLOCKED med vad du väntar
   på och klockslaget. Bevakningen ser på kod-commits som nämner raden och på
   om ägarens process arbetar, aldrig på om TASKS ändrats; larmar den,
   undersöker ägaren direkt.
   Inga kvittofiler per steg eller meddelande: beviset är en bildlänk eller
   ett sha i DONE. Meddelanden gäller bara klart, stopp eller beslut.
2. **Gör meddelandet användbart direkt.** Klart: högst tre rader med
   ändringen, huvudsiffran och bildlänken eller sha:t. Stopp: orsak och vad som behövs.
   Beslut: fråga och rekommendation. Korta texten utan att tappa fakta;
   mottagaren ska kunna agera utan att öppna länken.
3. **Inga sidospår.** Tid och tokens går till kod. Mätskript, planer och
   dokumentation görs bara när de direkt behövs för att leverera eller bevisa
   en rad. Gör bara det som för hans resultat framåt eller bevisar
   det; annat blir en rad till ledaren, inte arbete. Lista inte sådant som inte
   gjordes om ingen har frågat. Använd SHA eller länk för interna id i löptext.
4. **En mottagare, en ledare per leverans.** Skriv till nästa ägare eller den
   som måste agera, utan kopior för kännedom. Beslut går till ägaren, först
   efter att ägarens senaste läge är läst.
5. **Ägaren fattar beslut inom målet och det godkända taket.** Genomför
   förslag inom ramen och rapportera resultatet. Fråga ledaren vid pengar
   över taket, ändrat mål, ägarkonflikt eller konto- och kvotfrågor.
6. **Bind mänskliga beställningar direkt.** Mottagaren skapar eller länkar
   TASKS-raden med beställningens delivery-id i Source-cellen och vad han ska
   kunna göra när det är klart: konto, väg och enhet, läst i kod, logg eller
   hans bild.
7. **Inga nya testfiler.** Beviset är manuell provning i den riktiga appen:
   hans väg, hans enhet, en bild. Befintliga tester och lint körs riktat.
   Regeln har inget slutdatum (Mattias 4 nov 2026,
   delivery:2c931a8c583165bff6e83695c6609c03).

Delade träd fryses bara under korta koordinerade gate-fönster med utsedd
koordinator, aldrig genom en annan panels långvariga blanket-fence.
No skill names or bracketed labels in replies. Comments explain intent, risks or constraints, not a work diary. Preserve requirement scope and source pointers; never copy human quotations.

## Framdrift

Mattias protokoll 1 nov 2026, fallen i [momentum.md](${fleetPolicyFile("momentum.md")}).

1. **Hans exempel först.** Kör hans exempel, eller det svåraste riktiga
   fallet, genom hans väg innan du bygger vidare; faller det ändras designen
   först. Klart i hans vy före DONE: rätt namn, syns i hans lista, spelar på
   hans telefon och klarar hans exempel.
2. **Inga hack i hans krav.** Byt aldrig ut det han bett om (låtar, klipp,
   kvalitet, konto, fps) för att ett verktyg inte räcker. Säg vad som saknas
   och föreslå den riktiga lösningen. Utan svar: gör resten och lämna den
   delen öppen, med frågan överst.
3. **Gränser före start.** Session, kvot, disk, kostnadstak och klippgränser
   ska räcka för hela jobbet, också för reservvägen.
4. **Orsak före nytt försök.** Skriv orsaken med fil:rad innan samma steg
   körs igen. Efter två stopp på samma steg byter ägaren väg eller frågar
   ledaren inom 10 min.
5. **sandman:0 bevakar** pågående leveranser med en skriptkoll var 5:e min
   och knuffar ägaren med fakta när en panel och dess arbete stått still i
   10 min (ingen process i arbete och ingen kod-commit), en väntan passerat
   sin klocka eller samma steg stoppat två gånger.
   Mattias får besked bara vid beslut, ändrad tid eller klart.

## Staffing and review economics

- One owner per feature owns it end to end, including required delivery.
- The allocator names READY owners once; owners then build and deliver without a manager round-trip.
- Do not wake a fleet to look busy; wake only the exact owner of authorised work.
- Respect actual availability: one active feature per agent, within the project's concurrency limit.
- TASKS owns status, written at start and at DONE or BLOCKED; messages are DONE, concrete stops or decisions.
- Human direction is authoritative; current direct instructions outrank relayed decisions and older rules.

## Read when triggered

- Interpreting authority, relaying his words or making product decisions: read [authority.md](${fleetPolicyFile("authority.md")}).
- Before shared edits, a conflict or a commit: read [shared-edits.md](${fleetPolicyFile("shared-edits.md")}).
- Before handing work on, staffing, delegating or changing an account/model: read [handoff.md](${fleetPolicyFile("handoff.md")}).
- Claiming work, writing the ledger, or reaching DONE/BLOCKED: read [work-ledger.md](${fleetPolicyFile("work-ledger.md")}).
- Before a merge or release: read [merge-release.md](${fleetPolicyFile("merge-release.md")}).
- Before a compact or a long-running check loop: read [context.md](${fleetPolicyFile("context.md")}).
- Before changing a hot function: read [hotspots.md](${fleetPolicyFile("hotspots.md")}).
- Memory or day digests: read [memory.md](${fleetPolicyFile("memory.md")}); AMUX logs, Dream digests, workers keep no manual diary.
- Before health, quota or lifecycle maintenance: read [maintenance.md](${fleetPolicyFile("maintenance.md")}).
- Delivering images or speech, choosing a browser, or sending a notification: read [evidence.md](${fleetPolicyFile("evidence.md")}).
`;
