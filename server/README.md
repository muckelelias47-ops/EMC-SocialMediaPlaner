# Direkte Konto-Verknüpfung aktivieren

Die GitHub-Pages-Webseite läuft bereits ohne einen Server. Sie kann Kategorien, Beiträge und Website-Adressen lokal verwalten. Für echte Social-Media-Anmeldungen braucht sie diesen zusätzlich gehosteten Node.js-Dienst und Entwickler-Apps bei den Plattformen. Das Repository oder eine Website-Adresse allein erteilt keinen Kontozugriff.

## 1. Dienst mit HTTPS und dauerhaftem Speicher bereitstellen

Auf einem Node.js-24-Host aus dem Repository starten:

```sh
npm run start:channels
```

Der Dienst benötigt keine npm-Laufzeitabhängigkeiten. Für Container gibt es `server/Dockerfile` (Build-Kontext: Repository-Wurzel). `/data` muss ein dauerhaftes Volume sein. Plattform-Apps und verschlüsselte Kontodaten dürfen nicht in einem bei jedem Neustart verlorenen Dateisystem liegen. Bei Serverless-Hosts ohne dauerhaftes Dateisystem ist stattdessen zuerst ein Datenbank-Adapter erforderlich.

In den **sicheren Umgebungs-/Secret-Einstellungen des Hosts** setzen:

- `PUBLIC_BASE_URL`: die HTTPS-Adresse des Diensts, nur Origin, beispielsweise die vom Host zugeteilte Adresse.
- `FRONTEND_ORIGIN`: `https://muckelelias47-ops.github.io`.
- `CHANNEL_ENCRYPTION_KEY`: kryptografisch zufälliger 32-Byte-Schlüssel, als kanonisches Base64 (44 Zeichen einschließlich `=`). Dieser Schlüssel wird lokal zum Entschlüsseln gebraucht; ein Netzwerk-Proxy-Platzhalter eignet sich dafür nicht. Einen Secret-Generator des Hosts mit dieser Ausgabe verwenden. Nicht in Chat, Git oder Builds übernehmen.
- `DATA_DIR`: absoluter Pfad zum dauerhaften Speicher.
- `PORT`: vom Host vorgegebener Port; standardmäßig 8787.

Den Schlüssel bei Neustarts beibehalten und verschlüsselte Daten zusammen mit dem Schlüssel getrennt sichern. Bei einer Änderung des Schlüssels können bestehende Daten nicht mehr entschlüsselt werden. Eine lokale Konfiguration kann in der ignorierten `server/.env` liegen; `server/.env.example` enthält ausschließlich leere Anforderungen.

`GET /health` prüft die Erreichbarkeit. `GET /api/config` liefert die tatsächliche Konfigurationsbereitschaft und fehlende Variablennamen, keine geheimen Werte. Ein erfolgreicher Healthcheck beweist noch keine freigeschaltete Plattform-Anmeldung.

## 2. Plattform-Apps konfigurieren

Nur die gewünschten Anbieter konfigurieren; die übrigen bleiben deaktiviert. In jeder Entwickler-App als Rückleitung die **exakte** Adresse des Diensts plus den folgenden Callback-Pfad eintragen. Benötigte Produkte und Berechtigungen müssen bei der jeweiligen Plattform freigeschaltet sein.

