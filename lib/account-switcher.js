/**
 * Account lifecycle and the runtime switching engine.
 *
 * Two host event seams drive every automatic behavior; neither patches host
 * code nor replaces a host service:
 *
 * - `llm/stream` (waterfall, prepended): before the adapter resolves the
 *   route's credential, the active account's key is committed to the route's
 *   credential ref. Round-robin mode advances the cursor here, once per
 *   request. The adapter (`llm-pi-ai`) resolves the ref per operation, so the
 *   new key reaches the very next request without a restart.
 * - `agent/request-error` (waterfall, prepended): a terminal auth/quota/rate
 *   failure marks the active account, rotates to the next enabled one,
 *   commits its key, and answers `{ kind: 'retry' }`, which is the same
 *   decision contract dsh-llm-retry uses.
 *
 * @module dsh-multi-account/account-switcher
 */
import {
  accountCredentialRef,
  HARD_SWITCH_CODES,
  isCredentialRef,
  isMode,
  keyHint,
  LIMITS,
  MODES,
  MODEL_TEST_MARKER,
  newAccountId,
  NO_TEST_MODEL_CODE,
  randomNonce,
  normalizeApiKey,
  RATE_LIMIT_CODE,
  STATUS,
  TEST_MARKER,
  TEST_TIMEOUT_CODE,
} from './protocol.js'

/** Status recorded for an account that just hit a classified failure. */
function statusForCode(code) {
  if (code === 'RATE_LIMIT') return { state: STATUS.RATE_LIMITED, code }
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL') {
    return { state: STATUS.INVALID, code }
  }
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return { state: STATUS.EXHAUSTED, code }
  return null
}

/** Bad-health states selection should deprioritize (but never hard-block). */
const BAD_STATES = new Set([STATUS.EXHAUSTED, STATUS.INVALID, STATUS.RATE_LIMITED, STATUS.ERROR])

