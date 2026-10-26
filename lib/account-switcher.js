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
  newAccountId,
  randomNonce,
  normalizeApiKey,
  RATE_LIMIT_CODE,
  STATUS,
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

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('./state-store.js').StateStore} store
   * @param {import('./provider-directory.js').ProviderDirectory} directory
   */
  constructor(ctx, store, directory) {
    this.#ctx = ctx
    this.#store = store
    this.#directory = directory
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
    try {
      await manager.prepareRequest(options?.provider)
    } catch (error) {
      ctx.logger.warn('dsh-multi-account: pre-request account prepare failed: %s', error?.message ?? error)
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
