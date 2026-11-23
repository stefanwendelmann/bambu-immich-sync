<p align="center">
  <a href="https://bambulab.com/" title="Bambu Lab">
    <img src="https://upload.wikimedia.org/wikipedia/commons/f/f4/BambuLab_logo.svg" alt="Bambu Lab" width="220">
  </a>
  &nbsp;&nbsp;→&nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/docs/assets/video-sync.svg" alt="Timelapse-Video wird synchronisiert" width="100">
  &nbsp;&nbsp;→&nbsp;&nbsp;
  <a href="https://immich.app/" title="Immich">
    <img src="https://raw.githubusercontent.com/immich-app/immich/main/design/immich-logo.svg" alt="Immich" width="100">
  </a>
</p>

<h1 align="center">Bambu Immich Sync</h1>

<p align="center">Fertige Bambu-Lab-Zeitraffer automatisch und sicher in ein Immich-Album übertragen.</p>

> **Hinweis:** Dieses Community-Projekt ist unabhängig. Bambu Lab und Immich unterstützen oder betreiben es nicht.

## Was macht das Programm?

Der Container verbindet sich im lokalen Netzwerk per FTPS mit einem Bambu-Lab-Drucker. Er wartet, bis eine MP4-Datei vollständig geschrieben wurde, lädt sie herunter und importiert sie mit dem offiziellen Immich CLI in dein Immich-Konto und das gewünschte Album.

- Es werden nur fertige Timelapse-MP4-Dateien verarbeitet.
- `tmp.video`, Vorschaubilder und 3MF-Dateien werden ignoriert.
- Die Originaldatei auf dem Drucker wird niemals verändert oder gelöscht.
- Der lokale Status und die Videos bleiben bei Neustarts im Ordner `data` erhalten.
- Immich erkennt bereits hochgeladene Videos anhand ihres Inhalts, damit Wiederholungen keine unnötigen Duplikate erzeugen.

Getestet mit einem Bambu Lab P2S und Immich. Andere Druckermodelle und Dateiablagen sind noch nicht verifiziert.

## Installation mit Docker Desktop (Windows)

### 1. Voraussetzungen

- Docker Desktop ist installiert und gestartet.
- Der Drucker ist im Netzwerk erreichbar und FTPS auf Port `990` ist nicht durch Firewall oder VLAN-Regeln blockiert.
- Dein Immich-Server ist aus dem Docker-Container erreichbar.
- Du hast den lokalen LAN-Zugriffscode des Druckers und einen Immich-API-Key.

### 2. Projektordner und Konfiguration anlegen

Öffne PowerShell und führe diese Befehle aus:

```powershell
New-Item -ItemType Directory -Force bambu-immich-sync | Out-Null
Set-Location bambu-immich-sync
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/compose.yaml" `
  -OutFile "compose.yaml"
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/.env.example" `
  -OutFile ".env"
notepad .env
```

Trage in der geöffneten `.env` mindestens diese Werte ein:

```dotenv
BAMBU_HOST=IP-ODER-DNS-DES-DRUCKERS
BAMBU_ACCESS_CODE=DEIN-LAN-ZUGRIFFSCODE
IMMICH_INSTANCE_URL=https://DEIN-IMMICH-HOST/api
IMMICH_API_KEY=DEIN-IMMICH-API-KEY
IMMICH_ALBUM_NAME=Bambu Timelapses
```

Die übrigen Einstellungen kannst du zunächst auf den Vorgabewerten lassen. Speichere die Datei und schließe den Editor.

**Zugangsdaten bleiben privat:** Trage sie nur in die lokale `.env` ein. Nicht in GitHub, Screenshots oder Chat-Nachrichten kopieren. Die `.env` wird von Git ignoriert.

#### Immich-API-Key erstellen

Öffne Immich im Browser, gehe in deine Kontoeinstellungen zu **API Keys** und erstelle einen Key für diesen Sync. Verwende die Berechtigungen, die Uploads sowie das Lesen und Zuordnen von Assets zu Alben erlauben. Kopiere den Key direkt in `.env`; er wird später nicht erneut vollständig angezeigt.

#### Einstellungen

| Variable | Bedeutung |
|---|---|
| `BAMBU_HOST` | IP-Adresse oder DNS-Name des Druckers |
| `BAMBU_ACCESS_CODE` | Lokaler LAN-Zugriffscode des Druckers |
| `BAMBU_FTPS_PORT` | FTPS-Port; Standard `990` |
| `BAMBU_REMOTE_PATH` | Druckerordner mit Videos; Standard `/timelapse` |
| `BAMBU_TLS_VERIFY` | Zertifikatsprüfung; Standard `false`, siehe Sicherheitshinweis unten |
| `IMMICH_INSTANCE_URL` | Immich-API-Adresse, üblicherweise mit `/api` am Ende |
| `IMMICH_API_KEY` | API-Key des Immich-Kontos, in das importiert werden soll |
| `IMMICH_ALBUM_NAME` | Zielalbum; wird bei Bedarf angelegt |
| `SYNC_INTERVAL` | Abstand zwischen Prüfungen in Sekunden; Standard `300` |
| `DELETE_LOCAL_AFTER_UPLOAD` | `true` löscht nur die lokale Videokopie nach bestätigtem Upload; Standard `false` |

### 3. Container starten

Im selben PowerShell-Fenster und Ordner:

```powershell
docker compose pull
docker compose up -d
```

Docker lädt das veröffentlichte Image `stefanwendelmann/bambu-immich-sync:latest`. Der Container startet danach automatisch erneut, falls er unerwartet beendet wird.

### 4. Logs und erfolgreichen Import prüfen

```powershell
docker compose logs -f --tail 50
```

Beim Start sollte ein `discovered`-Eintrag erscheinen. Eine Datei wird erst importiert, wenn sie bei mindestens zwei Prüfungen über die Stabilitätsfrist unverändert geblieben ist. Mit dem Standardintervall kann das bis zu etwa fünf Minuten oder länger dauern. Beim erfolgreichen Import erscheinen `upload_start` und `upload_complete`.

Mit `Ctrl+C` beendest du nur die Log-Anzeige, nicht den Container. Den Containerstatus kannst du so prüfen:

```powershell
docker compose ps
```

### 5. Container verwalten

```powershell
# Logs erneut anzeigen
docker compose logs -f --tail 50

