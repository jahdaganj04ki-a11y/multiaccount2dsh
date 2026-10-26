/**
 * Shared constants and boundary validation for dsh-multi-account (server side).
 *
 * The client mirrors the wire shapes but loads as a standalone single-file
 * module, so nothing in this file may import Node-only or host-only modules.
 *
 * @module dsh-multi-account/protocol
 */

/** Plugin/namespace identity. */
export const PLUGIN_NAME = 'dsh-multi-account'

/** HTTP route prefix; every endpoint the plugin owns lives underneath it. */
export const ROUTE_PREFIX = '/api/multi-account.'

/** State document version written by this build. */
export const STATE_VERSION = 1

/** File name of the private state document inside the configured root. */
export const STATE_FILENAME = 'state.json'

/** Account switching modes offered in the account manager window. */
export const MODES = Object.freeze({
  /** The active account changes only when the user clicks one. */
  MANUAL: 'manual',
  /** Keep the active account until a request fails with an auth/quota code, then rotate. */
  ON_ERROR: 'on-error',
  /** Advance to the next enabled account before every request. */
  ROUND_ROBIN: 'round-robin',
})

export const MODE_VALUES = Object.freeze(Object.values(MODES))

/**
 * Failure codes that prove the *account* (not the request shape) is unusable,
 * mirrored from the canonical Harness/pi-ai classifications:
 * - `AUTH` is pi-ai's 401/403 mapping (`classifyPiAiError` in dsh-llm-pi-ai)
 * - `INVALID_CREDENTIAL`, `QUOTA`, `ACCOUNT_QUOTA` are exported dsh-llm codes
 * - `MISSING_CREDENTIAL` means the route's ref currently resolves nothing
 */
export const HARD_SWITCH_CODES = Object.freeze([
  'AUTH',
  'INVALID_CREDENTIAL',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'MISSING_CREDENTIAL',
])

/** Transient rate limiting: rotate but keep the account eligible for later use. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT'

/** Human-facing account health states persisted on each account record. */
export const STATUS = Object.freeze({
  OK: 'ok',
  RATE_LIMITED: 'rate-limited',
  EXHAUSTED: 'exhausted',
  INVALID: 'invalid',
  ERROR: 'error',
})

/** Bounds keep one request from writing an arbitrarily large document. */
export const LIMITS = Object.freeze({
  MAX_BODY_BYTES: 32 * 1024,
  MAX_LABEL: 80,
  MAX_KEY: 512,
  MAX_REF: 128,
  MAX_PROVIDER_ID: 128,
  MAX_ACCOUNTS_PER_PROVIDER: 50,
  /** Per (session, turn, step) auto-switch cap; also bounded by account count. */
  MAX_AUTO_SWITCH_PER_STEP: 12,
  /** Delay before an automatic retry so the provider can settle quota counters. */
  AUTO_RETRY_DELAY_MS: 150,
  /** Wall-clock budget for one account test before its request is aborted. */
  TEST_TIMEOUT_MS: 20000,
  /** A test request asks for one token so it costs essentially no credit. */
  TEST_MAX_TOKENS: 1,
  /** Hard cap for "test all" batches so one click cannot fan out unbounded work. */
  MAX_BATCH_TESTS: 100,
})

/**
 * Marker property on `llm/stream` options identifying a plugin-owned account
 * test. The plugin's own prepended stream listener sees it and skips the
 * normal active-key commit/round-robin, because the test temporarily commits
 * the *target* account's key itself. A Symbol keeps the marker invisible to
 * host serialization and unrelated listeners.
 */
export const TEST_MARKER = Symbol.for('dsh-multi-account.test-request')

/** Synthetic code recorded when a test exceeds its wall-clock budget. */
export const TEST_TIMEOUT_CODE = 'TIMEOUT'

/** Synthetic code recorded when no model can be resolved for a provider. */
export const NO_TEST_MODEL_CODE = 'NO_MODEL'

/**
 * Mirror of `normalizeApiKey` in dsh-llm: printable ASCII, spaces excluded.
 * Keys are validated at every trust boundary instead of being trusted to
 * already match the credential-ref grammar.
 *
 * @param {unknown} raw candidate secret.
 * @returns {{ ok: true, value: string } | { ok: false, reason: 'empty' | 'illegal' }}
 */
export function normalizeApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'illegal' }
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (value.length > LIMITS.MAX_KEY) return { ok: false, reason: 'illegal' }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x21-\x7E]+$/.test(value)) return { ok: false, reason: 'illegal' }
  return { ok: true, value }
}

/**
 * Credential refs are POSIX shell identifiers (see dsh-credentials
 * `REF_PATTERN`); generated account refs must always satisfy it.
 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** @param {unknown} value candidate ref. @returns {boolean} */
export function isCredentialRef(value) {
  return typeof value === 'string' && value.length <= LIMITS.MAX_REF && REF_PATTERN.test(value)
}

/** @param {unknown} value candidate mode. @returns {boolean} */
export function isMode(value) {
  return typeof value === 'string' && MODE_VALUES.includes(value)
}

/**
 * Build the private credential ref that stores one account's key inside the
 * host credentials service. The provider route keeps its own ref (e.g.
 * `DEEPSEEK_API_KEY`); account refs are a separate namespace so removing an
 * account never touches unrelated configuration.
 *
 * @param {string} providerId route id from the configurable-provider directory.
 * @param {string} nonce short random suffix guaranteeing uniqueness.
 * @returns {string} a valid credential-ref identifier.
 */
export function accountCredentialRef(providerId, nonce) {
  const vendor = String(providerId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'PROVIDER'
  return `DSH_MA_${vendor}_${nonce}`
}

/** @returns {string} 10 lowercase hex chars, enough to avoid practical collisions. */
export function randomNonce() {
  // crypto is available in both the Harness Node process and the test runner.
  // eslint-disable-next-line no-undef
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(5))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** @returns {string} account record id. */
export function newAccountId() {
  return `acct_${randomNonce()}`
}

/**
 * Last four characters of a secret, for recognition in the UI without ever
 * exposing the whole value.
 *
 * @param {string|undefined} value resolved secret.
 * @returns {string|null}
 */
export function keyHint(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length <= 4 ? '•'.repeat(value.length) : `…${value.slice(-4)}`
}

/**
 * Read a bounded, buffered JSON request body. Matches the contract used by
 * host plugins registering `requestBody: 'buffered'` fetch routes.
 *
 * @param {Request} request incoming fetch Request.
 * @param {AbortSignal} [signal] cancellation.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(request, signal) {
  const text = await request.text()
  if (text.length > LIMITS.MAX_BODY_BYTES) {
    const error = new Error('request body is larger than the allowed size')
    error.code = 'PAYLOAD_TOO_LARGE'
    throw error
  }
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object')
    }
    signal?.throwIfAborted()
    return parsed
  } catch (error) {
    const wrapped = new Error('request body is not valid JSON')
    wrapped.code = 'BAD_REQUEST'
    wrapped.cause = error
    throw wrapped
  }
}

/**
 * Normalize an unknown thrown value into the stable error envelope the client
 * understands. Messages stay free of secrets.
 *
 * @param {unknown} error thrown value.
 * @returns {{ code: string, message: string, status: number }}
 */
export function safeError(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'UNAVAILABLE'
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : code === 'BAD_REQUEST' || code === 'PAYLOAD_TOO_LARGE' ? 400 : 500
  const message = error instanceof Error && error.message.length > 0 ? error.message : 'multi-account operation failed'
  return { code, message, status }
}
