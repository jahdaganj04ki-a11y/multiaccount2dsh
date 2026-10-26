# dsh-multi-account

Multi-account support for the model providers of **DSH Desktop**
(`dataelement/dsh-desktop`, current Windows build, Harness `0.2.1-rc.x`).

After installing the plugin, every API-key provider on the **Settings →
Models** page gets an **Accounts** button. Clicking it opens an account
manager window for that provider where you can:

- add and remove several API keys (accounts) for the same provider,
- enable and disable accounts,
- pick the active account manually with one click,
- choose how accounts are switched:
  - **Manual** — only your click changes the active account,
  - **On error** — automatic switch when the active account returns
    `401/403`, an exhausted-quota/credit error or rate limiting,
  - **Round robin** — rotate to the next enabled account before every
    request.

The plugin only uses documented Harness extension points (the
`settings.models.provider-card` UI slot, the `llm/stream` and
`agent/request-error` event waterfalls, the credentials service and
plugin-owned HTTP routes). It patches no host files and replaces no host
services.

---

## Deutsch — Installation und Benutzung

### Voraussetzungen

- DSH Desktop für Windows (getestet gegen die Plug-in-Verträge von
  Version `0.12.x` / Harness `0.2.1-rc.2`),
- ein Anbieter, der mit API-Key arbeitet (z. B. DeepSeek, OpenRouter,
  Kimi, eigene OpenAI-kompatible Endpunkte). Der OAuth-Login
  („DeepSeek-Konto“) lässt sich nicht über mehrere Keys rotieren.

### 1. Paket bauen

```powershell
npm install --legacy-peer-deps
npm test
npm pack
```

Daraus entsteht `dsh-multi-account-1.2.0.tgz`. Ein fertiges Release-TGZ
muss nicht erneut gebaut werden.

### 2. In DSH Desktop installieren

Es gibt zwei unterstützte Wege — je nachdem, was die installierte
Desktop-Version anbietet (die lokale Paketinstallation ist abhängig von
der jeweiligen Version):

**A. Über die Plugin-/Workbench-Verwaltung**

1. DSH Desktop öffnen und in die Markt-/Plugin-Verwaltung wechseln.
2. Dort „lokales Paket installieren“ (bzw. Local package / `.tgz`)
   wählen und die `dsh-multi-account-*.tgz` auswählen.
3. DSH Desktop vollständig beenden und neu starten.

**B. Über die mitgelieferte `dsh`-Kommandozeile**

DSH Desktop betreibt sein Harness-Profil unter dem Namen `web` und bringt
die `dsh`-CLI über die Installation bzw. die Shims unter
`<DSH_HOME>\.desktop-bin` mit. Lokale Pfade müssen absolut sein:

```powershell
dsh plugin --profile web add "C:\Pfad\zu\dsh-multi-account-1.2.0.tgz"
```

Anschließend DSH Desktop vollständig neu starten. Ob die jeweilige
Version lokale `.tgz`-Pakete akzeptiert, zeigt `dsh plugin --help`;
ansonsten den Weg über die In-App-Verwaltung (A) nehmen.

### 3. Accounts einrichten

1. **Einstellungen → Modelle** öffnen.
2. Den gewünschten Anbieter wie gewohnt einmal anlegen (API-Key
   eintragen, „Speichern“). Der Anbieter muss mindestens einen
   konfigurierten Credential-Namen (`apiKeyEnv`, z. B.
   `DEEPSEEK_API_KEY`) haben.
3. In der Anbieterzeile auf **Accounts** klicken.
4. Im Account-Fenster:
   - **„Import the currently saved key“** macht den bereits
     eingetragenen Key zum ersten Account, oder
   - über „Add account“ weitere Keys mit optionalem Namen ergänzen.
5. Umschaltmodus wählen (Manuell / On error / Round Robin), Accounts
   aktivieren/deaktivieren oder mit **Activate** sofort umschalten.

