# EMC Social Media Planer

Installierbare Web-App für macOS, Windows, Android und iOS. Beiträge mit Text und Bild vorbereiten, Plattformen auswählen, Termine im Monatskalender planen und Entwürfe bearbeiten. Die App funktioniert nach dem ersten Online-Aufruf auch offline.

## Zugriff und Installation

Nach der Veröffentlichung über GitHub Pages: **https://muckelelias47-ops.github.io/EMC-SocialMediaPlaner/**

- **iPhone/iPad:** In Safari öffnen → Teilen → Zum Home-Bildschirm → Hinzufügen.
- **Android:** In Chrome öffnen → Menü → App installieren / Zum Startbildschirm hinzufügen.
- **Windows/macOS:** In Chrome oder Edge öffnen → Installationssymbol in der Adressleiste. Auf aktuellen macOS-Versionen kann Safari über Ablage → Zum Dock hinzufügen verwendet werden.
- Ohne Installation in einem aktuellen Browser nutzbar.

Dies ist eine PWA, keine Veröffentlichung im App Store oder Play Store. Offline-Nutzung und Installation setzen beim ersten Aufruf eine HTTPS-Adresse voraus.

## Daten und Funktionen

Die Beiträge werden ausschließlich im lokalen Browserprofil gespeichert. Es gibt keinen Login und keine automatische Synchronisierung zwischen Geräten. Unter „Datensicherung“ lassen sich Beiträge als JSON exportieren und auf einem anderen Gerät importieren. Ein Import ersetzt die lokale Planung nach Bestätigung. Vor dem Löschen von Browserdaten eine Sicherung exportieren. Bilder werden beim Hinzufügen verkleinert; der Browser kann den lokalen Speicher begrenzen.

„Geplant“ ist ein manueller Planungstermin. Die App veröffentlicht keine Beiträge automatisch und verbindet sich nicht mit Social-Media-Konten. „Veröffentlicht“ wird von dir gesetzt. Automatisches Veröffentlichen, gemeinsame Teams und Gerätesynchronisierung benötigen eine separate Backend- und API-Anbindung.

## Lokal entwickeln

Node.js 22 oder neuer:

```sh
cd /workspace/EMC-SocialMediaPlaner
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
npm start
```

Der Entwicklungsserver läuft auf Port 4173. Er liefert nur die App-Dateien aus, keine Git-Metadaten oder Testdateien. Andere Ports mit `PORT=8080 npm start`. Keine zusätzlichen Konten, Datenbanken oder Secrets nötig.

```sh
npm test
npm run build
npm run test:e2e
```

Die Browsertests verwenden unter Linux `/usr/bin/chromium`, falls vorhanden. Alternativ `npx playwright install chromium` und die Playwright-Konfiguration verwenden. Mit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` kann ein vorhandener Chromium-Pfad angegeben werden. Das Build erzeugt in `dist/` ausschließlich die öffentlichen Dateien.

## Veröffentlichung

In GitHub unter Repository → Settings → Pages die Quelle **GitHub Actions** auswählen. Der Workflow `.github/workflows/pages.yml` prüft die Datenlogik, erstellt das statische Build und veröffentlicht bei Änderungen auf `main`. Alternativ lässt sich der Workflow „App veröffentlichen“ unter Actions manuell starten.

Für andere statische HTTPS-Hosts den Inhalt von `dist/` hochladen. Relative Assetpfade unterstützen auch Unterverzeichnisse. Nach Änderungen an Offline-Assets die Cache-Version in `sw.js` erhöhen und erneut veröffentlichen. Kein Cloud-Umgebungs-Snapshot wird durch das Veröffentlichen der App ersetzt.
