# Leitstand – Arbeitsversion

Eine Weboberfläche, über die du viele KI-Agenten gleichzeitig führst. Jeder Agent ist ein Lauf von **GitHub Copilot CLI** (`copilot -p`) in einem Projektordner. Angebunden ist **Microsoft 365**: Outlook (Mail, Kalender), Teams (Chats, Kanäle), OneDrive/SharePoint und To Do. Teams dient zusätzlich als Kanal zu dir: Benachrichtigungen, Aufträge an die Zentrale und ein tägliches Briefing.

Keine Abhängigkeiten außer Node 20+ und Copilot CLI.

## Start

```bash
npm install -g @github/copilot   # einmal; danach `copilot` starten und /login
git clone <dieses Repo> && cd leitstand-arbeit
npm start                        # http://127.0.0.1:4747
```

Windows: `deploy\start-windows.cmd`. Dauerhaft (Mac: launchd, Linux: systemd --user): `deploy/autostart.sh install`.

Dann im Reiter **Einstellungen → Microsoft 365** auf „Anmelden“: Der Leitstand zeigt einen Code, den du auf <https://microsoft.com/devicelogin> mit deinem Arbeitskonto eingibst. Fertig.

## Was drin ist

| Baustein | Kurz |
|---|---|
| Projekte und Chats | Ein Lead-Agent je Chat, gebunden an einen Projektordner. Warteschlange „braucht dich“, Leertaste springt zum nächsten. |
| Copilot CLI | Jeder Zug ist `copilot -p … --output-format json`; die Vorgeschichte ist eine Copilot-Sitzung (`--session-id` beim ersten, `--resume` bei jedem weiteren Zug). Modell und Aufwand je Projekt oder Chat (`--model`, `--reasoning-effort`; leer = Copilot wählt). |
| Teilaufträge | Ein Agent zerlegt große Aufträge (`leitstand auftrag`), bis drei Ebenen tief; Ergebnisse gehen an den Auftraggeber zurück. |
| Zentrale | Ein Chat über allen Projekten: beantwortet Fragen, liest bei Bedarf in Chats, verteilt Aufträge. |
| Outlook | Mails lesen, suchen, Anhänge in den Projektordner, markieren, verschieben, Entwürfe; Senden und Antworten nach Freigabe. |
| Kalender | Termine lesen, eigene Termine direkt anlegen, Einladungen (auch mit Teams-Besprechung) nach Freigabe, gemeinsam freie Zeiten finden. |
| Teams | Chats und Kanäle lesen, schreiben und posten nach Freigabe. |
| OneDrive/SharePoint | Dateien suchen, auflisten, in den Projektordner laden (Office-Dateien wahlweise als PDF), Ergebnisse in den eigenen OneDrive hochladen. |
| To Do, Personen | Aufgaben lesen, anlegen, abhaken; Kollegen mit Mail, Telefon, Abteilung finden. |
| Freigaben | Alles, was in deinem Namen hinausgeht, liegt erst als Freigabe vor (Mail als Entwurf schon in Outlook sichtbar). Ein Klick sendet. Einstellbar auf „direkt“. |
| Teams als Kanal | Benachrichtigung in einen Teams-Chat, wenn ein Agent dich braucht; Nachrichten aus einem Teams-Chat gehen an die Zentrale, ihre Antwort zurück nach Teams; Tagesbriefing Mo–Fr zur eingestellten Uhrzeit. |
| Seiten, Dateien, Tresor | Gemeinsamer Kontext (Markdown/CSV) für alle Agenten, Dateiansicht mit Vorschau, Passwortmanager mit 2FA-Codes. |

Nicht enthalten (gegenüber dem privaten Leitstand): Server-Flotte per SSH, Claude-Abo-Konten, Karte/Zahlungen/Abos, eigenes Postfach und SMS der Agenten, Anruf-CRM, Live-Browser, Computer Use.

## Modi je Projekt