| Plattform | Sichere Host-Variablen | Callback-Pfad | Zugriff dieser Version |
| --- | --- | --- | --- |
| Facebook / Instagram | `META_APP_ID`, `META_APP_SECRET` | `/oauth/meta/callback` | Facebook-Seiten und damit verknüpfte professionelle Instagram-Konten; `pages_show_list`, `pages_read_engagement`, `instagram_basic` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `/oauth/tiktok/callback` | Login Kit; `user.info.basic`, `user.info.profile` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | `/oauth/linkedin/callback` | „Sign In with LinkedIn using OpenID Connect“; `openid`, `profile`; persönliche Konten, keine Organisationsseiten |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `/oauth/youtube/callback` | Web-OAuth-Client, aktivierte YouTube Data API; `youtube.readonly`; freigegebene Kanäle/Brand Accounts |
| Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | `/oauth/pinterest/callback` | `user_accounts:read`; Zugang abhängig von der freigeschalteten App |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET` | `/oauth/x/callback` | OAuth 2.0 mit PKCE; `users.read`, `tweet.read`, `offline.access`; benötigter API-Zugriff |

Meta verwendet standardmäßig Graph API `v23.0`; mit `META_GRAPH_VERSION` kann eine unterstützte Version eingestellt werden. Ein Meta-Konto allein reicht für ein privates Instagram-Profil nicht: Der hier implementierte Anmeldeweg setzt ein professionelles Instagram-Konto mit Facebook-Seite voraus. Weitere Konten werden durch erneute Anmeldung/Kontoauswahl hinzugefügt. Dasselbe Konto aktualisiert seine bestehende Verbindung.

Apps im Testmodus können häufig nur für registrierte Tester oder App-Administratoren verwendet werden. Für weitere Nutzer können App-Prüfung, erweiterte Berechtigungen oder eine Verifizierung erforderlich sein. Die aktuelle Implementierung wurde mit simulierten Anbieterantworten geprüft; ohne eigene App-Konfiguration konnte keine reale Plattform-Anmeldung validiert werden.

Entwicklerportale: [Meta](https://developers.facebook.com/), [TikTok](https://developers.tiktok.com/), [LinkedIn](https://www.linkedin.com/developers/), [Google](https://console.cloud.google.com/apis/credentials), [Pinterest](https://developers.pinterest.com/), [X](https://developer.x.com/).

## 3. In der EMC-App verbinden

In **Meine Kanäle → Verbindung einrichten** die HTTPS-Adresse des gestarteten Diensts eintragen. Die Oberfläche prüft seine Konfiguration. Freigeschaltete Anbieter lassen sich anschließend über die offizielle Plattform-Anmeldung verbinden. Die Passwörter der Social-Media-Konten werden niemals in den Planer eingegeben.

Beiträge können einem bestimmten Konto zugeordnet werden. Mehrere Konten derselben Plattform bleiben getrennt. Der Dienst speichert Social-Media-Tokens ausschließlich verschlüsselt; die Oberfläche erhält nur Konto-Metadaten. Im Browser bleibt eine eigene, zufällige Dienst-Sitzung bestehen. Sie ist nicht Teil der JSON-Sicherung. Nach 30 Tagen, bei gelöschtem Browserspeicher oder auf einem weiteren Gerät ist eine erneute Verknüpfung erforderlich. Abgelaufene Plattformfreigaben werden als „Erneut anmelden“ gekennzeichnet. Tokens werden in dieser Version nicht automatisch erneuert.

„Verbindung entfernen“ löscht die Verbindung im Planer. Zusätzlich können Plattformfreigaben in den Einstellungen des jeweiligen Anbieters widerrufen werden.

## Website-Adressen

Mehrere eigene Website-Adressen lassen sich direkt hinzufügen, als Kanal auswählen und in Sicherungen übernehmen. Das ist eine lokale URL-Zuordnung, keine Anmeldung am Website-System und keine Bestätigung der Inhaberschaft. Die App schreibt keine Inhalte in WordPress oder andere Websites. Eine echte Website-API-Anbindung hängt vom eingesetzten System und dessen Zugangsdaten ab.

## Entwicklung und Grenzen

Lokal dürfen `PUBLIC_BASE_URL` und `FRONTEND_ORIGIN` HTTP auf `localhost`/`127.0.0.1` verwenden. Rückleitungen, Berechtigungen und HTTPS-Transport bleiben in Produktion verpflichtend. Bei Netzwerk-Proxys nutzt Node.js 24 `--use-env-proxy`; TLS-Prüfungen bleiben aktiv.

`npm test` prüft die Datenmigration, Anbieteradapter, Zustand/PKCE, Browserbindung, Verschlüsselung, Konto-Isolation, Ablauf und Fehlerfälle. `npm run test:e2e` prüft die Oberfläche sowie den echten Popup-/Server-Ablauf mit einer simulierten Plattform. Es gibt keinen automatischen Publisher, keine Hintergrund-Termine und keine Synchronisierung der lokal gespeicherten Planung. Diese Version fordert dafür auch keine Veröffentlichungsberechtigungen an.
