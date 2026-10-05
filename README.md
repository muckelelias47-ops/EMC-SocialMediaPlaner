# EMC Social Media Planer

Installierbare Web-App für macOS, Windows, Android und iOS. Beiträge mit Text und Bild vorbereiten, Kategorien mit Farben verwalten, konkrete Kanäle zuordnen, Termine im Monatskalender planen und Entwürfe bearbeiten. Die App funktioniert nach dem ersten Online-Aufruf auch offline. Mehrere Website-Adressen lassen sich direkt hinterlegen; echte Social-Media-Anmeldungen nutzen den separaten [Verbindungsdienst](server/README.md).

## Zugriff und Installation

Nach der Veröffentlichung über GitHub Pages: **https://muckelelias47-ops.github.io/EMC-SocialMediaPlaner/**

- **iPhone/iPad:** In Safari öffnen → Teilen → Zum Home-Bildschirm → Hinzufügen.
- **Android:** In Chrome öffnen → Menü → App installieren / Zum Startbildschirm hinzufügen.
- **Windows/macOS:** In Chrome oder Edge öffnen → Installationssymbol in der Adressleiste. Auf aktuellen macOS-Versionen kann Safari über Ablage → Zum Dock hinzufügen verwendet werden.
- Ohne Installation in einem aktuellen Browser nutzbar.

Dies ist eine PWA, keine Veröffentlichung im App Store oder Play Store. Offline-Nutzung und Installation setzen beim ersten Aufruf eine HTTPS-Adresse voraus.

## Daten und Funktionen

Beiträge, Kategorien und Website-Adressen werden im lokalen Browserprofil gespeichert. Es gibt keine automatische Synchronisierung der Planung zwischen Geräten. Unter „Arbeitsbereich“ lassen sich diese Daten als JSON exportieren und auf einem anderen Gerät importieren. Alte Sicherungen werden verlustfrei eingelesen. Ein Import ersetzt die lokale Planung, Kategorien und Website-Adressen nach Bestätigung. Social-Media-Tokens und Dienst-Sitzungen werden niemals exportiert. Vor dem Löschen von Browserdaten eine Sicherung exportieren. Bilder werden beim Hinzufügen verkleinert; der Browser kann den lokalen Speicher begrenzen.

Unter „Meine Kanäle“ kann ein eigener, öffentlich gehosteter OAuth-Dienst eingerichtet werden. Facebook/Instagram, TikTok, LinkedIn, YouTube, Pinterest und X verfügen über serverseitige Adapter für mehrere Konten. Dafür fehlen zunächst noch die eigenen Plattform-Apps, ihre Freigaben und das Hosting. Die Oberfläche zeigt nur tatsächlich abgerufene Konten als verbunden. Website-Adressen sind ausdrücklich als hinterlegte Adressen gekennzeichnet, ohne Website-API-Anmeldung. Einrichtung und Grenzen: [server/README.md](server/README.md).

„Geplant“ ist ein manueller Planungstermin. Die App veröffentlicht keine Beiträge automatisch. „Veröffentlicht“ wird von dir gesetzt. Der Verbindungsdienst ermöglicht die Konto-Anmeldung und Kontoerkennung; automatisches Veröffentlichen, gemeinsame Teams und Gerätesynchronisierung benötigen weitere Dienste und Plattformberechtigungen.

## Lokal entwickeln

Node.js 24 oder neuer:

```sh
cd /workspace/EMC-SocialMediaPlaner
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
npm start
```

Der Entwicklungsserver läuft auf Port 4173. Er liefert nur die App-Dateien aus, keine Git-Metadaten oder Testdateien. Andere Ports mit `PORT=8080 npm start`. Für die lokale Planung sind keine zusätzlichen Konten, Datenbanken oder Secrets nötig. Für direkte Social-Media-Anmeldungen zusätzlich den [Verbindungsdienst einrichten](server/README.md).

```sh
npm test
npm run build
npm run test:e2e
```

Die Browsertests verwenden unter Linux `/usr/bin/chromium`, falls vorhanden. Alternativ `npx playwright install chromium` und die Playwright-Konfiguration verwenden. Mit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` kann ein vorhandener Chromium-Pfad angegeben werden. Das Build erzeugt in `dist/` ausschließlich die öffentlichen Dateien.

## Veröffentlichung

In GitHub unter Repository → Settings → Pages die Quelle **GitHub Actions** auswählen. Der Workflow `.github/workflows/pages.yml` prüft die Datenlogik, erstellt das statische Build und veröffentlicht bei Änderungen auf `main`. Alternativ lässt sich der Workflow „App veröffentlichen“ unter Actions manuell starten.

Für andere statische HTTPS-Hosts den Inhalt von `dist/` hochladen. Relative Assetpfade unterstützen auch Unterverzeichnisse. Nach Änderungen an Offline-Assets die Cache-Version in `sw.js` erhöhen und erneut veröffentlichen. Kein Cloud-Umgebungs-Snapshot wird durch das Veröffentlichen der App ersetzt.