# Container stoppen; Daten und Status bleiben erhalten
docker compose down

# Wieder starten
docker compose up -d

# Image aktualisieren und Container neu erstellen
docker compose pull
docker compose up -d
```

Videos, die noch nicht erfolgreich übertragen wurden, und der Synchronisationsstatus liegen dauerhaft unter `.\data`. Plane genügend Speicherplatz ein. Mit `DELETE_LOCAL_AFTER_UPLOAD=true` werden Videos nach erfolgreichem Upload aus dem lokalen Cache entfernt. Auf dem Drucker wird niemals etwas gelöscht.

## Installation mit Docker Compose (Linux/macOS)

```sh
mkdir -p bambu-immich-sync
cd bambu-immich-sync
curl -fsSLO https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/.env.example -o .env
${EDITOR:-nano} .env
docker compose pull
docker compose up -d
docker compose logs -f --tail 50
```

Passe vor dem Start dieselben Pflichtwerte wie oben in `.env` an.

## Sicherheit und bekannte Einschränkungen

- `BAMBU_TLS_VERIFY=false` akzeptiert das selbstsignierte Druckerzertifikat ohne Identitätsprüfung. Nutze das nur in einem vertrauenswürdigen privaten Netzwerk. Den FTPS-Port des Druckers niemals öffentlich ins Internet freigeben.
- Unterstützt wird derzeit implizites FTPS auf Port `990`; getestet wurde der Bambu Lab P2S. Die Verbindung verwendet TLS 1.2 und SNI.
- Bei Immich muss die URL aus dem Container erreichbar sein. Ein Docker-interner Name wie `immich-server` funktioniert nur, wenn beide Container ein gemeinsames Docker-Netzwerk verwenden.
- Die Stabilitäts- und Metadatenprüfungen verringern das Risiko einer Übertragung während des Schreibens. FTP-Metadaten können jedoch eine Änderung mit gleicher Größe und gleichem Zeitstempel nicht kryptografisch ausschließen.

## Fehlerbehebung

**Der Container startet nicht:** Prüfe, dass alle Pflichtwerte in `.env` gesetzt sind. Fehlermeldungen zeigt `docker compose logs --tail 100`.

**Drucker nicht erreichbar:** Prüfe DNS/IP-Adresse, Port `990`, den LAN-Zugriffscode und Netzwerk-/Firewallregeln zwischen Docker und Drucker.

**Immich nicht erreichbar oder Upload abgelehnt:** Prüfe `IMMICH_INSTANCE_URL`, einschließlich `/api`, sowie API-Key und Berechtigungen des richtigen Immich-Kontos.

**Noch kein Upload im Album:** Ein neu entdecktes Video muss erst die Stabilitätsfrist abwarten. Prüfe danach erneut die Logs auf `upload_complete`.

**Konfiguration geändert:** Container mit `docker compose up -d --force-recreate` neu erstellen.

## Logo und Marken

Das Bambu-Lab-Logo stammt von [Lwde über Wikimedia Commons](https://commons.wikimedia.org/wiki/File:BambuLab_logo.svg) und ist unter [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) lizenziert. Das Immich-Logo wird direkt aus dem [offiziellen Immich-Projekt](https://github.com/immich-app/immich/blob/main/design/immich-logo.svg) eingebunden. Beide Markenlogos werden getrennt und nur zur Kennzeichnung der Kompatibilität gezeigt; Markenrechte verbleiben bei den jeweiligen Inhabern.

## Für Entwickler

```sh
npm ci
npm test
```

- Docker-Image: [`stefanwendelmann/bambu-immich-sync`](https://hub.docker.com/r/stefanwendelmann/bambu-immich-sync)
- Quellcode und Releases: [GitHub](https://github.com/stefanwendelmann/bambu-immich-sync)
