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

Daraus entsteht `dsh-multi-account-1.0.0.tgz`. Ein fertiges Release-TGZ
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
dsh plugin --profile web add "C:\Pfad\zu\dsh-multi-account-1.0.0.tgz"
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

### Verhalten der Umschaltmodi

| Modus | Verhalten |
| --- | --- |
| **Manual** | Aktiver Account bleibt fix; Fehler werden nur als Statusmarkierung (z. B. „Quota exhausted“) am Account angezeigt. |
| **On error** | Bei `AUTH`/`INVALID_CREDENTIAL`/`QUOTA`/`ACCOUNT_QUOTA`/`RATE_LIMIT` wird der nächste geeignete, aktivierte Account aktiviert und dieselbe Anfrage automatisch wiederholt (`{ kind: 'retry' }`). Gibt es keinen anderen aktiven Account, läuft die normale Fehlerbehandlung weiter. |
| **Round robin** | Vor jeder Anfrage wird zyklisch auf den nächsten aktivierten Account gewechselt; schlägt einer zu, greift zusätzlich die On-error-Logik. |

Deaktivierte Accounts werden nie verwendet. Accounts mit Fehlerstatus
werden nachrangig behandelt und können über **Clear flag** zurückgesetzt
werden.

### Wo liegen die Daten?

- Zustand (Accounts, Modus, Status, aktiver Account):
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

This produces `dsh-multi-account-1.0.0.tgz`.

### Install

Either use the in-app plugin/workbench management “install local
package” flow, or the bundled `dsh` CLI with an **absolute** tarball
path:

```powershell
dsh plugin --profile web add "C:\path\to\dsh-multi-account-1.0.0.tgz"
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

The key under test is committed to the provider's credential variable
only for the duration of the probe and restored afterwards, so the
active account, round-robin cursor and live traffic are unaffected.
Disabled accounts are tested too. Failures are classified (`AUTH`,
`INVALID_CREDENTIAL`, `QUOTA`, `ACCOUNT_QUOTA`, `RATE_LIMIT`,
`TIMEOUT`, …); the wall-clock budget is configurable through the
plugin config (`testTimeoutMs`, default 20000 ms).

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
| Account tests | `test-account` / `test-provider` / `test-all` routes temporarily commit one key, invoke `ctx.llm.stream` with a one-token probe (marked internally so the plugin's own listener skips rotation), classify the result and always restore the previous credential; per-provider locking serializes the swaps. |
| Secret storage | `ctx.credentials.set/unset/resolve`; each account owns a generated credential ref, the active account's value is committed to the provider's own ref (the exact value `llm-pi-ai` resolves per request). |
| Round robin / enforcement | Prepended global `llm/stream` waterfall listener; rotates the cursor and commits the key before the adapter resolves the credential. |
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
