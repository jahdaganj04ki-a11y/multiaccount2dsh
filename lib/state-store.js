/**
 * Durable state for dsh-multi-account.
 *
 * The document holds per-provider account metadata and switching policy only.
 * API keys themselves live in the host credentials service under each
 * account's generated credential ref, so a backup or screenshot of this file
 * can never carry a secret.
 *
 * All reads/writes funnel through one in-process operation chain, matching
 * the serialized-write convention of dsh-credentials-local. Writes use
 * dsh-atomic-write so Windows readers never observe a half-renamed document.
 *
 * @module dsh-multi-account/state-store
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  LIMITS,
  MODES,
  MODE_VALUES,
  STATE_FILENAME,
  STATE_VERSION,
  STATUS,
} from './protocol.js'

function emptyState() {
  return { version: STATE_VERSION, providers: {}, modelTests: {} }
}

/**
 * Model-test results live in their own top-level map, keyed by provider and
 * model id, so probing models works even for providers without managed
 * accounts and never flips a provider's `managed` flag.
 */
function normalizeModelTests(value) {
  if (!value || typeof value !== 'object') return {}
  const result = {}
  for (const [providerId, models] of Object.entries(value)) {
    if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > LIMITS.MAX_PROVIDER_ID) continue
    if (!models || typeof models !== 'object') continue
    const row = {}
    for (const [modelId, test] of Object.entries(models)) {
      if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > LIMITS.MAX_MODEL_ID) continue
      const normalized = normalizeLastTest(test)
      if (normalized) row[modelId] = normalized
    }
    result[providerId] = row
  }
  return result
}

function normalizeLastTest(value) {
  if (!value || typeof value !== 'object') return null
  const state = Object.values(STATUS).includes(value.state) ? value.state : STATUS.ERROR
  return {
    state,
    code: typeof value.code === 'string' ? value.code.slice(0, 64) : null,
    message: typeof value.message === 'string' ? value.message.slice(0, 200) : null,
    at: Number.isFinite(value.at) ? value.at : null,
    latencyMs: Number.isFinite(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : null,
    model: typeof value.model === 'string' ? value.model.slice(0, 128) : null,
  }
}

function normalizeProvider(entry) {
  const accounts = Array.isArray(entry?.accounts) ? entry.accounts : []
  const mode = MODE_VALUES.includes(entry?.mode) ? entry.mode : MODES.MANUAL
  return {
    // Credential ref the provider route actually reads (its apiKeyEnv).
    ref: typeof entry?.ref === 'string' ? entry.ref : '',
    mode,
    activeAccountId: typeof entry?.activeAccountId === 'string' ? entry.activeAccountId : null,
    rrCursor: Number.isInteger(entry?.rrCursor) && entry.rrCursor >= 0 ? entry.rrCursor : 0,
    accounts: accounts.map((account) => ({
      id: String(account.id),
      label: String(account.label ?? ''),
      credentialRef: String(account.credentialRef),
      enabled: account.enabled !== false,
      createdAt: Number.isFinite(account.createdAt) ? account.createdAt : Date.now(),
      status: {
        state: Object.values(STATUS).includes(account?.status?.state) ? account.status.state : STATUS.OK,
        code: typeof account?.status?.code === 'string' ? account.status.code : null,
        message: typeof account?.status?.message === 'string' ? account.status.message : null,
        at: Number.isFinite(account?.status?.at) ? account.status.at : null,
      },
      lastTest: normalizeLastTest(account?.lastTest),
    })),
  }
}

export class StateStore {
  #root
  #path
  #ready
  #chain = Promise.resolve()
  #state

  /** @param {string} root private data directory (from plugin config). */
  constructor(root) {
    if (typeof root !== 'string' || root.length === 0) {
      throw new Error('dsh-multi-account: config.root must be a non-empty path')
    }
    this.#root = root
    this.#path = join(root, STATE_FILENAME)
    this.#state = emptyState()
    this.#ready = this.#load()
  }

  /** Resolves once the initial document read finished (or failed and reset). */
  get ready() {
    return this.#ready
  }

  get path() {
    return this.#path
  }

  async #load() {
    try {
      const { readFile } = await import('node:fs/promises')
      const text = await readFile(this.#path, 'utf8')
      const parsed = JSON.parse(text)
      const providers = parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object'
        ? parsed.providers
        : {}
      this.#state = {
        version: STATE_VERSION,
        providers: Object.fromEntries(
          Object.entries(providers)
            .filter(([id]) => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.MAX_PROVIDER_ID)
            .map(([id, entry]) => [id, normalizeProvider(entry)]),
        ),
        // Absent in documents written before model tests existed.
        modelTests: normalizeModelTests(parsed.modelTests),
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt document must not take Harness down: start empty and let
        // the next write replace the file, keeping the failure diagnosable.
        this.readyError = error
      }
      this.#state = emptyState()
    }
  }

  /**
   * Serialize one read-modify-write cycle. The mutator receives a deep clone;
   * its return value (if defined) replaces the stored provider section,
   * otherwise the mutated clone is committed.
   *
   * @param {(state: object) => object|void} mutator
   * @returns {Promise<object>} the committed state snapshot.
   */
  async update(mutator) {
    const run = this.#chain.then(async () => {
      await this.#ready
      const draft = structuredClone(this.#state)
      const result = await mutator(draft)
      const next = result ?? draft
      await mkdir(this.#root, { recursive: true })
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      this.#state = next
      return structuredClone(next)
    })
    // Keep the chain alive even when one mutation rejects, so later calls run.
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** @returns {Promise<object>} detached snapshot of the whole document. */
  async snapshot() {
    await this.#ready
    return structuredClone(this.#state)
  }

  /**
   * @param {string} providerId route id.
   * @returns {Promise<object|null>} detached provider section or null.
   */
  async provider(providerId) {
    const state = await this.snapshot()
    return state.providers[providerId] ? structuredClone(state.providers[providerId]) : null
  }

  /**
   * Ensure a provider section exists, creating it on first use.
   *
   * @param {string} providerId route id.
   * @param {string} ref credential ref the route reads.
   * @param {string} [mode] initial mode when the section is new.
   * @returns {Promise<object>} the committed provider section.
   */
  async ensureProvider(providerId, ref, mode = MODES.MANUAL) {
    const state = await this.update((draft) => {
      if (!draft.providers[providerId]) {
        draft.providers[providerId] = normalizeProvider({ ref, mode })
      } else if (ref && draft.providers[providerId].ref !== ref) {
        // The route's apiKeyEnv can be edited in the Models settings page;
        // adopt the new ref while keeping every account record.
        draft.providers[providerId].ref = ref
      }
    })
    return state.providers[providerId]
  }
}
