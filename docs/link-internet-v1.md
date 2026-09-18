# Agentmux Link Internet V1 — kontrakt och threat model

Mål: Agentmux Link (Android) ska fungera över vanligt internet utan Tailscale,
offentlig hem-IP eller port-forwarding. En operatörskonfigurerad HTTPS-mailbox
är den enda publika ytan; WSL och Windows ansluter utåt som connectors.

Icke-mål i V1: inga roller/membership i identitetsleverantören, inga Suggestions-tickets,
ingen ny scheduler/supervisor, ingen publik ingress hemma, ingen autonom
destruktiv restart (gäller #198/#199 redan).

## Komponenter

- **Link-tjänsten** (Cloudflare Worker + operatörens D1- och R2-resurser):
  mailbox, auth, sessioner, heartbeats. Äger inga agentdata.
- **Appen** (Android): Custom Tab-login, PKCE, Keystore-session, chat/PTT,
  ärlig status (queued/online/offline).
- **WSL-connector** (`channels/link-connector.mjs` i bryggan): pollar utåt,
  claimar targets den äger (t.ex. project:3, project:4), levererar via durable
  amux-kö (messageId som idempotency key), postar reply.
- **Windows-connector** (i Windows-managerns runtime): samma kontrakt för
  target=windows; lever när WSL är död. Konsument, aldrig publik ingress.

## Auth (två ben)

1. **Link ↔ konfigurerad identitetsleverantör**:
   `/authorize?app_id&redirect_uri=<LINK_PUBLIC_ORIGIN>/auth/callback&state&code_challenge(S256)`
   → Google → callback `code` → POST `/token` (redirect_uri + code + verifier)
   → principal (identityId, verifiedEmail). State är förseglad cookie.
   Link är confidential klient; hemligheten är Worker-secret, aldrig i APK.
2. **App ↔ Link**: appen genererar egen PKCE. `/auth/start?challenge&client=android`
   startar ben 1. Efter callback utfärdar Link en kortlivad engångskod
   (`code`, ≤60 s, single-use) som returneras via verifierad Android App Link
   (`<LINK_PUBLIC_ORIGIN>/auth/app-return`) eller custom scheme `agentmux://auth`.
   Appen byter `code` + sin verifier mot `/auth/exchange` → opaque
   Link-session (30 d, revokerbar). Verifiern lagras krypterad med Android
   Keystore före Custom Tab-start och överlever processåterskapande utan att
   läggas i Intent/logg/argv. Ny login ersätter pending verifier; misslyckad
   exchange behåller den. Lyckad sessionlagring och verifier-rensning sker som
   en expected-verifier-transition, och login kvitteras inte om lagringen
   misslyckas.

**Bindning exakt en gång:** första giltiga loggen binder verifiedEmail →
identityId mot en konfigurerad allowlist (identiteter i D1, seedade av
operatören, aldrig hårdkodade). Därefter authz endast mot identityId.
Nekad identitet = 403 med neutral orsak, även vid giltig Google-login (E).

## Mailbox-kontrakt

```
messages(clientMessageId TEXT PK, identityId TEXT, target TEXT, kind text|voice,
         body TEXT, voiceRef TEXT NULL, state, createdAt, leaseOwner, leaseExpiresAt,
         deliveredAt, replyBody, replyAt, attempts INT, lastError TEXT)
sessions(tokenHash TEXT PK, identityId TEXT, createdAt, expiresAt, revokedAt)
identities(identityId TEXT PK, label TEXT, createdAt)        -- allowlist, seed
heartbeats(connectorId TEXT, target TEXT, seenAt, source TEXT) -- wsl|windows
```

- `POST /api/link/send` (session): `{clientMessageId: uuid, target, text|voiceRef}`.
  Unik PK gör submit idempotent inom samma identity; samma id + samma payload
  → 200 replay, annan payload eller en annan identitys id → neutral 409.
  Eventhistorik och voiceRef-ägarskap filtreras på samma identity. Text ≤ 4000 tecken.
- States: `queued → leased → delivered → replied | failed`. Working visas
  bara ur verkligt kvitto (delivered), aldrig ur "skickat".
- `POST /api/link/connector/poll` (connector-auth): claimar ägda targets
  atomiskt `UPDATE ... WHERE state='queued' AND leaseExpiresAt < now`
  med bounded lease (60 s); förlorad lease återgår till queued.
- Samma poll ANNONSERAR flottans lista: `{targets:[{id,label}]}`. Worker sparar
  den i `connector_targets` och `GET /api/link/targets` svarar med unionen av
  `LINK_TARGETS` (seedet) och det annonserade. Bridgen skickar listan bara när
  den ändrats, annars en gång i timmen: 65 paneler i varje poll (var 15:e s) är
  386 000 D1-radskrivningar per dygn, mätt, mot 13 000 med regeln. Send
  accepterar varje id i unionen. Bara `agent:pane` får annonseras och bara från
  wsl-connectorn, så en windows-connector kan aldrig annonsera en pane och sedan
  claima dess turer; seedets etiketter vinner.
- Liveness är connectorns, inte panelens: en poll skriver EN heartbeat-rad
  (`target = connectorId`) och varje target läser sin ägares rad. Appens svar är
  oförändrat, en boolean per target. Rader per target från tiden före rad 184
  ligger kvar i tabellen och läses inte.
  En pane som slutar annonseras faller ur listan efter `TARGET_ANNOUNCE_TTL_SECONDS`
  (24 h som default). Varför: telefonens TALK TO visade tre ids ur en
  Cloudflare-variabel medan flottan hade elva paneler (rad 184, 2026-09-17).
- Svarsväntan ligger BREDVID cykeln, en task per clientMessageId (rad 186). Cykeln
  claimar, levererar, ackar och returnerar; pollen och heartbeaten håller sin 15 s-takt
  medan en tyst panel tänker. Ett meddelande som claimas om medan dess task lever får
  ingen andra task, och `REPLY_TIMEOUT_SECONDS` på workern äger uppgivandet: en task som
  tar slut rapporterar ingenting, och reclaim-vägen lägger tillbaka meddelandet i queued.
  En omstart adopterar delivered-men-obesvarade ur journalen precis som förut. Varför:
  en obesvarad tur till en panel höll hela connectorn i 20 minuter, så alla andra paneler
  väntade och heartbeaten dog under tiden (mätt 2026-09-17, 23:1x).
- Connector journalför lokalt FÖRE `ack`. `ack` skickas först efter den
  durable amux-köns exakta ingest-kvitto; kö-cancel, vägrad enqueue eller
  kvittotimeout lämnar mailbox-leasen oackad och återvinningsbar. `ack` markerar delivered;
  `reply {body}` markerar replied, idempotent per clientMessageId.
- Journalen är connectorns minne, mailboxen är det telefonen läser. När de säger
  olika saker lagar claimen mailboxen (rad 187): säger journalen `delivered` men
  raden saknar `deliveredAt` så ackas den igen, och säger journalen `replied`
  medan raden inte gör det postas svaret om ur journalen, som därför sparar
  svarstexten FÖRE sin post av samma skäl som leveransen journalförs före acken.
  Att acka om är inte att leverera om: inget skrivs till panelen. Varför: en
  förlorad ack lämnar raden oackad, och workern vägrar (409) ett svar på en
  oackad rad, så panelens riktiga svar dog medan turen claimades om i all
  oändlighet (Mattias "hej" till lsrc:3, 377 försök på nio timmar, mätt
  2026-09-18).
- Ett meddelande som claimats `MAX_DELIVERY_ATTEMPTS` gånger (5 som default) och
  ligger i `queued` failas av workern med `no-reply-after-<n>-attempts`. Ett
  försök kostar ett helt svarsfönster, så fem är ungefär en timmes tålamod. Bara
  en `queued`-rad avslutas; en som är ute hos en connector just nu kan fortfarande
  besvaras. Varför: utan ett golv har en tur ingen terminal state alls, och appen
  visar "pending" för evigt för något som aldrig kommer.
- Tappat svar återlevererar samma messageId vid nästa poll; aldrig nytt jobb (D).
- `GET /api/link/events` (session): SSE eller bounded poll (`?after=<seq>`);
  återanslutning med samma `after` dubblerar inte playback/kvitton.
  Mailboxens sekvens-sanning är alltid äldst först i seq-ordning (exact-once)
  och ändras aldrig.
- Uppspelningsprioritet är en app-nivå-regel ovanpå sekvensen, inte en
  mailbox-ändring: (a) levande direkta svar spelas FIFO inom sin klass,
  (b) generiskt amux-say/broadcast har lägre prioritet, (c) vid
  återanslutning/recovery spelas ALDRIG ett gammalt backlog automatiskt —
  varje svar bevaras i tidslinjens event-ordning, äldre återfunnet ljud
  markeras ärligt som tillgängligt/skippat, och högst det nyaste giltiga
  (icke-utgångna) direkta svaret spelas upp automatiskt.
- Heartbeat per connector/target var 30:e s → appen visar online/offline
  ärligt (target offline = queued, inte failed).
- Delivered-utan-reply är inte terminal: äldre än `REPLY_TIMEOUT_MS` (10 min)
  återgår meddelandet till queued. Pane-jobbet dedupliceras av samma
  idempotency key, och reply är idempotent per clientMessageId.

## Voice (S3)

Inspelningen har ingen tidsgräns i appen och avbryts aldrig tyst efter 60 s.
Public Link-uploaden har i stället en auktoritativ bytegräns på 5 MiB till
`link-voice` (R2, privat, signed by Worker). Appen visar en varning från 80 %
men fortsätter spela in tills användaren släpper. Om filen då är större än
5 MiB misslyckas sändningen synligt utan trunkering eller fabricerad acceptans.
`send` köar referensen; connector laddar ner, transkriberar via befintlig
kedja (windows-transcribe/bridge), reply innehåller transcript + svar.
Audio raderas vid terminal retention (replied/failed + 24 h).
Android TTS är V1-uppspelning; server-MP3 optional fallback.

## Threat model

- **Stulen session:** opaque token (sha256-lagrad), revokerbar, 30 d,
  Keystore på enheten. Byte vid stöld: `/auth/revoke`.
- **Replay/idempotens:** clientMessageId PK; connector-journal före ack;
  engångskod single-use + TTL; SSE after-seq.
- **Obehörig Google-identitet:** allowlist i D1; bind en gång; authz
  identityId-only; neutral 403 (E).
- **DoS/kostnad:** separata minutgränser per session + Cloudflare-käll-IP på
  send/upload och per connector + käll-IP på poll, med löpande rensning av
  gamla buckets; bounded bodies
  (16 KB text, 5 MB audio); lease-bounded claims; bounded SSE (30 s + reconnect).
- **Connector-kapning:** separata credentials per connector (wsl/windows),
  0600/Credential Manager lokalt, scope: endast egna targets.
- **Publik data:** mailboxen lagrar endast meddelanden till agenterna + ttl;
  voice i privat R2, aldrig publika URL:er; loggar utan bodies/secrets.
- **Hela hosten nere:** allt ligger kvar i D1; exact-once drain efter boot (C).
  Appen visar OFFLINE ärligt, ingen falsk ACK.

## Ops-förkrav (människa/ägare)

1. Registrera en confidential klient hos identitetsleverantören och sätt callback
   till `<LINK_PUBLIC_ORIGIN>/auth/callback`.
2. Kopiera `link/wrangler.toml.example` till den ignorerade lokala
   `link/wrangler.toml`, fyll i egna D1/R2-resurser, `LINK_AUTH_ORIGIN`,
   `LINK_AUTH_CALLBACK_URL`, `LINK_AUTH_APP_ID` och connector-targets.

   **Deploy-kontraktet för Workern, i denna ordning** (2026-09-17: en deploy av
   master utan steg b tog Link ner i tretton minuter, 401 på varje connector-poll):
   a. `link/wrangler.toml` ska ligga i den kanoniska checkouten, aldrig i en
      branch-worktree som kan städas bort. Filen är gitignorerad.
   b. `CONNECTOR_TARGETS_WSL` och `CONNECTOR_TARGETS_WINDOWS` MÅSTE finnas på
      Workern (vars eller `wrangler secret put`). `requireConnector` returnerar
      401 när källans lista är tom, och en Worker som deployas utan dem svarar
      401 på varje poll även om tokens stämmer.
   c. `wrangler deploy`, och vid schemaändring `wrangler d1 execute <db>
      --remote` med den nya tabellen FÖRE deployen.
   d. Verifiera med bridgens egen token att `POST /api/link/connector/poll`
      svarar 200 innan bridgen rörs. Rulla annars tillbaka med
      `wrangler rollback --version-id <föregående>`.
   e. FÖRE `kill -USR2` på bridgen: `amux doctor` måste skriva
      `bridge process  pid <n>, supervised by start.sh`. USR2 är exit 75, och
      bara en start.sh-supervisor startar om processen efter den koden. Säger
      doctor `manual` eller visar ingen supervisor, så STANNA och fråga:
      då avslutar USR2 bridgen i stället för att starta om den, och en
      foreground-bridge ägs av människans terminal (2026-09-17 23:28: USR2 mot
      en manuell bridge utan supervisor tog ner hela flottan i sju minuter, och
      medan den låg nere gick inget meddelande fram, varken till en panel eller
      till Discord, så ingen kunde tillfrågas).
   Produktion kör bara mergad master, och deployen görs från den kanoniska
   checkouten.
3. Lägg in `LINK_AUTH_CLIENT_SECRET`, `LINK_AUTH_STATE_SECRET`,
   `CONNECTOR_TOKEN_WSL` och `CONNECTOR_TOKEN_WINDOWS` som Worker-secrets.
4. Koppla valfri privat HTTPS-domän till Workern, eller använd den isolerade
   `workers.dev`-adressen för en egen testinstallation.
5. Allowlist-seed: identityId(r) för tillåtna människor i D1.

## Acceptans → mappning

A login+targets (S2), B PTT exakt en leverans + svar + TTS (S3),
C WSL-down queued + drain exakt en gång (S4), D connector-restart utan
dubbletter (S4), E nekad identitet (S1), F inga secrets i APK/log +
revokation (S1), G Tailscale-fallback orörd (S2).