export class AccountManager {
  #ctx
  #store
  #directory
  #testTimeoutMs
  /** providerId -> promise chain serializing the temporary credential swaps. */
  #testLocks = new Map()

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('./state-store.js').StateStore} store
   * @param {import('./provider-directory.js').ProviderDirectory} directory
   * @param {{ testTimeoutMs?: number }} [options]
   */
  constructor(ctx, store, directory, options = {}) {
    this.#ctx = ctx
    this.#store = store
    this.#directory = directory
    const timeout = Number(options.testTimeoutMs)
    this.#testTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : LIMITS.TEST_TIMEOUT_MS
  }

  /** Resolve the credential ref for one route, preferring an explicit value. */
  async #resolveRef(providerId, explicit) {
    if (explicit !== undefined) {
      if (!isCredentialRef(explicit)) {
        const error = new Error('credential ref must be a POSIX-style environment variable name')
        error.code = 'BAD_REQUEST'
        error.status = 400
        throw error
      }
      return explicit
    }
    const described = await this.#directory.describe(providerId)
    if (described?.ref) return described.ref
    const error = new Error('this provider route declares no API-key credential (apiKeyEnv); open it in Settings → Models first')
    error.code = 'NO_CREDENTIAL_REF'
    error.status = 409
    throw error
  }

  /**
   * Write the active account's key into the route's own credential ref.
   * No-op when the ref already holds the expected value, which keeps normal
   * traffic free of credentials-file rewrites.
   *
   * @param {string} providerId route id.
   * @param {object} [section] known section; read when omitted.
   * @returns {Promise<{changed: boolean, activeId: string|null}>}
   */
  async commitActive(providerId, section) {
    const current = section ?? await this.#store.provider(providerId)
    if (!current?.ref) return { changed: false, activeId: null }
    const active = current.accounts.find((account) => account.id === current.activeAccountId)
    if (!active || !active.enabled) return { changed: false, activeId: current.activeAccountId }

    const resolved = await this.#ctx.credentials.resolve(this.#asRef(active.credentialRef))
    const key = resolved?.value
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`account "${active.label || active.id}" has no stored key anymore`)
    }
    const existing = await this.#ctx.credentials.resolve(this.#asRef(current.ref))
    if (existing?.value === key) return { changed: false, activeId: active.id }
    await this.#ctx.credentials.set(this.#asRef(current.ref), key)
    return { changed: true, activeId: active.id }
  }

  /** Brand a raw string as a credential ref; the host service validates grammar. */
  #asRef(value) {
    // The credentials service exports credentialRef but the plain string is
    // accepted identically at its resolve/set boundary; keep the call local.
    return value
  }

  /** First enabled account, preferring accounts without a bad status. */
  static pickAccount(accounts, excludeId = null) {
    const enabled = accounts.filter((account) => account.enabled && account.id !== excludeId)
    if (enabled.length === 0) return null
    const healthy = enabled.filter((account) => !BAD_STATES.has(account.status.state))
    return healthy[0] ?? enabled[0]
  }

  /**
   * Add an account. The secret is written to the credentials service under a
   * generated account-only ref; the state document keeps metadata only.
   */
  async addAccount(input) {
    const providerId = String(input?.providerId ?? '')
    if (!providerId || providerId.length > LIMITS.MAX_PROVIDER_ID) {
      const error = new Error('providerId is required')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    const keyCheck = normalizeApiKey(input?.apiKey)
    if (!keyCheck.ok) {
      const error = new Error(keyCheck.reason === 'empty' ? 'API key must not be empty' : 'API key contains unsupported characters')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    const label = typeof input?.label === 'string' ? input.label.trim().slice(0, LIMITS.MAX_LABEL) : ''
    const ref = await this.#resolveRef(providerId, input?.ref)

    const section = await this.#store.ensureProvider(providerId, ref)
    if (section.accounts.length >= LIMITS.MAX_ACCOUNTS_PER_PROVIDER) {
      const error = new Error(`provider already has the maximum of ${LIMITS.MAX_ACCOUNTS_PER_PROVIDER} accounts`)
      error.code = 'LIMIT_REACHED'
      error.status = 409
      throw error
    }

    const account = {
      id: newAccountId(),
      label: label || `Account ${section.accounts.length + 1}`,
      credentialRef: accountCredentialRef(providerId, randomNonce()),
      enabled: true,
      createdAt: Date.now(),
      status: { state: STATUS.OK, code: null, message: null, at: null },
    }
    await this.#ctx.credentials.set(account.credentialRef, keyCheck.value)

    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      target.ref = ref
      target.accounts.push(account)
      if (!target.activeAccountId) target.activeAccountId = account.id
    })
    await this.commitActive(providerId).catch((error) => {
      this.#ctx.logger.warn('dsh-multi-account: initial key commit failed: %s', error?.message ?? error)
    })
    return this.describeProvider(providerId)
  }

  /** Create an account from the key currently stored on the route's ref. */
  async importCurrentKey(input) {
    const providerId = String(input?.providerId ?? '')
    const ref = await this.#resolveRef(providerId, input?.ref)
    const hit = await this.#ctx.credentials.resolve(ref)
    if (typeof hit?.value !== 'string' || hit.value.length === 0) {
      const error = new Error('no API key is currently saved for this provider in Settings → Models')
      error.code = 'NOT_CONFIGURED'
      error.status = 409
      throw error
    }
    return this.addAccount({
      providerId,
      ref,
      label: typeof input?.label === 'string' ? input.label : undefined,
      apiKey: hit.value,
    })
  }

  async removeAccount(input) {
    const providerId = String(input?.providerId ?? '')
    const accountId = String(input?.accountId ?? '')
    const section = await this.#store.provider(providerId)
    const account = section?.accounts.find((candidate) => candidate.id === accountId)
    if (!account) {
      const error = new Error('account not found')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    await this.#ctx.credentials.unset(account.credentialRef).catch((error) => {
      this.#ctx.logger.warn('dsh-multi-account: credential unset failed: %s', error?.message ?? error)
    })

    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      target.accounts = target.accounts.filter((candidate) => candidate.id !== accountId)
      if (target.activeAccountId === accountId) {
        const fallback = target.accounts.find((candidate) => candidate.enabled) ?? null
        target.activeAccountId = fallback?.id ?? null
      }
    })
    await this.commitActive(providerId).catch(() => undefined)
    return this.describeProvider(providerId)
  }

  async toggleAccount(input) {
    const providerId = String(input?.providerId ?? '')
    const accountId = String(input?.accountId ?? '')
    const enabled = input?.enabled === true
    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      const account = target?.accounts.find((candidate) => candidate.id === accountId)
      if (!account) {
        const error = new Error('account not found')
        error.code = 'NOT_FOUND'
        throw error
      }
      account.enabled = enabled
      if (!enabled && target.activeAccountId === accountId) {
        const fallback = target.accounts.find((candidate) => candidate.enabled && candidate.id !== accountId)
        target.activeAccountId = fallback?.id ?? null
      }
    })
    await this.commitActive(providerId).catch(() => undefined)
    return this.describeProvider(providerId)
  }

  /** Manual activation ("switch by click"). */
  async switchAccount(input) {
    const providerId = String(input?.providerId ?? '')
    const accountId = String(input?.accountId ?? '')
    const section = await this.#store.provider(providerId)
    const account = section?.accounts.find((candidate) => candidate.id === accountId)
    if (!account) {
      const error = new Error('account not found')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    if (!account.enabled) {
      const error = new Error('enable the account before activating it')
      error.code = 'ACCOUNT_DISABLED'
      error.status = 409
      throw error
    }
    await this.#store.update((draft) => {
      draft.providers[providerId].activeAccountId = accountId
    })
    await this.commitActive(providerId)
    return this.describeProvider(providerId)
  }

  async setMode(input) {
    const providerId = String(input?.providerId ?? '')
    const mode = input?.mode
    if (!isMode(mode)) {
      const error = new Error(`mode must be one of: ${Object.values(MODES).join(', ')}`)
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    await this.#store.update((draft) => {
      if (!draft.providers[providerId]) {
        const error = new Error('provider has no accounts yet')
        error.code = 'NOT_FOUND'
        throw error
      }
      draft.providers[providerId].mode = mode
    })
    return this.describeProvider(providerId)
  }

  async clearStatus(input) {
    const providerId = String(input?.providerId ?? '')
    const accountId = input?.accountId === undefined ? null : String(input.accountId)
    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      if (!target) {
        const error = new Error('provider not found')
        error.code = 'NOT_FOUND'
        throw error
      }
      for (const account of target.accounts) {
        if (accountId !== null && account.id !== accountId) continue
        account.status = { state: STATUS.OK, code: null, message: null, at: null }
      }
    })
    return this.describeProvider(providerId)
  }

  /**
   * Client-safe view of one provider: metadata and key hints, never secrets.
   * @param {string} providerId route id.
   */
  async describeProvider(providerId) {
    const [section, directory] = await Promise.all([
      this.#store.provider(providerId),
      this.#directory.describe(providerId),
    ])
    if (!section) {
      return {
        providerId,
        displayName: directory?.displayName ?? providerId,
        settingsNs: directory?.settingsNs ?? 'llm-pi-ai',
        ref: directory?.ref ?? null,
        refConfigured: false,
        managed: false,
        mode: MODES.MANUAL,
        activeAccountId: null,
        accounts: [],
      }
    }
    const accounts = await Promise.all(section.accounts.map(async (account) => {
      const hit = await this.#ctx.credentials.resolve(account.credentialRef).catch(() => undefined)
      return {
        id: account.id,
        label: account.label,
        enabled: account.enabled,
        active: section.activeAccountId === account.id,
        createdAt: account.createdAt,
        keyHint: keyHint(hit?.value),
        keyPresent: typeof hit?.value === 'string' && hit.value.length > 0,
        status: account.status,
        lastTest: account.lastTest ?? null,
      }
    }))
    const refHit = section.ref ? await this.#ctx.credentials.resolve(section.ref).catch(() => undefined) : undefined
    return {
      providerId,
      displayName: directory?.displayName ?? providerId,
      settingsNs: directory?.settingsNs ?? 'llm-pi-ai',
      ref: section.ref,
      refConfigured: typeof refHit?.value === 'string' && refHit.value.length > 0,
      managed: true,
      mode: section.mode,
      activeAccountId: section.activeAccountId,
      accounts,
    }
  }

  /** Client-safe view of every configurable provider. */
  async describeAll() {
    const [state, providers] = await Promise.all([
      this.#store.snapshot(),
      this.#directory.list(),
    ])
    return Promise.all(providers.map(async (entry) => {
      if (state.providers[entry.provider]) return this.describeProvider(entry.provider)
      const hit = entry.ref ? await this.#ctx.credentials.resolve(entry.ref).catch(() => undefined) : undefined
      return {
        providerId: entry.provider,
        displayName: entry.displayName,
        settingsNs: entry.settingsNs,
        ref: entry.ref,
        refConfigured: typeof hit?.value === 'string' && hit.value.length > 0,
        managed: false,
        mode: MODES.MANUAL,
        activeAccountId: null,
        accounts: [],
      }
    }))
  }

  /**
   * Serialize test runs for one provider. A test temporarily overwrites the
   * route's credential ref, so two concurrent tests on the same provider
   * would observe each other's keys; the lock makes them run strictly one
   * after another. Different providers keep independent chains.
   *
   * @param {string} providerId route id.
   * @param {() => Promise<object>} work test body.
   * @returns {Promise<object>}
   */
  async #withProviderLock(providerId, work) {
    const previous = this.#testLocks.get(providerId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const tracked = run.then(() => undefined, () => undefined)
    this.#testLocks.set(providerId, tracked)
    try {
      return await run
    } finally {
      // Only delete when no newer queued test has already replaced the entry.
      if (this.#testLocks.get(providerId) === tracked) this.#testLocks.delete(providerId)
    }
  }

  /**
   * Resolve the cheapest usable model id for a test request: the adapter's
   * own catalog first (no profile assumptions), then the configured llm-pi-ai
   * profile models.
   *
   * @param {string} providerId route id.
   * @returns {Promise<string>}
   */
  async #pickTestModel(providerId) {
    try {
      const catalog = await this.#ctx.llm.listModels(providerId)
      const first = catalog?.find?.((model) => typeof model?.id === 'string' && model.id.length > 0)
      if (first) return first.id
    } catch (error) {
      this.#ctx.logger.warn('dsh-multi-account: llm.listModels(%s) failed: %s', providerId, error?.message ?? error)
    }
    const configured = await this.#directory.providerModels(providerId).catch(() => [])
    const model = configured[0]
    if (model) return model
    const error = new Error(`no model is configured for provider "${providerId}" to test against`)
    error.code = NO_TEST_MODEL_CODE
    throw error
  }

  /**
   * Execute one account test. The account's key is committed to the route's
   * own credential ref only for the duration of a minimal one-token request,
   * then the previous value is restored regardless of outcome — the active
   * account and normal traffic are never changed by a test.
   *
   * @param {string} providerId route id.
   * @param {object} account detached account record.
   * @returns {Promise<object>} the persisted `lastTest` result.
   */
  /** Normalize one probe outcome into the persisted test-result shape. */
  #testRecord(startedAt, result) {
    return {
      state: result.state,
      code: result.code ?? null,
      message: typeof result.message === 'string' ? result.message.slice(0, 200) : null,
      at: startedAt,
      latencyMs: Date.now() - startedAt,
      model: result.model ?? null,
    }
  }

  /**
   * Run the minimal one-token probe through the real adapter. The marker
   * decides how the plugin's own `llm/stream` listener treats the request:
   * account tests swap the key themselves and skip everything; model tests
   * run on the already-committed key and only suppress rotation.
   *
   * @param {{providerId: string, model: string, marker: symbol}} spec
   * @returns {Promise<object>} normalized test result.
   */
  async #probeStream({ providerId, model, marker }) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#testTimeoutMs)
    try {
      const stream = await this.#ctx.llm.stream({
        provider: providerId,
        model,
        maxTokens: LIMITS.TEST_MAX_TOKENS,
        messages: [{
          role: 'user',
          id: `ma-test-${randomNonce()}`,
          content: [{ type: 'text', text: 'Reply with the single word OK.' }],
        }],
        signal: controller.signal,
        [marker]: true,
      })
      let gotChunk = false
      // One chunk proves authentication and billing worked; abort early to
      // keep the test cheap. The adapter drains/cancels the upstream itself.
      for await (const chunk of stream) {
        if (chunk) { gotChunk = true; break }
      }
      return this.#testRecord(startedAt, {
        state: STATUS.OK,
        code: null,
        message: gotChunk ? null : 'the provider returned no content, but accepted the request',
        model,
      })
    } catch (error) {
      const classified = statusForCode(error?.code)
      if (controller.signal.aborted) {
        return this.#testRecord(startedAt, { state: STATUS.ERROR, code: TEST_TIMEOUT_CODE, message: `test timed out after ${this.#testTimeoutMs} ms`, model })
      }
      if (classified) {
        return this.#testRecord(startedAt, { state: classified.state, code: classified.code, message: error?.message, model })
      }
      return this.#testRecord(startedAt, {
        state: STATUS.ERROR,
        code: typeof error?.code === 'string' ? error.code : 'UNAVAILABLE',
        message: error?.message,
        model,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async #executeTest(providerId, account) {
    const startedAt = Date.now()
    const section = await this.#store.provider(providerId)
    const record = (result) => this.#testRecord(startedAt, result)

    const keyHit = await this.#ctx.credentials.resolve(account.credentialRef).catch(() => undefined)
    if (typeof keyHit?.value !== 'string' || keyHit.value.length === 0) {
      return this.#persistTestResult(providerId, account.id, record({
        state: STATUS.INVALID,
        code: 'MISSING_CREDENTIAL',
        message: 'this account has no stored API key anymore',
      }))
    }

    let model
    try {
      model = await this.#pickTestModel(providerId)
    } catch (error) {
      return this.#persistTestResult(providerId, account.id, record({
        state: STATUS.ERROR,
        code: error.code ?? NO_TEST_MODEL_CODE,
        message: error.message,
      }))
    }

    if (!section?.ref) {
      return this.#persistTestResult(providerId, account.id, record({
        state: STATUS.ERROR,
        code: 'NO_CREDENTIAL_REF',
        message: 'provider route declares no API-key credential variable',
        model,
      }))
    }

    if (typeof this.#ctx.llm?.stream !== 'function') {
      return this.#persistTestResult(providerId, account.id, record({
        state: STATUS.ERROR,
        code: 'LLM_UNAVAILABLE',
        message: 'the llm service does not expose a stream() entry point in this composition',
        model,
      }))
    }

    const previous = await this.#ctx.credentials.resolve(section.ref).catch(() => undefined)
    let outcome
    try {
      await this.#ctx.credentials.set(section.ref, keyHit.value)
      outcome = await this.#probeStream({ providerId, model, marker: TEST_MARKER })
    } finally {
      try {
        if (typeof previous?.value === 'string') {
          await this.#ctx.credentials.set(section.ref, previous.value)
        } else {
          await this.#ctx.credentials.unset(section.ref)
        }
      } catch (restoreError) {
        this.#ctx.logger.warn('dsh-multi-account: credential restore after test failed: %s', restoreError?.message ?? restoreError)
      }
    }
    return this.#persistTestResult(providerId, account.id, outcome)
  }

  /** Write a test result onto the account record and return the stored shape. */
  async #persistTestResult(providerId, accountId, result) {
    await this.#store.update((draft) => {
      const account = draft.providers[providerId]?.accounts.find((candidate) => candidate.id === accountId)
      if (account) account.lastTest = result
    })
    return result
  }

  /**
   * Test one account of one provider (UI: per-row "Test" button).
   *
   * @param {{providerId?: unknown, accountId?: unknown}} input
   * @returns {Promise<{provider: object, result: object}>}
   */
  async runAccountTest(input) {
    const providerId = String(input?.providerId ?? '')
    const accountId = String(input?.accountId ?? '')
    const section = await this.#store.provider(providerId)
    const account = section?.accounts.find((candidate) => candidate.id === accountId)
    if (!account) {
      const error = new Error('account not found')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    const result = await this.#withProviderLock(providerId, () => this.#executeTest(providerId, account))
    this.#ctx.logger.info('dsh-multi-account: test of %s/%s finished: %s', providerId, account.label || account.id, result.state)
    return { provider: await this.describeProvider(providerId), result }
  }

  /**
   * Test every account of one provider, sequentially in id order. Disabled
   * accounts are included on purpose — a test should answer "would this key
   * work?" independently of the enable switch.
   *
   * @param {{providerId?: unknown}} input
   * @returns {Promise<{provider: object, results: Array<object>}>}
   */
  async testProvider(input) {
    const providerId = String(input?.providerId ?? '')
    const section = await this.#store.provider(providerId)
    if (!section) {
      const error = new Error('provider has no accounts yet')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    const accounts = section.accounts.slice(0, LIMITS.MAX_BATCH_TESTS)
    const results = []
    for (const account of accounts) {
      const result = await this.#withProviderLock(providerId, () => this.#executeTest(providerId, account))
      results.push({ providerId, accountId: account.id, ...result })
    }
    return { provider: await this.describeProvider(providerId), results }
  }

  /**
   * Test every account of every managed provider. Providers run one after
   * another so the generated load stays predictable; the whole batch is
   * capped by LIMITS.MAX_BATCH_TESTS.
   *
   * @returns {Promise<{providers: Array<object>, results: Array<object>}>}
   */
  async testAll() {
    const snapshot = await this.#store.snapshot()
    const results = []
    outer:
    for (const providerId of Object.keys(snapshot.providers)) {
      const section = snapshot.providers[providerId]
      for (const account of section.accounts) {
        if (results.length >= LIMITS.MAX_BATCH_TESTS) break outer
        const result = await this.#withProviderLock(providerId, () => this.#executeTest(providerId, account))
        results.push({ providerId, accountId: account.id, ...result })
      }
    }
    return { providers: await this.describeAll(), results }
  }

  /**
   * Resolve every model id a provider can be tested against: the adapter's
   * live catalog first (authoritative for what the route serves), then the
   * llm-pi-ai profile configuration as an offline fallback.
   *
   * @param {string} providerId route id.
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async #resolveTestModels(providerId) {
    const seen = new Set()
    const models = []
    try {
      const catalog = await this.#ctx.llm.listModels(providerId)
      for (const entry of catalog ?? []) {
        if (typeof entry?.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) continue
        seen.add(entry.id)
        models.push({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id })
      }
    } catch (error) {
      this.#ctx.logger.warn('dsh-multi-account: llm.listModels(%s) failed: %s', providerId, error?.message ?? error)
    }
    if (models.length === 0) {
      const configured = await this.#directory.providerModels(providerId).catch(() => [])
      for (const id of configured) {
        if (seen.has(id)) continue
        seen.add(id)
        models.push({ id, name: id })
      }
    }
    return models
  }

  /**
   * Client-safe model list for one provider with each model's latest test
   * result. Kept separate from `describeAll` so merely opening the manager
   * does not fan out catalog requests for every provider.
   *
   * @param {{providerId?: unknown}} input
   * @returns {Promise<{providerId: string, displayName: string, models: Array<object>}>}
   */
  async listProviderModels(input) {
    const providerId = String(input?.providerId ?? '')
    if (!providerId || providerId.length > LIMITS.MAX_PROVIDER_ID) {
      const error = new Error('providerId is required')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    const [models, snapshot, described] = await Promise.all([
      this.#resolveTestModels(providerId),
      this.#store.snapshot(),
      this.#directory.describe(providerId).catch(() => null),
    ])
    const results = snapshot.modelTests?.[providerId] ?? {}
    return {
      providerId,
      displayName: described?.displayName ?? providerId,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        lastTest: results[model.id] ?? null,
      })),
    }
  }

  /** Persist one model probe result in the provider-keyed modelTests map. */
  async #persistModelTest(providerId, model, result) {
    await this.#store.update((draft) => {
      draft.modelTests ??= {}
      draft.modelTests[providerId] ??= {}
      draft.modelTests[providerId][model] = result
    })
    return result
  }

  /**
   * Probe one model on the provider's currently committed key — the active
   * account when the provider is managed, otherwise the key saved in
   * Settings → Models. No credential is swapped, so nothing needs restoring.
   *
   * @param {string} providerId route id.
   * @param {string} model exact model id.
   * @returns {Promise<object>} normalized test result.
   */
  async #executeModelTest(providerId, model) {
    const startedAt = Date.now()
    const section = await this.#store.provider(providerId)
    if (section?.accounts.length > 0) {
      try {
        // Idempotent: rewrites nothing when the active key is already in place.
        await this.commitActive(providerId, section)
      } catch (error) {
        return this.#persistModelTest(providerId, model, this.#testRecord(startedAt, {
          state: STATUS.INVALID,
          code: 'MISSING_CREDENTIAL',
          message: error?.message ?? 'the active account has no usable API key',
          model,
        }))
      }
    }
    if (typeof this.#ctx.llm?.stream !== 'function') {
      return this.#persistModelTest(providerId, model, this.#testRecord(startedAt, {
        state: STATUS.ERROR,
        code: 'LLM_UNAVAILABLE',
        message: 'the llm service does not expose a stream() entry point in this composition',
        model,
      }))
    }
    const result = await this.#probeStream({ providerId, model, marker: MODEL_TEST_MARKER })
    return this.#persistModelTest(providerId, model, result)
  }

  /**
   * Test one model of one provider (UI: per-model "Test" button).
   *
   * @param {{providerId?: unknown, model?: unknown}} input
   * @returns {Promise<{providerId: string, model: string, result: object}>}
   */
  async runModelTest(input) {
    const providerId = String(input?.providerId ?? '')
    const model = String(input?.model ?? '')
    if (!providerId || providerId.length > LIMITS.MAX_PROVIDER_ID) {
      const error = new Error('providerId is required')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    if (!model || model.length > LIMITS.MAX_MODEL_ID) {
      const error = new Error('model id is required')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    const result = await this.#withProviderLock(providerId, () => this.#executeModelTest(providerId, model))
    this.#ctx.logger.info('dsh-multi-account: model test %s/%s finished: %s', providerId, model, result.state)
    return { providerId, model, result }
  }

  /**
   * Test every discoverable model of one provider, sequentially.
   *
   * @param {{providerId?: unknown}} input
   * @returns {Promise<{models: Array<object>, results: Array<object>}>}
   */
  async testProviderModels(input) {
    const providerId = String(input?.providerId ?? '')
    if (!providerId || providerId.length > LIMITS.MAX_PROVIDER_ID) {
      const error = new Error('providerId is required')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    const models = await this.#resolveTestModels(providerId)
    if (models.length === 0) {
      const error = new Error(`no model is configured for provider "${providerId}" to test against`)
      error.code = NO_TEST_MODEL_CODE
      error.status = 409
      throw error
    }
    const results = []
    for (const { id } of models.slice(0, LIMITS.MAX_BATCH_TESTS)) {
      const result = await this.#withProviderLock(providerId, () => this.#executeModelTest(providerId, id))
      results.push({ providerId, model: id, ...result })
    }
    const refreshed = await this.listProviderModels({ providerId })
    return { models: refreshed.models, results }
  }

  /**
   * Test every discoverable model of every configurable provider. Providers
   * and models are walked sequentially; the run is capped by
   * LIMITS.MAX_BATCH_TESTS. Providers without accounts are included — their
   * probe uses the key saved in the Models settings.
   *
   * @returns {Promise<{results: Array<object>}>}
   */
  async testAllModels() {
    const entries = await this.#directory.list()
    const results = []
    outer:
    for (const entry of entries) {
      const providerId = entry.provider
      const models = await this.#resolveTestModels(providerId)
      for (const { id } of models) {
        if (results.length >= LIMITS.MAX_BATCH_TESTS) break outer
        const result = await this.#withProviderLock(providerId, () => this.#executeModelTest(providerId, id))
        results.push({ providerId, model: id, ...result })
      }
    }
    return { results }
  }

  /**
   * Prepare one outgoing request: enforce the active key and (round robin)
   * rotate first. Failures here must never break model traffic, so callers
   * catch and log around it.
   *
   * @param {string} providerId route id from the llm/stream options.
   */
  async prepareRequest(providerId) {
    if (typeof providerId !== 'string' || providerId.length === 0) return
    const section = await this.#store.provider(providerId)
    if (!section || section.accounts.length === 0) return
    // Reconcile a credential ref the user edited in the Models settings after
    // the account section was created, so commits always target the route the
    // adapter actually reads.
    const described = await this.#directory.describe(providerId).catch(() => null)
    if (described?.ref && described.ref !== section.ref) {
      await this.#store.update((draft) => {
        const target = draft.providers[providerId]
        if (target) target.ref = described.ref
      })
    }
    const enabled = section.accounts.filter((account) => account.enabled)
    if (enabled.length === 0) return

    if (section.mode === MODES.ROUND_ROBIN && enabled.length > 1) {
      const nextIndex = (section.rrCursor + 1) % enabled.length
      const next = enabled[nextIndex]
      await this.#store.update((draft) => {
        const target = draft.providers[providerId]
        const live = target.accounts.filter((account) => account.enabled)
        const chosen = live[(target.rrCursor + 1) % live.length]
        if (!chosen) return
        target.rrCursor = (target.rrCursor + 1) % live.length
        target.activeAccountId = chosen.id
      })
      this.#ctx.logger.info('dsh-multi-account: round-robin selected %s on %s', next.label || next.id, providerId)
    } else {
      const active = section.accounts.find((account) => account.id === section.activeAccountId)
      if (!active || !active.enabled) {
        const fallback = AccountManager.pickAccount(section.accounts)
        if (fallback) {
          await this.#store.update((draft) => {
            draft.providers[providerId].activeAccountId = fallback.id
          })
        }
      }
    }
    await this.commitActive(providerId)
  }

  /**
   * Handle one terminal request failure.
   *
   * @param {object} payload agent/request-error waterfall payload.
   * @returns {Promise<{retry: boolean}|null>} retry decision.
   */
  async handleRequestError(payload) {
    const providerId = payload?.provider
    const failure = payload?.failure
    const code = typeof failure?.code === 'string' ? failure.code : ''
    if (typeof providerId !== 'string' || !code) return null

    const section = await this.#store.provider(providerId)
    if (!section || section.accounts.length === 0) return null
    // Manual mode surfaces failures but never changes the active account.
    if (section.mode === MODES.MANUAL) {
      if (HARD_SWITCH_CODES.includes(code) || code === RATE_LIMIT_CODE) {
        await this.#recordStatus(providerId, section.activeAccountId, code, failure?.message)
      }
      return null
    }
    if (!HARD_SWITCH_CODES.includes(code) && code !== RATE_LIMIT_CODE) return null

    const budget = this.#retryBudget(payload, section.accounts.filter((a) => a.enabled).length)
    if (!budget.allowed) return null

    const activeId = section.activeAccountId
    await this.#recordStatus(providerId, activeId, code, failure?.message)

    const refreshed = await this.#store.provider(providerId)
    // Only rotate to a *different* enabled account. Re-dispatching the same
    // account that just failed would burn the retry budget without changing
    // anything; with no alternative the host's own failure path runs.
    const fallback = AccountManager.pickAccount(refreshed.accounts, activeId)
    if (!fallback) return null

    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      target.activeAccountId = fallback.id
      const index = target.accounts.findIndex((account) => account.id === fallback.id)
      if (index >= 0) target.rrCursor = index
    })
    await this.commitActive(providerId)
    this.#ctx.logger.warn(
      'dsh-multi-account: %s failed with %s on %s; switched to %s and retrying',
      activeId ?? 'active-account', code, providerId, fallback.label || fallback.id,
    )
    return { retry: true }
  }

  /** Per-step cap so a fully dead provider cannot loop forever. */
  #budgets = new Map()

  #retryBudget(payload, enabledCount) {
    const key = `${payload?.agent?.session?.id ?? 'session'}:${payload?.turn ?? '?'}:${payload?.step ?? '?'}`
    const now = Date.now()
    for (const [existing, entry] of this.#budgets) {
      if (now - entry.at > 10 * 60 * 1000) this.#budgets.delete(existing)
    }
    const entry = this.#budgets.get(key) ?? { count: 0, at: now }
    entry.count += 1
    entry.at = now
    this.#budgets.set(key, entry)
    const cap = Math.min(enabledCount, LIMITS.MAX_AUTO_SWITCH_PER_STEP)
    return { allowed: entry.count <= cap }
  }

  async #recordStatus(providerId, accountId, code, message) {
    if (!accountId) return
    const classified = statusForCode(code)
    if (!classified) return
    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      const account = target?.accounts.find((candidate) => candidate.id === accountId)
      if (!account) return
      account.status = {
        state: classified.state,
        code,
        message: typeof message === 'string' ? message.slice(0, 200) : null,
        at: Date.now(),
      }
    })
  }
}