Beim ersten Account wird dessen Key automatisch zum aktiven Key des
Anbieters. Jede Anfrage liest den aktiven Key erst zur Laufzeit, ein
Neustart ist nach Account-Änderungen nicht nötig.

### Accounts testen

Das Account-Fenster bietet drei Test-Ebenen. Jeder Test schickt eine
minimale Ein-Token-Anfrage über den echten Provider-Adapter, wertet die
Antwort aus und zeigt das Ergebnis (Status, Fehlercode, Latenz) direkt
beim Account an:

- **Einzelner Account** — Test-Button (▶) in der Zeile des Accounts.
- **Alle Accounts eines Providers** — „Test all accounts of this
  provider“ in der Account-Überschrift; die Accounts werden nacheinander
  geprüft.
- **Alle Accounts aller Provider** — „Test all accounts of all
  providers“; läuft durch sämtliche verwalteten Anbieter (max. 100
  Accounts pro Lauf).

Alle Mehrziel-Läufe (Provider- und Alle-Ebene) laufen als Hintergrund-Job:
Das Fenster zeigt den Fortschritt (`erledigt/gesamt`, Anzahl erfolgreich
und fehlgeschlagen) live an, statt auf eine blockierende Antwort zu
warten. Über **Abort** kann der Lauf jederzeit gestoppt werden — die
bereits geprüften Accounts bleiben mit ihren Ergebnissen stehen, der
unterbrochene Prüfschritt wird als `ABORTED` verbucht. Ein erneutes
Öffnen des Fensters hängt sich an einen noch laufenden Job an; das
Schließen des Fensters bricht den Server-Lauf nicht ab. Einzelne
Account-Tests bleiben direkte, kurze Anfragen mit Drehanzeige in der
Zeile.

Dabei wird der zu prüfende Key nur vorübergehend in die
Credential-Variable des Providers geschrieben und nach dem Lauf
vollständig wiederhergestellt — der aktive Account, Round-Robin-Stand
und der laufende Betrieb werden nicht verändert. Deaktivierte Accounts
werden ebenfalls getestet (die Frage ist ja: *würde* dieser Key
funktionieren?). Schlägt ein Test fehl, wird der Fehler klassifiziert
(z. B. `AUTH` = ungültiger Key, `QUOTA` = Kontingent erschöpft,
`RATE_LIMIT` = gedrosselt, `TIMEOUT` = keine Antwort innerhalb von
20 s). Ein Timeout-Limit ist über die Plugin-Config
(`testTimeoutMs`, Standard 20000 ms) anpassbar.

### Modelle testen

Zusätzlich gibt es im Account-Fenster einen Bereich **Modelle** mit
drei weiteren Test-Ebenen. Ein Modelltest nutzt den jeweils aktuell
wirksamen Key (aktiver Account bzw. bei Providern ohne verwaltete
Accounts den in den Modell-Einstellungen gespeicherten Key) und prüft,
ob das konkrete Modell eine Minimalanfrage annimmt:

- **Einzelnes Modell** — Test-Button (▶) in der Zeile des Modells.
- **Alle Modelle eines Providers** — „Test all models of this
  provider“; die Modellliste stammt aus dem Adapter-Katalog
  (`llm.listModels`), mit Fallback auf die im llm-pi-ai-Profil
  konfigurierten Modelle.
- **Alle Modelle aller Provider** — „Test all models of all
  providers“; durchläuft alle konfigurierbaren Provider (max. 100
  Prüfungen pro Lauf), auch solche ohne verwaltete Accounts.

Auch die Modell-Sammeltests laufen über denselben Job-Mechanismus mit
Fortschrittsanzeige und **Abort**; der Einzeltest pro Modell bleibt eine
direkte Anfrage.

Modelltests rotieren keine Accounts (auch nicht im Round-Robin-Modus),
verändern keinen Credential-Stand und schreiben ihre Ergebnisse
(Status, Code, Latenz) separat in die `state.json`
(`modelTests`), sodass keine Provider-Sektion „verwaltet“ wird, nur
weil ein Modell geprüft wurde.

