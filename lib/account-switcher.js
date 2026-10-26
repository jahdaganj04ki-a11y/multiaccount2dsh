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
  ABORTED_CODE,
  accountCredentialRef,
  DEFAULT_COOLDOWN_MS,
  HARD_SWITCH_CODES,
  isCredentialRef,
  isJobScope,
  isMode,
  JOB_SCOPES,
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
  #cooldownMs
  /** providerId -> promise chain serializing the temporary credential swaps. */
  #testLocks = new Map()
  /** AbortControllers of in-flight probes, aborted together on plugin unload. */
  #activeControllers = new Set()
  /** Background batch-test jobs keyed by job id. */
  #jobs = new Map()

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('./state-store.js').StateStore} store
   * @param {import('./provider-directory.js').ProviderDirectory} directory
   * @param {{ testTimeoutMs?: number, cooldownMs?: number }} [options]
   */
  constructor(ctx, store, directory, options = {}) {
    this.#ctx = ctx
    this.#store = store
    this.#directory = directory
    const timeout = Number(options.testTimeoutMs)
    this.#testTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : LIMITS.TEST_TIMEOUT_MS
    const cooldown = Number(options.cooldownMs)
    this.#cooldownMs = Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_COOLDOWN_MS
  }

  /** Stop every in-flight probe and background job (plugin unload). */
  dispose() {
    for (const job of this.#jobs.values()) {
      if (job.status === 'running') job.controller.abort()
    }
    for (const controller of this.#activeControllers) {
      controller.abort()
    }
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

    let becameEmpty = false
    await this.#store.update((draft) => {
      const target = draft.providers[providerId]
      target.accounts = target.accounts.filter((candidate) => candidate.id !== accountId)
      if (target.activeAccountId === accountId) {
        const fallback = target.accounts.find((candidate) => candidate.enabled) ?? null
        target.activeAccountId = fallback?.id ?? null
      }
      // With no accounts left there is nothing to manage: drop the whole
      // section instead of keeping an empty "managed" provider forever.
      if (target.accounts.length === 0) {
        delete draft.providers[providerId]
        becameEmpty = true
      }
    })
    if (becameEmpty) {
      const described = await this.describeAll()
      // The route is no longer configurable: return an explicit unmanaged
      // stub rather than another provider's view.
      return described.find((entry) => entry.providerId === providerId)
        ?? { providerId, displayName: providerId, settingsNs: 'llm-pi-ai', ref: null, refConfigured: false, managed: false, mode: MODES.MANUAL, activeAccountId: null, accounts: [] }
    }
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
   * @param {{providerId: string, model: string, marker: symbol, externalSignal?: AbortSignal}} spec
   * @returns {Promise<object>} normalized test result.
   */
  async #probeStream({ providerId, model, marker, externalSignal }) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#testTimeoutMs)
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal
    this.#activeControllers.add(controller)
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
        signal,
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
      if (externalSignal?.aborted) {
        return this.#testRecord(startedAt, { state: STATUS.ERROR, code: ABORTED_CODE, message: 'test aborted', model })
      }
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
      this.#activeControllers.delete(controller)
    }
  }

  async #executeTest(providerId, account, externalSignal) {
    const startedAt = Date.now()
    const section = await this.#store.provider(providerId)
    const record = (result) => this.#testRecord(startedAt, result)
    if (externalSignal?.aborted) {
      return record({ state: STATUS.ERROR, code: ABORTED_CODE, message: 'test aborted' })
    }

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
      outcome = await this.#probeStream({ providerId, model, marker: TEST_MARKER, externalSignal })
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
    // A user-cancelled probe must not overwrite a previous good result.
    if (outcome.code === ABORTED_CODE) return outcome
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

  /** Client-safe job view (no AbortController or other non-JSON fields). */
  #jobView(job) {
    return {
      id: job.id,
      scope: job.scope,
      providerId: job.providerId,
      status: job.status,
      total: job.total,
      done: job.done,
      ok: job.ok,
      failed: job.failed,
      results: job.results,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    }
  }

  /** Running jobs, used by the client to re-attach after a modal reopen. */
  activeJobs() {
    return [...this.#jobs.values()]
      .filter((job) => job.status === 'running')
      .map((job) => this.#jobView(job))
  }

  /**
   * Start a background batch-test job. Only one job runs at a time so the
   * per-provider credential swaps cannot interleave; the route returns
   * immediately and progress is read through `jobProgress`.
   *
   * @param {{scope?: unknown, providerId?: unknown}} input
   * @returns {Promise<object>} the initial job view.
   */
  async startJob(input) {
    const scope = String(input?.scope ?? '')
    if (!isJobScope(scope)) {
      const error = new Error(`scope must be one of: ${Object.values(JOB_SCOPES).join(', ')}`)
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    if ([...this.#jobs.values()].some((job) => job.status === 'running')) {
      const error = new Error('another test batch is already running')
      error.code = 'JOB_RUNNING'
      error.status = 409
      throw error
    }

    // Resolve the work list before creating the job so configuration errors
    // (unknown provider, no models) surface as normal route errors.
    const work = await this.#planJob(scope, String(input?.providerId ?? ''))

    const job = {
      id: `job_${randomNonce()}`,
      scope,
      providerId: String(input?.providerId ?? '') || null,
      status: 'running',
      total: work.length,
      done: 0,
      ok: 0,
      failed: 0,
      results: [],
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      controller: new AbortController(),
    }
    this.#retainJob(job)
    void this.#runJob(job, work)
    return this.#jobView(job)
  }

  /** Bound the retained finished jobs so the map cannot grow unbounded. */
  #retainJob(job) {
    this.#jobs.set(job.id, job)
    const finished = [...this.#jobs.values()].filter((entry) => entry.status !== 'running')
    if (finished.length > LIMITS.MAX_FINISHED_JOBS) {
      for (const stale of finished.slice(0, finished.length - LIMITS.MAX_FINISHED_JOBS)) {
        this.#jobs.delete(stale.id)
      }
    }
  }

  /** Build the ordered probe list for a scope, throwing user-facing errors. */
  async #planJob(scope, providerId) {
    if (scope === JOB_SCOPES.PROVIDER_ACCOUNTS || scope === JOB_SCOPES.ALL_ACCOUNTS) {
      const snapshot = await this.#store.snapshot()
      const sections = scope === JOB_SCOPES.PROVIDER_ACCOUNTS
        ? [[providerId, snapshot.providers[providerId]]]
        : Object.entries(snapshot.providers)
      if (scope === JOB_SCOPES.PROVIDER_ACCOUNTS && !snapshot.providers[providerId]) {
        const error = new Error('provider has no accounts yet')
        error.code = 'NOT_FOUND'
        error.status = 404
        throw error
      }
      const work = []
      for (const [pid, section] of sections) {
        for (const account of section.accounts) {
          if (work.length >= LIMITS.MAX_BATCH_TESTS) return work
          work.push({ kind: 'account', providerId: pid, account })
        }
      }
      return work
    }

    const entries = scope === JOB_SCOPES.PROVIDER_MODELS
      ? [{ provider: providerId }]
      : await this.#directory.list()
    const work = []
    for (const entry of entries) {
      const pid = entry.provider
      const models = await this.#resolveTestModels(pid)
      if (scope === JOB_SCOPES.PROVIDER_MODELS && models.length === 0) {
        const error = new Error(`no model is configured for provider "${pid}" to test against`)
        error.code = NO_TEST_MODEL_CODE
        error.status = 409
        throw error
      }
      for (const model of models) {
        if (work.length >= LIMITS.MAX_BATCH_TESTS) return work
        work.push({ kind: 'model', providerId: pid, model: model.id })
      }
    }
    return work
  }

  /** Drive one job to completion, recording each probe as it finishes. */
  async #runJob(job, work) {
    const signal = job.controller.signal
    try {
      for (const item of work) {
        if (signal.aborted) break
        const result = item.kind === 'account'
          ? await this.#withProviderLock(item.providerId, () => this.#executeTest(item.providerId, item.account, signal))
          : await this.#withProviderLock(item.providerId, () => this.#executeModelTest(item.providerId, item.model, signal))
        // Record even the probe interrupted by an abort so the progress view
        // shows what happened; it counts as a failure, never a success.
        const row = item.kind === 'account'
          ? { providerId: item.providerId, accountId: item.account.id, ...result }
          : { providerId: item.providerId, model: item.model, ...result }
        job.results.push(row)
        job.done += 1
        if (result.state === STATUS.OK) job.ok += 1
        else job.failed += 1
        if (signal.aborted) break
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message.slice(0, 200) : String(error)
      job.status = 'error'
    }
    if (job.status === 'running') {
      job.status = signal.aborted ? 'aborted' : 'done'
    }
    job.finishedAt = Date.now()
    this.#ctx.logger.info('dsh-multi-account: job %s finished: %s (%s/%s ok)', job.id, job.status, job.ok, job.done)
  }

  /** Read one job's progress. @param {{jobId?: unknown}} input */
  jobProgress(input) {
    const jobId = String(input?.jobId ?? '')
    const job = this.#jobs.get(jobId)
    if (!job) {
      const error = new Error('test job not found')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    return this.#jobView(job)
  }

  /** Abort a running job; its in-flight probe stops at the next signal check. */
  abortJob(input) {
    const jobId = String(input?.jobId ?? '')
    const job = this.#jobs.get(jobId)
    if (!job) {
      const error = new Error('test job not found')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    if (job.status === 'running') job.controller.abort()
    return this.#jobView(job)
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
    const validIds = new Set(models.map((model) => model.id))
    const stored = snapshot.modelTests?.[providerId] ?? {}
    const staleIds = Object.keys(stored).filter((id) => !validIds.has(id))
    if (staleIds.length > 0) {
      // Drop results for models the provider no longer exposes, including
      // empty provider rows, so the modelTests map cannot grow forever.
      await this.#store.update((draft) => {
        const row = draft.modelTests?.[providerId]
        if (!row) return
        for (const id of staleIds) delete row[id]
        if (Object.keys(row).length === 0) delete draft.modelTests[providerId]
      })
    }
    return {
      providerId,
      displayName: described?.displayName ?? providerId,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        lastTest: stored[model.id] ?? null,
      })),
    }
  }

  /**
   * Forget a provider completely: remove its account section, every stored
   * account credential and its model-test results. The key saved on the
   * route ref itself is left untouched, matching the pre-managed state.
   *
   * @param {{providerId?: unknown}} input
   * @returns {Promise<{providers: Array<object>}>}
   */
  async forgetProvider(input) {
    const providerId = String(input?.providerId ?? '')
    const section = await this.#store.provider(providerId)
    if (!section && !(await this.#store.snapshot()).modelTests?.[providerId]) {
      const error = new Error('provider not found')
      error.code = 'NOT_FOUND'
      error.status = 404
      throw error
    }
    for (const account of section?.accounts ?? []) {
      await this.#ctx.credentials.unset(account.credentialRef).catch((error) => {
        this.#ctx.logger.warn('dsh-multi-account: credential unset failed: %s', error?.message ?? error)
      })
    }
    await this.#store.update((draft) => {
      delete draft.providers[providerId]
      if (draft.modelTests) delete draft.modelTests[providerId]
    })
    return { providers: await this.describeAll() }
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
  async #executeModelTest(providerId, model, externalSignal) {
    const startedAt = Date.now()
    if (externalSignal?.aborted) {
      return this.#testRecord(startedAt, { state: STATUS.ERROR, code: ABORTED_CODE, message: 'test aborted', model })
    }
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
    const result = await this.#probeStream({ providerId, model, marker: MODEL_TEST_MARKER, externalSignal })
    if (result.code === ABORTED_CODE) return result
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
   * Whether an account may receive rotation traffic right now. A flagged
   * account stays parked until either its flag is cleared manually or the
   * cooldown elapses, when it gets one fresh chance. A flag without a
   * timestamp is respected indefinitely.
   *
   * @param {object} account detached account record.
   * @param {number} now current epoch milliseconds.
   * @returns {boolean}
   */
  #isHealthy(account, now) {
    const state = account.status?.state
    if (!state || state === STATUS.OK || !BAD_STATES.has(state)) return true
    const at = account.status?.at
    if (!Number.isFinite(at)) return false
    return now - at >= this.#cooldownMs
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
      const now = Date.now()
      let chosenLabel = null
      // Selection happens inside the serialized write so concurrent requests
      // each observe the cursor the previous one just committed.
      await this.#store.update((draft) => {
        const target = draft.providers[providerId]
        if (!target) return
        const live = target.accounts.filter((account) => account.enabled)
        if (live.length < 2) return
        const healthy = live.filter((account) => this.#isHealthy(account, now))
        // When every account is flagged, fall back to the full enabled pool:
        // trying one is still better than guaranteeing a credential failure.
        const pool = healthy.length > 0 ? healthy : live
        const current = live.find((account) => account.id === target.activeAccountId)
        const startIndex = current ? live.indexOf(current) : target.rrCursor
        for (let step = 1; step <= live.length; step += 1) {
          const candidate = live[(startIndex + step) % live.length]
          if (pool.includes(candidate)) {
            target.rrCursor = live.indexOf(candidate)
            target.activeAccountId = candidate.id
            chosenLabel = candidate.label || candidate.id
            return
          }
        }
      })
      if (chosenLabel) {
        this.#ctx.logger.info('dsh-multi-account: round-robin selected %s on %s', chosenLabel, providerId)
      }
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