/**
 * Register the runtime event listeners. The returned disposer is owned by
 * the plugin fiber through ctx.effect.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {AccountManager} manager
 * @returns {() => void}
 */
export function mountSwitcher(ctx, manager) {
  const streamListener = ctx.on('llm/stream', async (options, next) => {
    // Account tests commit the target key themselves; model tests run on the
    // already committed active key. In both cases the normal prepare step
    // (notably round-robin rotation) must stay out of the probe.
    if (!options?.[TEST_MARKER] && !options?.[MODEL_TEST_MARKER]) {
      try {
        await manager.prepareRequest(options?.provider)
      } catch (error) {
        ctx.logger.warn('dsh-multi-account: pre-request account prepare failed: %s', error?.message ?? error)
      }
    }
    return next()
  }, { global: true, prepend: true })

  const errorListener = ctx.on('agent/request-error', async (payload, next) => {
    try {
      const signal = payload?.signal
      const decision = await manager.handleRequestError(payload)
      if (decision?.retry) {
        if (signal?.aborted) return next()
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, LIMITS.AUTO_RETRY_DELAY_MS)
          signal?.addEventListener?.('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (signal?.aborted) return next()
        return { kind: 'retry' }
      }
    } catch (error) {
      ctx.logger.warn('dsh-multi-account: automatic switch failed: %s', error?.message ?? error)
    }
    return next()
  }, { global: true, prepend: true })

  return () => {
    streamListener?.()
    errorListener?.()
  }
}
