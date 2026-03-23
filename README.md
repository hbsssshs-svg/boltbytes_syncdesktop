# BoltBytes Sync Desktop

En Electron-baseret desktop-app til Windows/macOS/Linux, der synkroniserer en lokal mappe mod BoltBytes API'et at en mere Nextcloud-lignende måde med login, tray-popup og indstillinger.

## Nyt i denne version

- **Login med `/auth/login`** så brugeren logger ind med e-mail/adgangskode i stedet for manuelt bearer-token.
- **Kompakt tray-popup UI** inspireret af Nextcloud med bund/hjørne-orienteret panel, hurtig status og aktivitet.
- **Settings-sheet med faner** til konto, sync og generelle indstillinger i stedet for et stort råt formularvindue.
- **Windows Stifinder-genvej** i `Links`-mappen, så sync-mappen kan vises i venstre side/Favoritter.

> Vigtigt: Dette er stadig ikke en fuld Windows shell extension som Nextclouds egen dybe Explorer-integration, men en praktisk løsning der giver en fast genvej i Stifinderens favorit/links-område for den lokale sync-mappe.

## Hvad appen gør

- gemmer `baseUrl`, login-session, lokal mappe og Stifinder-genvejsnavn lokalt at maskinen.
- logger ind via `POST /auth/login` med e-mail og adgangskode og gemmer det returnerede access token lokalt til næste start.
- accepterer både site-roden (fx `https://boltbytes.com`) og et swagger/openapi-link (fx `https://boltbytes.com/swagger.yaml`) som base URL og normaliserer det automatisk.
- scanner den valgte lokale mappe rekursivt.
- uploader nye eller ændrede filer via `POST /api/v1/file-entries` med `uploadType=bedrive`, `clientMime`, `clientExtension` og remote destination udledt fra den valgte sky-mappe.
- overvåger lokale ændringer og laver baggrundstjek mod skyen, så sync kan starte automatisk uden at brugeren skal trykke manuelt.
- læser eksisterende entries via `GET /file-entries` og falder tilbage til `GET /drive/file-entries`, scoped til den valgte sky-mappe via `parentId`.
- kan hente filer fra serveren når de mangler lokalt, enten via download-URL at entry'et eller via et download-endpoint baseret at entry-id.
- viser løbende status i appen og i tray-menuen.
- husker sidst synkroniserede lokale mappe, valgte sky-mappe og tidspunkt, så brugeren kan se seneste destination ved næste opstart.
- kan oprette/fjerne en Windows-genvej til sync-mappen i Stifinder.
- skriver en lokal `.boltbytes-sync-state.json` med per-fil syncstatus (`pending`, `uploading`, `downloading`, `synced`, `error`) som fundament for senere Windows Explorer overlay-ikoner.

## Kom i gang

```bash
npm install
npm start
```

## Lav en installer eller portable `.exe`

```bash
npm install
npm run dist:win
npm run dist:portable
```

Når dependencies er installeret, lægger `electron-builder` artefakterne i `dist/`.

Typisk får du blandt andet:

- en **installer `.exe`** via NSIS
- en **portable `.exe`** som kan køres uden klassisk installation

## Opsætning

1. Start appen.
2. Indtast base URL, fx `https://boltbytes.com` eller `https://boltbytes.com/swagger.yaml`.
3. Log ind med din e-mail og adgangskode.
4. Vælg den lokale mappe, hent mapper fra skyen, og vælg den remote mappe hvor filerne skal lægges. Appen viser nu mappenavn i dropdown’en og bruger valget som upload-destination.
5. Vælg navnet at Stifinder-genvejen, fx `BoltBytes Sync`.
6. Klik at **Opret genvej** for at få mappen frem i venstre side/Favoritter.
7. Brug **Sync nu** i popupen eller tray-menuen.

## Arkitektur

- `src/main.js`: Electron main process, kompakt popup-vindue, tray, login-flow, Explorer-genvej, IPC og sync-orkestrering.
- `src/preload.js`: sikker bro mellem UI og main process inkl. login/logout IPC.
- `src/renderer.html` + `src/renderer.js`: kompakt Nextcloud-inspireret popup-UI med aktivitetspanel, settings-sheet og valg af remote sky-mappe.
- `src/api-client.js`: BoltBytes API-klient med `/auth/login`, automatisk normalisering af swagger/openapi-URL'er, fallback mellem `/api`, `/api/v1` og site-roden, samt upload via `/file-entries`.
- `src/sync-engine.js`: filscanning og upload/download-logik med live events.

## Begrænsninger

- Explorer-genvejen er kun automatiseret for **Windows**.
- Startup/notifikationsindstillingerne er stadig UI-præferencer i denne version; autostart er endnu ikke koblet til OS-specifik registrering.
- Realtime lokal overvågning afhænger af platformens `fs.watch`; hvis den ikke understøttes fuldt, falder klienten tilbage til polling.
- Det er ikke en ægte shell namespace extension eller placeholder-filsystem som Nextcloud Files On-Demand.
- Rigtige små sky-/timeglas-overlays i Windows Stifinder kræver en native Windows shell overlay extension; denne Electron-klient gemmer nu statusdata, men registrerer endnu ikke en sådan native Explorer-extension.
- Download-synkronisering er bevidst konservativ og henter kun filer der mangler lokalt; den virker kun hvis API'et samtidig returnerer en brugbar download-URL i file-entry-data.