- **Selbstständig** (Vorgabe): `--allow-all-tools --allow-all-urls`. Copilot führt Befehle ohne Rückfrage aus, bleibt aber im Projektordner und im Kontext-Ordner.
- **Vorsichtig**: nur Dateiänderungen, das Kommando `leitstand` und Webzugriffe sind frei. Verweigerte Befehle legt der Leitstand dir als Erlaubnis vor; „Erlauben“ gilt ab dann für das Projekt (`--allow-tool shell(KOMMANDO:*)`).
- **Autonom**: `--allow-all`, auch außerhalb des Projektordners.

## Das Kommando `leitstand` (für die Agenten)

Liegt in `bin/` und steht jedem Lauf im PATH (`leitstand.mjs`, mit `leitstand` für Mac/Linux und `leitstand.cmd` für Windows). Es spricht nur mit dem Leitstand (eigener Port, Token des Laufs).

```
leitstand outlook liste|suchen|lesen|kalender|entwurf|senden|antworten|termin|frei|anhaenge|markieren|verschieben
leitstand teams chats|lesen|senden|kanaele|kanal|posten
leitstand m365 heute|personen
leitstand dateien liste|suchen|laden|hochladen
leitstand aufgaben liste|neu|erledigt
leitstand kontext …, tresor …, auftrag …, auftraege …, tell …, zentrale …, ergebnis …, stand …
```

`leitstand` ohne Argumente zeigt alle Kommandos mit Parametern.

## Microsoft 365: Anmeldung und Rechte

- Gerätecode-Anmeldung mit delegierten Rechten deines Kontos; kein App-Geheimnis. Das Refresh-Token liegt verschlüsselt in `data/secrets.enc`.
- Vorgabe-Client ist „Microsoft Graph Command Line Tools“ (`14d82eec-204b-4c2f-b7e8-296a70dab67e`), in vielen Tenants schon zugelassen. Eigene App-Registrierung (öffentlicher Client, „Allow public client flows“ an): Client-ID und Tenant in den Einstellungen eintragen.
- Rechte: Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, Chat.ReadWrite, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Send, dazu People.Read, User.ReadBasic.All, Files.ReadWrite.All, Sites.Read.All, Tasks.ReadWrite. Lehnt der Tenant die Anmeldung ab, „Nur Grundrechte“ setzen (Mail, Kalender, Chats). Kanäle lesen (ChannelMessage.Read.All) braucht meist Admin-Zustimmung und ist darum eigens einschaltbar.
- Chat-IDs für Benachrichtigung und Eingang liefert ein Agent mit `leitstand teams chats` (ein Chat mit dir selbst oder ein eigener Gruppenchat eignet sich).

## Konfiguration (Umgebung)

| Variable | Bedeutung |
|---|---|
| `LEITSTAND_PORT` | Port der Oberfläche (4747); der Agenten-Port ist +1 |
| `LEITSTAND_DATA` | Datenordner (Vorgabe `./data`) |
| `LEITSTAND_COPILOT` | Pfad zu `copilot` |
| `LEITSTAND_MODEL`, `LEITSTAND_EFFORT` | Vorgaben für Modell und Aufwand (sonst `auto`) |
| `LEITSTAND_SLOTS` | gleichzeitige Läufe beim ersten Start (später in den Einstellungen) |
| `LEITSTAND_BIND` | Adressen, an die die Oberfläche bindet (Vorgabe 127.0.0.1) |
| `LEITSTAND_PUBLIC_URL` | Adresse für Links in Teams-Benachrichtigungen |
| `LEITSTAND_M365_CLIENT_ID` | Client-ID, falls nicht in den Einstellungen |

Die Agenten bekommen ihre Anweisungen als `AGENTS.md` aus `data/copilot/<chat>/` (über `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`); eigene `AGENTS.md` im Projektordner gelten zusätzlich. Die Seite „Vorgaben“ im Reiter „Seiten“ geht wörtlich in jeden Lauf ein.
