# Agentmux Link Internet V1 — kontrakt och threat model

Mål: Agentmux Link (Android) ska fungera över vanligt internet utan Tailscale,
offentlig hem-IP eller port-forwarding. En publik mailbox på `link.v1d.io`
är den enda publika ytan; WSL och Windows ansluter utåt som connectors.

Icke-mål i V1: inga roller/membership i v1d-auth, inga Suggestions-tickets,
ingen ny scheduler/supervisor, ingen publik ingress hemma, ingen autonom
destruktiv restart (gäller #198/#199 redan).

## Komponenter

- **Link-tjänsten** (Cloudflare Worker + D1 `link_mailbox` + R2 `link-voice`):
  mailbox, auth, sessioner, heartbeats. Äger inga agentdata.
- **Appen** (Android): Custom Tab-login, PKCE, Keystore-session, chat/PTT,
  ärlig status (queued/online/offline).
- **WSL-connector** (`channels/link-connector.mjs` i bryggan): pollar utåt,
  claimar targets den äger (t.ex. lsrc:3, lsrc:10), levererar via durable
  amux-kö (messageId som idempotency key), postar reply.
- **Windows-connector** (i Windows-managerns runtime): samma kontrakt för
  target=windows; lever när WSL är död. Konsument, aldrig publik ingress.

## Auth (två ben)

1. **Link ↔ v1d-auth** (befintligt flöde, samma som skybar):
   `/authorize?app_id&redirect_uri=https://link.v1d.io/auth/callback&state&code_challenge(S256)`
   → Google → callback `code` → POST `/token` (redirect_uri + code + verifier)
   → principal (identityId, verifiedEmail). State är förseglad cookie.
   Link är confidential klient; hemligheten är Worker-secret, aldrig i APK.
2. **App ↔ Link**: appen genererar egen PKCE. `/auth/start?challenge&client=android`
   startar ben 1. Efter callback utfärdar Link en kortlivad engångskod
   (`code`, ≤60 s, single-use) som returneras via verifierad Android App Link
   (https://link.v1d.io/auth/app-return) eller custom scheme `agentmux://auth`.
   Appen byter `code` + sin verifier mot `/auth/exchange` → opaque
   Link-session (30 d, revokerbar). Sessionen lagras i Android Keystore.

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
- Connector journalför lokalt FÖRE `ack`. `ack` skickas först efter den
  durable amux-köns exakta ingest-kvitto; kö-cancel, vägrad enqueue eller
  kvittotimeout lämnar mailbox-leasen oackad och återvinningsbar. `ack` markerar delivered;
  `reply {body}` markerar replied, idempotent per clientMessageId.
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

1. v1d-auth: registrera klient `agentmux-link` + callback
   `https://link.v1d.io/auth/callback` (samma ställe som skybars registrering).
2. `wrangler secret put V1D_AUTH_CLIENT_SECRET` (+ `CONNECTOR_TOKEN_WSL`,
   `CONNECTOR_TOKEN_WINDOWS`) på link-projektet.
3. DNS `link.v1d.io` → Worker (custom domain eller pages.dev-substitut i dev).
4. Allowlist-seed: identityId(r) för tillåtna människor i D1.

## Acceptans → mappning

A login+targets (S2), B PTT exakt en leverans + svar + TTS (S3),
C WSL-down queued + drain exakt en gång (S4), D connector-restart utan
dubbletter (S4), E nekad identitet (S1), F inga secrets i APK/log +
revokation (S1), G Tailscale-fallback orörd (S2).
