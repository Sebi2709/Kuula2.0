# Kuula 2.0 – eigene 360°-Rundgänge

Selbst gehostete Alternative zu Kuula: 360°-Panoramen als Rundgang mit Szenen-Links
und Info-Punkten anzeigen – als rein statische Website, die kostenlos auf
GitHub Pages, Cloudflare Pages oder Netlify läuft. Kein Server, keine Datenbank,
kein Build-Schritt.

Der Viewer basiert auf [Pannellum](https://pannellum.org/) (MIT-Lizenz, liegt in `vendor/`).

## Aufbau

| Datei / Ordner       | Zweck                                                      |
| --------------------- | ---------------------------------------------------------- |
| `public/index.html`   | Übersicht aller Touren mit Link & Embed-Code               |
| `public/view.html`   | Der eigentliche Rundgang (auch zum Einbetten per iframe)   |
| `public/editor.html` | Visueller Editor: Panoramen hinzufügen, Hotspots setzen    |
| `public/tours/index.json` | Liste der Touren                                           |
| `public/tours/<id>/` | `tour.json` + Panorama-Bilder einer Tour                   |

## Neue Tour anlegen

1. Website öffnen (lokal oder online) → **Tour erstellen / bearbeiten**.
2. Titel, Firma und ID (wird Teil der URL) eintragen.
3. **Panoramen hinzufügen** – equirektangulare 360°-Bilder (2:1). Bilder über
   8192 px Breite werden automatisch verkleinert, damit sie auch auf Handys laden.
4. Szene auswählen, oben **Szenen-Link** oder **Info-Punkt** klicken und ins Bild klicken.
   Links zu anderen Szenen, Texte und URLs stellst du links in der Liste ein.
5. Optional: **Aktuellen Blick als Start** setzen, **Als Startszene** markieren.
6. **▶ Vorschau** testet den Rundgang inklusive Navigation.
7. **Tour als ZIP exportieren** → ZIP im Ordner `public/` entpacken (überschreibt
   `tours/index.json`), dann committen und pushen. Nach ~1 Minute ist die Tour online.

Für reine Hotspot-Änderungen an einer bestehenden Tour reicht **Nur tour.json** –
die Datei einfach in `tours/<id>/` ersetzen.

## Lokal starten

```bash
python3 -m http.server 8000 -d public
# → http://localhost:8000
```

(Ein Doppelklick auf die HTML-Datei reicht nicht, da der Browser dann `fetch` blockiert.)

## Einbinden auf der Firmen-Website

In der Übersicht auf **Embed-Code** klicken, oder:

```html
<iframe src="https://<deine-domain>/view.html?tour=firma-a-showroom"
        width="100%" height="600" style="border:0"
        allow="fullscreen; accelerometer; gyroscope" allowfullscreen loading="lazy"></iframe>
```

URL-Optionen für `view.html`:

| Parameter        | Wirkung                                  |
| ---------------- | ---------------------------------------- |
| `tour=<id>`      | Welche Tour (Pflicht)                    |
| `scene=<id>`     | Startszene (alternativ `#scene=<id>`)    |
| `title=1`        | Tour-Titel oben einblenden               |
| `nav=0`          | Szenenleiste unten ganz ausblenden       |
| `thumbs=1`       | Szenenleiste aufgeklappt starten         |
| `autorotate=0`   | Auto-Rotation aus (oder z. B. `-3`)      |

## Hosting (kostenlos, Cloudflare)

Die Seite läuft als Cloudflare Worker mit statischen Assets (`wrangler.jsonc`).
Cloudflare ist mit dem GitHub-Repo verbunden: Jeder Push auf `main` wird automatisch
per `npx wrangler deploy` veröffentlicht. Die Website selbst
liegt alles unter `public/` – nur dieser Ordner wird veröffentlicht. Limit: 25 MB pro Datei.

Eigene Domain (z. B. `rundgang.firma-a.de`): im Worker unter *Domains* hinterlegen.

## Touren aus Kuula importieren

Öffentliche Kuula-Collections lassen sich komplett übernehmen – Panoramen (8192 px),
Reihenfolge, Startblick, Szenen-Links und Boden-Logos:

```bash
pip install pillow numpy   # nur nötig, wenn die Tour Boden-Sticker hat
python3 tools/import_kuula.py "https://kuula.co/share/collection/7M5G6" --company "Firma A"
```

Die Tour landet in `public/tours/<id>/` und wird in `tours/index.json` eingetragen.

## Tipps zur Bildgröße

- Ideal: 8192×4096 px, JPEG-Qualität ~85 % → ca. 3–8 MB pro Panorama.
- Größere Bilder bringen keine sichtbare Verbesserung, laden aber langsamer und
  scheitern auf manchen Handys.