### Verhalten der Umschaltmodi

| Modus | Verhalten |
| --- | --- |
| **Manual** | Aktiver Account bleibt fix; Fehler werden nur als Statusmarkierung (z. B. „Quota exhausted“) am Account angezeigt. |
| **On error** | Bei `AUTH`/`INVALID_CREDENTIAL`/`QUOTA`/`ACCOUNT_QUOTA`/`RATE_LIMIT` wird der nächste geeignete, aktivierte Account aktiviert und dieselbe Anfrage automatisch wiederholt (`{ kind: 'retry' }`). Gibt es keinen anderen aktiven Account, läuft die normale Fehlerbehandlung weiter. |
| **Round robin** | Vor jeder Anfrage wird zyklisch auf den nächsten *gesunden*, aktivierten Account gewechselt; schlägt einer zu, greift zusätzlich die On-error-Logik. |

Deaktivierte Accounts werden nie verwendet. Accounts mit Fehlerstatus
(`exhausted`, `invalid`, `rate_limited`, `error`) werden im Round-Robin-
Modus für eine Abkühlzeit „geparkt“ und erhalten in dieser Zeit keinen
neuen Traffic — die Rotation springt zum nächsten gesunden Account.
Sind gerade alle Accounts gezeichnet, greift ein Fallback auf den
vollständigen aktivierten Pool, damit die Anfrage nicht blockiert wird.
Die Abkühlzeit ist über die Plugin-Config einstellbar
(`cooldownMs`, Standard 60000 ms, gemessen ab dem Zeitstempel der
Statusmarkierung). Markierungen lassen sich jederzeit über
**Clear flag** zurücksetzen.

### Anbieter vollständig vergessen

Unterhalb der Account-Liste bietet **Forget provider** (mit
Bestätigungsschritt) die komplette Haushaltsauflösung eines Providers:
Alle verwalteten Account-Credentials werden aus dem Credential-Store
entfernt, die Provider-Sektion und alle gespeicherten Modelltestergebnisse
werden aus der `state.json` gelöscht. Die Credential-Referenz des
Providers selbst bleibt erhalten, danach ist der Anbieter wieder
„unverwaltet“ wie vor der ersten Account-Einrichtung. Entfernt man
ohnehin den letzten Account einzeln, wird die leere Provider-Sektion
automatisch gelöscht; veraltete `modelTests`-Einträge werden beim
nächsten Modell-Laden automatisch aussortiert, sodass die Zustandsdatei
nicht endlos wächst.

### Wo liegen die Daten?

- Zustand (Accounts, Modus, Status, aktiver Account, Modell- und
  Account-Testergebnisse):
  `<DSH_HOME>/multi-account/state.json` (Rechte `0600`),
- die API-Keys selbst bleiben im gehosteten Credential-Store
  (`<DSH_HOME>/.credentials.yaml`) unter generierten Referenzen
  (`DSH_MA_<ANBIETER>_…`). Die `state.json` enthält niemals Klartext-Keys.

---

## English — Installation and usage

### Requirements

- DSH Desktop for Windows (built against the plugin contracts of
  version `0.12.x` / Harness `0.2.1-rc.2`),
- an API-key-based provider (DeepSeek, OpenRouter, Kimi, custom
  OpenAI-compatible gateways, …). OAuth-only sign-in cannot be rotated
  by key.

### Build

```powershell
npm install --legacy-peer-deps
npm test
npm pack
```

This produces `dsh-multi-account-1.2.0.tgz`.

### Install

Either use the in-app plugin/workbench management “install local
package” flow, or the bundled `dsh` CLI with an **absolute** tarball
path:

```powershell
dsh plugin --profile web add "C:\path\to\dsh-multi-account-1.2.0.tgz"
```

Then fully quit and reopen DSH Desktop. Check `dsh plugin --help` if a
build does not list local-tarball support.

### Usage

