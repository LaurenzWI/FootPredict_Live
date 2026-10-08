# FootPredict – Live-Spiele und automatische Prognosen

Dies ist die aktualisierte FootPredict-Website. Sie zeigt **echte Spiele und Spielstände** aus einer öffentlich erreichbaren ESPN-Datenquelle und berechnet **automatisch** Wahrscheinlichkeiten aus vergangenen Spielen. Es gibt keine manuelle Quoten-Eingabe und keine erfundenen Beispielspiele.

## Starten in IntelliJ IDEA (Windows / macOS / Linux)

1. **Node.js 18 oder neuer installieren**, falls noch nicht vorhanden: https://nodejs.org/
2. Die ZIP-Datei entpacken und den kompletten Ordner `footpredict-website` in IntelliJ öffnen.
3. Unten in IntelliJ den Reiter **Terminal** öffnen (alternativ PowerShell / Terminal im Ordner).
4. Befehl ausführen:
   ```sh
   node server.js
   ```
5. Im Browser **http://localhost:3000** öffnen.
6. Zum Beenden im Terminal **Strg + C**.

Alternativ unter Windows `start-windows.bat` doppelklicken, unter macOS/Linux im Terminal `sh start-mac-linux.sh`.

**Wichtig:** `index.html` nicht per Doppelklick als `file://` öffnen. Die Website benötigt den lokalen Server, damit ESPN-Daten ohne Browser-CORS-Probleme eingelesen werden können. **Kein `npm install` notwendig**, es gibt keine externen JavaScript-Pakete.

## Datengrundlage

- Öffentliche ESPN-Soccer-Scoreboard-Endpunkte (ohne API-Key): `https://site.api.espn.com/apis/site/v2/sports/soccer/{liga}/scoreboard?dates=YYYYMM&limit=500`
- Abgedeckte Wettbewerbe: Deutschland, Österreich, England, Spanien, Italien, Frankreich, Champions League, Europa League und Nations League. Eine Liga kann fehlen, falls ESPN sie nicht unterstützt oder gerade keine Partien enthält.
- Die Ergebnisse für die Form werden aus abgeschlossenen Spielen **derselben Liga** aus den vergangenen 110 Tagen ermittelt. Der Server ruft ganze Kalendermonate ab und filtert die passenden Tage selbst, weil ESPN seit September 2026 keine Datumsbereiche (mit Bindestrich) mehr akzeptiert. Bei Lücken oder Ligapausen kann die Prognose fehlen.
- Live-Scores werden ungefähr alle 60 Sekunden im Browser neu angefordert, die Server-Cachezeit für aktuelle Spielstände liegt bei 55 Sekunden. Historische Spiele bleiben 10 Minuten im Cache.
- Eine Partie wird nur prognostiziert, wenn **beide Teams mindestens drei abgeschlossene Ligaspiele** haben. Keine erfundenen Quoten und kein Demo-Fallback.

ESPN bietet diesen Endpunkt öffentlich an, **aber nicht als offiziell garantierte Entwickler-API**. Seine Erreichbarkeit, Datenqualität und Nutzungsbedingungen können sich ändern. Für eine dauerhaft betriebene kommerzielle Website ist ein vertraglich lizenzierter Datenanbieter zu empfehlen.

## Berechnung

1. Für jedes Team die letzten fünf abgeschlossenen Ligaspiele vor dem jeweiligen Spiel suchen.
2. Durchschnittlich erzielte und kassierte Tore bestimmen; Heimvorteil für die Heimtore berücksichtigen.
3. Mit einer Poisson-Verteilung mögliche Spielausgänge berechnen (Heimsieg/Unentschieden/Auswärtssieg).
4. Form berücksichtigen: je 2 Prozentpunkte auf Ausgangswerte für Siege bzw. Niederlagen der Teams, je 1 Prozentpunkt für Unentschieden; bei drei Siegen/Niederlagen in Folge zusätzlich 10 Prozentpunkte auf den jeweils passenden Ausgang, wie bei eurer Java-Idee.
5. Anschließend auf 100 % normalisieren.
6. Bei Live-Spielen mit **bekanntem Spielstand und auswertbarer Spielminute** wird eine aktualisierte In-Play-Prognose aus der Verteilung der erwarteten verbleibenden Tore berechnet. Fehlt die Minute, bleibt die Karte ausdrücklich eine Vor-Spiel-Prognose.

Da kostenlose und zuverlässige Buchmacherquoten nicht für alle Partien verfügbar sind, **ersetzt dieses Modell die Wettquoten-Eingabe durch Leistungsdaten**. Das ist eine bewusste Weiterentwicklung eurer Aufgabenstellung, nicht eine angebliche Abfrage von Buchmacherquoten. Die Zahlen sind nur Modellschätzungen.

## Dateien

- `index.html`: Layout / Text der Website
- `style.css`: Design und mobile Darstellung
- `app.js`: Browser-Logik, automatisches Laden, Balkendiagramme, Filter
- `predictor.js`: Berechnungen und Datenaufbereitung
- `server.js`: kleiner lokaler Server und ESPN-Datenabruf (Node.js)
- `tests/`: automatisierte Tests

## Tests ausführen

```sh
npm test
```

## Wenn nichts erscheint

- Internetverbindung prüfen.
- Mit `http://localhost:3000` statt `index.html` starten.
- Andere Liga / Zeitraum wählen. Besonders während Länderspielpausen ist eine Liga zeitweise leer.
- Wenn ESPN die Verbindung ablehnt oder das Format ändert, zeigt die Website eine Fehlermeldung und **keine Fake-Spiele**.

## Behobener Fehler (Oktober 2026)

Frühere FootPredict-Versionen sendeten `dates=YYYYMMDD-YYYYMMDD` an ESPN. Seit dem 18.09.2026 antwortet ESPN darauf mit HTTP 400. Diese Ausgabe verwendet stattdessen `dates=YYYYMM` und filtert lokal. Bestehende Nutzer müssen die alten Dateien durch diese Version ersetzen und den Server neu starten.