1. Open **Settings → Models** and configure the provider once (it needs
   an `apiKeyEnv` credential reference).
2. Click **Accounts** on the provider row.
3. Import the currently saved key and/or add more accounts, then choose
   a switching mode and activate accounts as needed.

### Testing accounts

The account window offers three test scopes. Each test sends a minimal
one-token request through the provider's real adapter and records the
outcome (health state, error code, latency) on the account:

- **One account** — the ▸ **Test** button on each account row.
- **Every account of one provider** — *Test all accounts of this
  provider* next to the accounts heading, run sequentially.
- **Every account of every provider** — *Test all accounts of all
  providers*, iterating all managed providers (capped at 100 accounts
  per run).

Every multi-target run (both provider and all-providers scope) executes
as a background job: the window polls and renders live progress
(`done/total`, ok and failed counts) instead of awaiting one blocking
request, and an **Abort** button stops the run at any moment — finished
probes keep their results, the interrupted probe is recorded as
`ABORTED`. Reopening the modal re-attaches to a still-running job;
closing the window does not cancel the server-side job. Single-account
probes remain direct, short requests with a spinner on the row.

The key under test is committed to the provider's credential variable
only for the duration of the probe and restored afterwards, so the
active account, round-robin cursor and live traffic are unaffected.
Disabled accounts are tested too. Failures are classified (`AUTH`,
`INVALID_CREDENTIAL`, `QUOTA`, `ACCOUNT_QUOTA`, `RATE_LIMIT`,
`TIMEOUT`, …); the wall-clock budget is configurable through the
plugin config (`testTimeoutMs`, default 20000 ms).

### Testing models

The modal also contains a **Models** section with three more scopes. A
model probe runs on the currently committed key (the active account, or
the key saved in Models settings for providers without managed
accounts) and checks that the exact model accepts a minimal request:

- **One model** — the ▸ **Test** button on each model row.
- **Every model of one provider** — *Test all models of this
  provider*; the model list comes from the adapter catalog
  (`llm.listModels`) with an llm-pi-ai profile fallback.
- **Every model of every provider** — *Test all models of all
  providers*, walking every configurable provider (capped at 100
  probes per run), including ones without managed accounts.

Batch model runs use the same job engine with live progress and
**Abort**; the per-model probe stays a direct request.

Model probes never rotate accounts (not even in round-robin mode),
never alter the credential store, and persist their results (state,
code, latency) separately in `state.json` (`modelTests`), so testing a
model never turns a provider into a managed one.

### Health-aware round robin

In round-robin mode, accounts flagged with `exhausted`, `invalid`,
`rate_limited` or `error` are parked for a cooldown window
(`cooldownMs`, default 60000 ms, measured from the flag's timestamp)
and receive no new traffic while parked; rotation skips to the next
healthy enabled account. If every account is flagged, a fallback to
the full enabled pool keeps requests moving. Manual mode and the
on-error retry path are unchanged, and **Clear flag** clears a parked
state immediately.

### Forgetting a provider

Below the account list, **Forget provider** (with a confirmation step)
performs full housekeeping for one provider: every managed account
credential is removed from the credential store, and both the provider
section and its model-test results are deleted from `state.json`. The
key saved on the provider's own route ref is left untouched, so the
provider returns to its pre-managed state. Removing the last account
directly also deletes the now-empty provider section, and stale
`modelTests` entries are pruned on the next model load, keeping the
state document bounded.

### Data locations

- State: `<DSH_HOME>/multi-account/state.json` (mode `0600`),
- Secrets: the host credentials file `<DSH_HOME>/.credentials.yaml`,
  under generated `DSH_MA_<PROVIDER>_…` references. The state document
  never stores raw keys; the UI only receives four-character key hints.

---

## How it works

| Layer | Mechanism |
| --- | --- |
| UI entry | Keyed client slot `settings.models.provider-card` (one contribution per settings namespace, rendered per provider row), opening a host-`Modal` built from `dsh-client-ui-primitives`. |
| Client/server transport | Plugin-owned routes under `/api/multi-account.*`, registered with `ctx.connection.fetch.register`; buffered, bounded JSON, no secrets on read responses. |
| Account tests | The single-target `test-account` route temporarily commits one key, invokes `ctx.llm.stream` with a one-token probe (marked internally so the plugin's own listener skips rotation), classifies the result and always restores the previous credential; per-provider locking serializes the swaps. |
| Batch test jobs | Multi-target runs no longer block one HTTP request: `test-start` creates a background job (plan resolved up front, one running job at a time, capped at 100 probes and 5 retained finished jobs), `test-progress` polls it and `test-abort` cancels it via `AbortSignal.any` (job signal + external signal + timeout); `test-active` lets a reopened modal re-attach. The interrupted probe is persisted as an `ABORTED` failure. |
| Model tests | `models` / `test-model` resolve models from the adapter catalog (profile fallback) and probe the exact model on the already-committed active key under a second internal marker that suppresses rotation only; batch model runs go through the same job engine, results persist in the separate `modelTests` map and the same per-provider lock covers both probe families. |
| Secret storage | `ctx.credentials.set/unset/resolve`; each account owns a generated credential ref, the active account's value is committed to the provider's own ref (the exact value `llm-pi-ai` resolves per request). |
| Round robin / enforcement | Prepended global `llm/stream` waterfall listener; rotates the cursor and commits the key before the adapter resolves the credential. Flagged accounts (`exhausted`, `invalid`, `rate_limited`, `error`) are parked for `cooldownMs` (default 60000 ms); the healthy enabled pool is preferred with a full-pool fallback, and selection runs inside the serialized state mutator. |
| State housekeeping | `forget-provider` unsets all managed credential refs and deletes the provider section plus its `modelTests` row (route ref kept); removing the last account deletes the empty section, and model listing prunes stale/empty `modelTests` entries. |
| Unload safety | Plugin teardown disposes the manager, which aborts every in-flight probe and running job and releases all per-provider locks; routes and slot contributions unregister through their disposers. |
| Failover | Prepended global `agent/request-error` waterfall listener; classifies `AUTH`, `INVALID_CREDENTIAL`, `QUOTA`, `ACCOUNT_QUOTA`, `MISSING_CREDENTIAL` and `RATE_LIMIT`, marks the account, rotates and returns `{ kind: 'retry' }` — the same contract as the official `dsh-llm-retry` plugin. A per-step budget prevents retry loops. |
| Provider/ref discovery | `ctx.llm.listConfigurableProviders()` plus the same `configEditor` seam the settings forms use, memoized and invalidated on `loader/volatile-update`. |
| Persistence | One atomic, serialized `state.json` via `@deepseek-ai/dsh-atomic-write` (Windows rename-retry aware), file mode `0600`. |

### Limitations

- API-key providers only; OAuth grants (e.g. the first-party DeepSeek
  account) are hidden by design.
- While accounts exist, the plugin manages the provider's credential
  ref. Saving a *new* key in the standard Models editor does not replace
  an active account — use “Import the currently saved key” to adopt it.
- Removing the plugin leaves the generated `DSH_MA_*` refs in
  `.credentials.yaml`; they are unused and can be deleted manually.
- Automatic retries re-run the model step; tool side effects that
  already completed are handled by the host's normal agent-loop
  semantics, exactly as with `dsh-llm-retry`.

## Development

```bash
npm install --legacy-peer-deps   # host peers are satisfied inside DSH Desktop
npm test                         # node:test, real Cordis + credentials service
npm run pack:check               # inspect the tarball contents
```

The server is plain ESM JavaScript; the client is a single
`window.__ModuleLoader__.load(...)` module (no build step, matching the
host plugin loading protocol). UI copy is registered bilingually
(English + Chinese, the host's locale mechanism) through
`ctx.locale.register`.

## License

MIT — see [LICENSE](./LICENSE).
