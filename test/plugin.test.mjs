import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as plugin from '../index.js'
import { StateStore } from '../lib/state-store.js'
import { TEST_MARKER, MODEL_TEST_MARKER } from '../lib/protocol.js'

const PROVIDER = 'deepseek'
const REF = 'DEEPSEEK_API_KEY'
const OPENROUTER_REF = 'OPENROUTER_API_KEY'

/** Route ref each provider's key gets committed to during a test. */
const PROVIDER_REFS = new Map([[PROVIDER, REF], ['openrouter', OPENROUTER_REF]])

function mockLlm(entries, options = {}) {
  const streamCalls = []
  return {
    streamCalls,
    listConfigurableProviders: async () => entries,
    registerAdapter: () => ({ replace() {} }),
    registerConfigurableProviders: () => ({ replace() {} }),
    listModels: options.noModels
      ? async () => { throw Object.assign(new Error('catalog unavailable'), { code: 'NO_CATALOG' }) }
      : async (providerId) => (options.catalogModels?.get(providerId)
        ?? [{ provider: providerId, id: 'test-model', name: 'Test Model' }]),
    // Mimics the real llm service: returns an async iterable and rejects with
    // a classified LlmError when the currently committed key is denylisted.
    async *stream(streamOptions) {
      streamCalls.push(streamOptions)
      if (streamOptions?.[TEST_MARKER] || streamOptions?.[MODEL_TEST_MARKER]) {
        const routeRef = PROVIDER_REFS.get(streamOptions.provider)
        const hit = routeRef ? await options.readKey?.(routeRef) : undefined
        // Test-only observation of the key committed when the probe ran.
        streamOptions.__committedKey = hit
        const denylist = options.failKeys?.get(streamOptions.provider)
        if (denylist?.has(hit)) {
          throw Object.assign(new Error(`key ${hit} rejected by ${streamOptions.provider}`), { code: 'AUTH' })
        }
        if (options.hang) {
          await new Promise((resolve, reject) => {
            streamOptions.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
            }, { once: true })
          })
        }
      }
      yield { type: 'text', text: 'OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function mockConnection() {
  const routes = new Map()
  return {
    routes,
    fetch: {
      register: (spec) => {
        routes.set(spec.path, spec)
        return () => routes.delete(spec.path)
      },
    },
  }
}

function mockConfigEditor(providers) {
  return {
    configuration: () => [{
      entry: {
        options: { id: 'llm-pi-ai' },
        fiber: { config: { providers: { get: () => providers } } },
      },
    }],
  }
}

async function harness(overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ma-test-'))
  const app = new Context()
  const providers = overrides.providers ?? {
    [PROVIDER]: { apiKeyEnv: REF, displayName: 'DeepSeek' },
  }
  const llm = mockLlm([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: 'llm-pi-ai', settingsPath: ['providers', PROVIDER] },
    { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
  ], {
    failKeys: overrides.failKeys,
    hang: overrides.hang === true,
    noModels: overrides.noModels === true,
    catalogModels: overrides.catalogModels,
    readKey: async (refName) => (await app.credentials.resolve(refName))?.value,
  })
  const connection = mockConnection()
  app.provide('llm', llm)
  app.provide('connection', connection)
  if (!overrides.noConfigEditor) {
    app.provide('configEditor', mockConfigEditor(providers))
  }
  await app.plugin(LocalCredentialProvider, {
    path: join(home, '.credentials.yaml'),
    dshHome: home,
    watch: false,
  })
  await app.plugin(plugin, {
    root: join(home, 'multi-account'),
    ...overrides.testTimeoutMs === undefined ? {} : { testTimeoutMs: overrides.testTimeoutMs },
    ...overrides.cooldownMs === undefined ? {} : { cooldownMs: overrides.cooldownMs },
  })

  async function call(suffix, body) {
    const path = `/api/multi-account.${suffix}`
    const route = connection.routes.get(path)
    assert.ok(route, `route ${path} registered`)
    const request = new Request(`http://local${path}`, {
      method: suffix === 'state' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
    const response = await route.fetch(request)
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  /** Start a batch job and poll until it reaches a terminal state. */
  async function runJob(scope, extra = {}) {
    const started = await call('test-start', { scope, ...extra })
    assert.equal(started.status, 200)
    assert.equal(started.body.status, 'running')
    const jobId = started.body.id
    let body = started.body
    let polls = 0
    while (body.status === 'running') {
      // Yield a macrotask between polls: the in-memory fetch doubles resolve
      // purely on microtasks, and a tight loop would otherwise starve the
      // credential service's real file-I/O callbacks. A browser client polls
      // over real HTTP and never hits this.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const progress = await call('test-progress', { jobId })
      assert.equal(progress.status, 200)
      body = progress.body
      polls += 1
      if (polls > 200) throw new Error('job polling exceeded 200 iterations')
    }
    return body
  }

  /** Poll an already-started job (e.g. after an explicit abort) to its terminal state. */
  async function runJobLoopUntilTerminal(jobId) {
    let body
    for (let polls = 0; polls < 200; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const progress = await call('test-progress', { jobId })
      body = progress.body
      if (body.status !== 'running') return body
    }
    throw new Error('job never reached a terminal state')
  }

  async function refValue(refName = REF) {
    const hit = await app.credentials.resolve(refName)
    return hit?.value
  }

  async function stream(providerId = PROVIDER) {
    let innerCalled = 0
    const result = await app.waterfall('llm/stream', { provider: providerId }, async () => {
      innerCalled += 1
      return 'stream-result'
    })
    return { result, innerCalled }
  }

  async function requestError(code, extra = {}) {
    let innerCalled = 0
    const result = await app.waterfall('agent/request-error', {
      provider: PROVIDER,
      failure: { code, message: `provider said ${code}` },
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      ...extra,
    }, async () => {
      innerCalled += 1
      return 'inner-decision'
    })
    return { result, innerCalled }
  }

  return { app, home, call, runJob, runJobLoopUntilTerminal, refValue, stream, requestError, streamCalls: llm.streamCalls }
}

describe('dsh-multi-account', () => {
  let home

  beforeEach(async () => {
    // `home` is created per harness; afterEach only needs the tracked one.
  })

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined)
  })

  it('lists configurable providers with their refs and no accounts', async () => {
    const env = await harness()
    home = env.home
    const { status, body } = await env.call('state')
    assert.equal(status, 200)
    const deepseek = body.providers.find((p) => p.providerId === PROVIDER)
    assert.equal(deepseek.ref, REF)
    assert.equal(deepseek.managed, false)
    assert.deepEqual(deepseek.accounts, [])
  })

  it('adds an account, stores the secret in the credential service and commits the route ref', async () => {
    const env = await harness()
    home = env.home
    const { status, body } = await env.call('add', { providerId: PROVIDER, label: 'Main', apiKey: 'sk-key-1' })
    assert.equal(status, 200)
    assert.equal(body.provider.accounts.length, 1)
    assert.equal(body.provider.accounts[0].label, 'Main')
    assert.equal(body.provider.accounts[0].active, true)
    assert.equal(body.provider.accounts[0].keyHint, '…ey-1')
    assert.equal(await env.refValue(), 'sk-key-1')

    // State document carries no secret, only the generated credential ref.
    const stateText = await readFile(join(home, 'multi-account', 'state.json'), 'utf8')
    assert.ok(!stateText.includes('sk-key-1'))
    assert.match(stateText, /DSH_MA_DEEPSEEK_/)
    const mode = (await stat(join(home, 'multi-account', 'state.json'))).mode & 0o777
    assert.equal(mode, 0o600)
  })

  it('rejects malformed keys and oversized bodies at the boundary', async () => {
    const env = await harness()
    home = env.home
    const bad = await env.call('add', { providerId: PROVIDER, apiKey: 'has space' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'BAD_REQUEST')
    const empty = await env.call('add', { providerId: PROVIDER, apiKey: '   ' })
    assert.equal(empty.status, 400)
  })

  it('imports the key already saved on the route ref without sending it again', async () => {
    const env = await harness()
    home = env.home
    await env.app.credentials.set(REF, 'sk-existing')
    const { status, body } = await env.call('import', { providerId: PROVIDER, label: 'Imported' })
    assert.equal(status, 200)
    assert.equal(body.provider.accounts[0].label, 'Imported')
    assert.equal(await env.refValue(), 'sk-existing')
  })

  it('switches the active account manually and rewrites the route ref', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
    const accountB = (await env.call('state')).body.providers[0].accounts.find((a) => a.label === 'B')
    const switched = await env.call('switch', { providerId: PROVIDER, accountId: accountB.id })
    assert.equal(switched.body.provider.activeAccountId, accountB.id)
    assert.equal(await env.refValue(), 'sk-bbb')
    const refused = await env.call('switch', { providerId: PROVIDER, accountId: 'nonexistent' })
    assert.equal(refused.status, 404)
  })

  it('disabling the active account moves activation to another enabled account', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
    const state = (await env.call('state')).body.providers[0]
    const active = state.accounts.find((a) => a.active)
    await env.call('toggle', { providerId: PROVIDER, accountId: active.id, enabled: false })
    assert.equal(await env.refValue(), 'sk-bbb')
    const after = (await env.call('state')).body.providers[0]
    assert.equal(after.accounts.find((a) => a.id === active.id).enabled, false)
    assert.ok(after.activeAccountId !== active.id)
  })

  it('removes an account and its stored credential ref', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    const before = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
    const account = (await env.call('state')).body.providers[0].accounts[0]
    const credentialRef = before.providers[PROVIDER].accounts.find((a) => a.id === account.id).credentialRef
    assert.ok(credentialRef)
    const removed = await env.call('remove', { providerId: PROVIDER, accountId: account.id })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.provider.accounts.length, 0)
    const hit = await env.app.credentials.resolve(credentialRef)
    assert.equal(hit, undefined)
    const stateText = await readFile(join(home, 'multi-account', 'state.json'), 'utf8')
    assert.ok(!stateText.includes(account.id))
    assert.ok(!stateText.includes('sk-aaa'))
  })

  it('rotates accounts round robin on every llm/stream request', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
    await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })

    const seen = []
    for (let i = 0; i < 4; i += 1) {
      const out = await env.stream()
      assert.equal(out.result, 'stream-result')
      seen.push(await env.refValue())
    }
    assert.deepEqual(seen, ['sk-bbb', 'sk-aaa', 'sk-bbb', 'sk-aaa'])
  })

  it('keeps the active key committed in manual mode across llm/stream', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
    const accountB = (await env.call('state')).body.providers[0].accounts.find((a) => a.label === 'B')
    await env.call('switch', { providerId: PROVIDER, accountId: accountB.id })
    await env.stream()
    await env.stream()
    assert.equal(await env.refValue(), 'sk-bbb')
  })

  it('auto-switches on QUOTA failures in on-error mode and answers retry', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
    await env.call('add', { providerId: PROVIDER, label: 'C', apiKey: 'sk-ccc' })
    await env.call('mode', { providerId: PROVIDER, mode: 'on-error' })

    const first = await env.requestError('QUOTA')
    assert.deepEqual(first.result, { kind: 'retry' })
    assert.equal(await env.refValue(), 'sk-bbb')
    const state = (await env.call('state')).body.providers[0]
    assert.equal(state.accounts.find((a) => a.label === 'A').status.state, 'exhausted')
    assert.equal(state.accounts.find((a) => a.label === 'B').active, true)

    const auth = await env.requestError('AUTH')
    assert.deepEqual(auth.result, { kind: 'retry' })
    assert.equal(await env.refValue(), 'sk-ccc')

    const limited = await env.requestError('RATE_LIMIT')
    assert.deepEqual(limited.result, { kind: 'retry' })
    const afterLimit = (await env.call('state')).body.providers[0]
    assert.equal(afterLimit.accounts.find((a) => a.label === 'C').status.state, 'rate-limited')
    // Rate-limited accounts stay enabled and remain rotation candidates.
    assert.equal(afterLimit.accounts.find((a) => a.label === 'C').enabled, true)
  })

  it('never auto-switches in manual mode but records the failure status', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
    const out = await env.requestError('QUOTA')
    assert.equal(out.result, 'inner-decision')
    assert.equal(out.innerCalled, 1)
    assert.equal(await env.refValue(), 'sk-aaa')
    const state = (await env.call('state')).body.providers[0]
    assert.equal(state.accounts.find((a) => a.label === 'A').status.state, 'exhausted')
  })

  it('ignores failures unrelated to account health', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('mode', { providerId: PROVIDER, mode: 'on-error' })
    const out = await env.requestError('CONTEXT_WINDOW_EXCEEDED')
    assert.equal(out.result, 'inner-decision')
    assert.equal(await env.refValue(), 'sk-aaa')
  })

  it('falls back to the inner decision when every account is exhausted', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('mode', { providerId: PROVIDER, mode: 'on-error' })
    // One account: after marking it, no alternative exists.
    const out = await env.requestError('QUOTA')
    assert.equal(out.result, 'inner-decision')
  })

  it('does not touch traffic for providers it does not manage', async () => {
    const env = await harness()
    home = env.home
    const out = await env.stream('openrouter')
    assert.equal(out.result, 'stream-result')
    assert.equal(await env.app.credentials.resolve('OPENROUTER_API_KEY') ?? null, null)
  })

  it('clears recorded status flags', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
    await env.call('mode', { providerId: PROVIDER, mode: 'on-error' })
    await env.requestError('QUOTA')
    const cleared = await env.call('clear-status', { providerId: PROVIDER })
    assert.equal(cleared.body.provider.accounts[0].status.state, 'ok')
  })

  it('distributes parallel round-robin requests across every enabled key', async () => {
    const env = await harness()
    home = env.home
    for (const key of ['sk-aaa', 'sk-bbb', 'sk-ccc']) {
      await env.call('add', { providerId: PROVIDER, apiKey: key })
    }
    await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })
    // Nine concurrent requests: serialized state updates must advance the
    // cursor exactly nine times without losing a rotation.
    await Promise.all(Array.from({ length: 9 }, () => env.stream()))
    const persisted = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
    assert.equal(persisted.providers[PROVIDER].rrCursor, 0) // 9 mod 3
    // Sequential traffic still reaches every key afterwards.
    const seen = new Set()
    for (let i = 0; i < 6; i += 1) {
      await env.stream()
      seen.add(await env.refValue())
    }
    assert.deepEqual([...seen].sort(), ['sk-aaa', 'sk-bbb', 'sk-ccc'])
  })

  it('survives a restart: a fresh StateStore reads the persisted document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ma-store-'))
    try {
      const first = new StateStore(directory)
      await first.ensureProvider(PROVIDER, REF)
      await first.update((draft) => {
        draft.providers[PROVIDER].mode = 'round-robin'
        draft.providers[PROVIDER].accounts.push({
          id: 'acct_x', label: 'Persisted', credentialRef: 'DSH_MA_DEEPSEEK_X',
          enabled: true, createdAt: 1,
          status: { state: 'ok', code: null, message: null, at: null },
        })
      })
      const second = new StateStore(directory)
      const restored = await second.provider(PROVIDER)
      assert.equal(restored.mode, 'round-robin')
      assert.equal(restored.accounts[0].credentialRef, 'DSH_MA_DEEPSEEK_X')
      assert.equal(restored.accounts[0].label, 'Persisted')
      // Documents written before lastTest existed load with a null result.
      assert.equal(restored.accounts[0].lastTest, null)

      await first.update((draft) => {
        draft.providers[PROVIDER].accounts[0].lastTest = {
          state: 'ok', code: null, message: null, at: 42, latencyMs: 7, model: 'm-1',
        }
      })
      const third = new StateStore(directory)
      assert.deepEqual((await third.provider(PROVIDER)).accounts[0].lastTest, {
        state: 'ok', code: null, message: null, at: 42, latencyMs: 7, model: 'm-1',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('adopts a new route ref when the provider configuration changes', async () => {
    const env = await harness()
    home = env.home
    await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
    const store = new StateStore(join(home, 'multi-account'))
    await store.ensureProvider(PROVIDER, 'DEEPSEEK_API_KEY_V2')
    const section = await store.provider(PROVIDER)
    assert.equal(section.ref, 'DEEPSEEK_API_KEY_V2')
    assert.equal(section.accounts.length, 1)
  })

  it('never blocks model traffic when the plugin state is unreadable', async () => {
    const env = await harness()
    home = env.home
    // No accounts configured: the stream listener must stay transparent.
    const out = await env.stream()
    assert.equal(out.innerCalled, 1)
    assert.equal(out.result, 'stream-result')
  })

  it('degrades gracefully without the optional configEditor service', async () => {
    const env = await harness({ noConfigEditor: true })
    home = env.home
    const { status, body } = await env.call('state')
    assert.equal(status, 200)
    const deepseek = body.providers.find((p) => p.providerId === PROVIDER)
    // Refs are undiscoverable, but the directory and routes still work.
    assert.equal(deepseek.ref, null)
    assert.equal(deepseek.managed, false)
    // An explicit ref can still seed an account.
    const added = await env.call('add', { providerId: PROVIDER, ref: REF, apiKey: 'sk-explicit' })
    assert.equal(added.status, 200)
    assert.equal(added.body.provider.accounts.length, 1)
    assert.equal(await env.refValue(), 'sk-explicit')
  })

  describe('account tests', () => {
    it('runs a minimal marked probe for one account and records the result', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      const account = (await env.call('state')).body.providers[0].accounts[0]

      const { status, body } = await env.call('test-account', { providerId: PROVIDER, accountId: account.id })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'ok')
      assert.equal(body.result.code, null)
      assert.equal(body.result.model, 'test-model')
      assert.equal(typeof body.result.latencyMs, 'number')
      assert.ok(body.result.latencyMs >= 0)

      // The probe went through the llm service as a cheap one-token request
      // and carried the internal marker so our own listener skipped rotation.
      const probe = env.streamCalls.find((call) => call[TEST_MARKER] === true)
      assert.ok(probe)
      assert.equal(probe.provider, PROVIDER)
      assert.equal(probe.model, 'test-model')
      assert.equal(probe.maxTokens, 1)
      assert.equal(probe.__committedKey, 'sk-aaa')

      // Result is persisted and exposed through the normal state view.
      const refreshed = (await env.call('state')).body.providers[0].accounts[0]
      assert.equal(refreshed.lastTest.state, 'ok')
      assert.equal(refreshed.lastTest.model, 'test-model')
      // The temporary swap is fully transparent afterwards.
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('classifies a rejected key as invalid and restores the previous ref', async () => {
      const env = await harness({ failKeys: new Map([[PROVIDER, new Set(['sk-bbb'])]]) })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      const accountB = (await env.call('state')).body.providers[0].accounts.find((a) => a.label === 'B')

      const { status, body } = await env.call('test-account', { providerId: PROVIDER, accountId: accountB.id })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'invalid')
      assert.equal(body.result.code, 'AUTH')
      assert.match(body.result.message, /rejected/)
      // Active account, its key and the modal view stay untouched.
      assert.equal(await env.refValue(), 'sk-aaa')
      assert.equal(body.provider.activeAccountId, (await env.call('state')).body.providers[0].activeAccountId)
      assert.equal(body.provider.accounts.find((a) => a.id === accountB.id).lastTest.state, 'invalid')
    })

    it('tests every account of one provider as a background job', async () => {
      const env = await harness({ failKeys: new Map([[PROVIDER, new Set(['sk-bbb'])]]) })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })

      const job = await env.runJob('provider-accounts', { providerId: PROVIDER })
      assert.equal(job.status, 'done')
      assert.equal(job.total, 2)
      assert.equal(job.done, 2)
      assert.equal(job.ok, 1)
      assert.equal(job.failed, 1)
      const state = (await env.call('state')).body.providers[0]
      const byLabel = Object.fromEntries(state.accounts.map((account) => [account.label, account.lastTest.state]))
      assert.deepEqual(byLabel, { A: 'ok', B: 'invalid' })
      // Each probe observed its own account's key on the route ref.
      const probes = env.streamCalls.filter((call) => call[TEST_MARKER] === true)
      assert.deepEqual(probes.map((call) => call.__committedKey), ['sk-aaa', 'sk-bbb'])
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('tests all accounts of all providers and restores every route ref', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-bbb' })
      await env.call('add', { providerId: 'openrouter', ref: OPENROUTER_REF, apiKey: 'sk-or-1' })

      const job = await env.runJob('all-accounts')
      assert.equal(job.status, 'done')
      assert.equal(job.results.length, 3)
      assert.deepEqual([...new Set(job.results.map((r) => r.providerId))].sort(), ['deepseek', 'openrouter'])
      assert.ok(job.results.every((r) => r.state === 'ok'))
      const openrouter = (await env.call('state')).body.providers.find((p) => p.providerId === 'openrouter')
      assert.equal(openrouter.accounts[0].lastTest.state, 'ok')
      assert.equal(await env.refValue(), 'sk-aaa')
      assert.equal(await env.app.credentials.resolve(OPENROUTER_REF).then((h) => h?.value), 'sk-or-1')
    })

    it('never rotates the active account while testing, even in round-robin mode', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })
      const before = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8')).providers[PROVIDER]
      const accountB = (await env.call('state')).body.providers[0].accounts.find((a) => a.label === 'B')

      await env.call('test-account', { providerId: PROVIDER, accountId: accountB.id })

      const after = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8')).providers[PROVIDER]
      assert.equal(after.activeAccountId, before.activeAccountId)
      assert.equal(after.rrCursor, before.rrCursor)
      assert.ok(env.streamCalls.some((call) => call[TEST_MARKER] === true && call.__committedKey === 'sk-bbb'))
    })

    it('reports TIMEOUT when the probe exceeds its budget', async () => {
      const env = await harness({ hang: true, testTimeoutMs: 40 })
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const account = (await env.call('state')).body.providers[0].accounts[0]
      const { status, body } = await env.call('test-account', { providerId: PROVIDER, accountId: account.id })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'error')
      assert.equal(body.result.code, 'TIMEOUT')
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('reports NO_MODEL when neither catalog nor profile offers a model', async () => {
      const env = await harness({ noModels: true })
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const account = (await env.call('state')).body.providers[0].accounts[0]
      const { status, body } = await env.call('test-account', { providerId: PROVIDER, accountId: account.id })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'error')
      assert.equal(body.result.code, 'NO_MODEL')
      assert.equal(env.streamCalls.filter((call) => call[TEST_MARKER] === true).length, 0)
    })

    it('serializes concurrent tests on one provider so each sees its own key', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      const [a, b] = (await env.call('state')).body.providers[0].accounts

      const [first, second] = await Promise.all([
        env.call('test-account', { providerId: PROVIDER, accountId: a.id }),
        env.call('test-account', { providerId: PROVIDER, accountId: b.id }),
      ])
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      const keys = env.streamCalls
        .filter((call) => call[TEST_MARKER] === true)
        .map((call) => call.__committedKey)
        .sort()
      assert.deepEqual(keys, ['sk-aaa', 'sk-bbb'])
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('flags an account whose stored key disappeared without calling the provider', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const persisted = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      const credentialRef = persisted.providers[PROVIDER].accounts[0].credentialRef
      const accountId = persisted.providers[PROVIDER].accounts[0].id
      await env.app.credentials.unset(credentialRef)

      const { status, body } = await env.call('test-account', { providerId: PROVIDER, accountId })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'invalid')
      assert.equal(body.result.code, 'MISSING_CREDENTIAL')
      assert.equal(env.streamCalls.filter((call) => call[TEST_MARKER] === true).length, 0)
    })

    it('returns 404 for unknown accounts or unmanaged providers', async () => {
      const env = await harness()
      home = env.home
      const missingAccount = await env.call('test-account', { providerId: PROVIDER, accountId: 'acct_nope' })
      assert.equal(missingAccount.status, 404)
      assert.equal(missingAccount.body.code, 'NOT_FOUND')
      const missingProvider = await env.call('test-start', { scope: 'provider-accounts', providerId: 'ghost' })
      assert.equal(missingProvider.status, 404)
    })
  })

  describe('model tests', () => {
    it('lists catalog models through the models route with no prior result', async () => {
      const env = await harness()
      home = env.home
      const { status, body } = await env.call('models', { providerId: PROVIDER })
      assert.equal(status, 200)
      assert.equal(body.providerId, PROVIDER)
      assert.deepEqual(body.models, [{ id: 'test-model', name: 'Test Model', lastTest: null }])
    })

    it('falls back to profile models when the adapter catalog is unavailable', async () => {
      const env = await harness({
        noModels: true,
        providers: {
          [PROVIDER]: { apiKeyEnv: REF, displayName: 'DeepSeek', models: [{ id: 'profile-a' }, { id: 'profile-b' }] },
        },
      })
      home = env.home
      const { body } = await env.call('models', { providerId: PROVIDER })
      assert.deepEqual(body.models.map((m) => m.id), ['profile-a', 'profile-b'])
    })

    it('probes one model with the active account key and persists the result under modelTests', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const { status, body } = await env.call('test-model', { providerId: PROVIDER, model: 'test-model' })
      assert.equal(status, 200)
      assert.equal(body.model, 'test-model')
      assert.equal(body.result.state, 'ok')
      assert.equal(body.result.model, 'test-model')

      const probe = env.streamCalls.find((call) => call[MODEL_TEST_MARKER] === true)
      assert.ok(probe)
      assert.equal(probe.model, 'test-model')
      assert.equal(probe.maxTokens, 1)
      assert.equal(probe.__committedKey, 'sk-aaa')
      assert.equal(probe[TEST_MARKER], undefined)

      const refreshed = await env.call('models', { providerId: PROVIDER })
      assert.equal(refreshed.body.models[0].lastTest.state, 'ok')
      // Results live in the separate modelTests map, never inside a provider section.
      const stateText = await readFile(join(home, 'multi-account', 'state.json'), 'utf8')
      const persisted = JSON.parse(stateText)
      assert.ok(persisted.modelTests[PROVIDER]['test-model'])
      assert.ok(!stateText.includes('sk-aaa'))
      // The key stays committed — model tests do not swap-and-restore.
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('classifies a rejected key during a model probe as invalid', async () => {
      const env = await harness({ failKeys: new Map([[PROVIDER, new Set(['sk-bbb'])]]) })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      const accountB = (await env.call('state')).body.providers[0].accounts.find((a) => a.label === 'B')
      await env.call('switch', { providerId: PROVIDER, accountId: accountB.id })

      const { status, body } = await env.call('test-model', { providerId: PROVIDER, model: 'test-model' })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'invalid')
      assert.equal(body.result.code, 'AUTH')
    })

    it('tests every model of one provider in one batch', async () => {
      const env = await harness({
        catalogModels: new Map([[PROVIDER, [
          { provider: PROVIDER, id: 'm-1', name: 'Model One' },
          { provider: PROVIDER, id: 'm-2', name: 'Model Two' },
        ]]]),
      })
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const job = await env.runJob('provider-models', { providerId: PROVIDER })
      assert.equal(job.status, 'done')
      assert.deepEqual(job.results.map((r) => r.model), ['m-1', 'm-2'])
      assert.ok(job.results.every((r) => r.state === 'ok'))
      const listed = await env.call('models', { providerId: PROVIDER })
      assert.deepEqual(listed.body.models.map((m) => m.id), ['m-1', 'm-2'])
      assert.ok(listed.body.models.every((m) => m.lastTest?.state === 'ok'))
      const probes = env.streamCalls.filter((call) => call[MODEL_TEST_MARKER] === true)
      assert.deepEqual(probes.map((call) => call.model), ['m-1', 'm-2'])
    })

    it('tests every model of every configurable provider', async () => {
      const env = await harness()
      home = env.home
      await env.app.credentials.set(REF, 'sk-deep')
      await env.app.credentials.set(OPENROUTER_REF, 'sk-or')
      const job = await env.runJob('all-models')
      assert.equal(job.status, 'done')
      assert.equal(job.results.length, 2)
      assert.deepEqual([...new Set(job.results.map((r) => r.providerId))].sort(), ['deepseek', 'openrouter'])
      assert.ok(job.results.every((r) => r.state === 'ok' && r.model === 'test-model'))
    })

    it('never rotates the active account while testing models, even in round-robin mode', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })
      const before = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8')).providers[PROVIDER]

      await env.call('test-model', { providerId: PROVIDER, model: 'test-model' })

      const after = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8')).providers[PROVIDER]
      assert.equal(after.activeAccountId, before.activeAccountId)
      assert.equal(after.rrCursor, before.rrCursor)
    })

    it('works for providers without managed accounts using the key saved in Settings', async () => {
      const env = await harness()
      home = env.home
      await env.app.credentials.set(REF, 'sk-manual')
      const { status, body } = await env.call('test-model', { providerId: PROVIDER, model: 'test-model' })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'ok')
      const persisted = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      // No managed provider section is created just because a model was tested.
      assert.deepEqual(persisted.providers, {})
      assert.ok(persisted.modelTests[PROVIDER]['test-model'])
    })

    it('reports MISSING_CREDENTIAL without a probe when the active account key is gone', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const persisted = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      const credentialRef = persisted.providers[PROVIDER].accounts[0].credentialRef
      await env.app.credentials.unset(credentialRef)

      const { status, body } = await env.call('test-model', { providerId: PROVIDER, model: 'test-model' })
      assert.equal(status, 200)
      assert.equal(body.result.state, 'invalid')
      assert.equal(body.result.code, 'MISSING_CREDENTIAL')
      assert.equal(env.streamCalls.filter((call) => call[MODEL_TEST_MARKER] === true).length, 0)
    })

    it('validates input and reports NO_MODEL when nothing is discoverable', async () => {
      const env = await harness({ noModels: true })
      home = env.home
      const badModel = await env.call('test-model', { providerId: PROVIDER, model: '' })
      assert.equal(badModel.status, 400)
      assert.equal(badModel.body.code, 'BAD_REQUEST')
      const badProvider = await env.call('test-model', { providerId: '', model: 'x' })
      assert.equal(badProvider.status, 400)
      const nothing = await env.call('test-start', { scope: 'provider-models', providerId: PROVIDER })
      assert.equal(nothing.status, 409)
      assert.equal(nothing.body.code, 'NO_MODEL')
      const badScope = await env.call('test-start', { scope: 'bogus', providerId: PROVIDER })
      assert.equal(badScope.status, 400)
    })

    it('serializes concurrent model probes through the shared provider lock', async () => {
      const env = await harness({
        catalogModels: new Map([[PROVIDER, [
          { provider: PROVIDER, id: 'm-1', name: 'One' },
          { provider: PROVIDER, id: 'm-2', name: 'Two' },
        ]]]),
      })
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const [first, second] = await Promise.all([
        env.call('test-model', { providerId: PROVIDER, model: 'm-1' }),
        env.call('test-model', { providerId: PROVIDER, model: 'm-2' }),
      ])
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      const probes = env.streamCalls.filter((call) => call[MODEL_TEST_MARKER] === true)
      assert.deepEqual(probes.map((call) => call.model).sort(), ['m-1', 'm-2'])
      assert.ok(probes.every((call) => call.__committedKey === 'sk-aaa'))
    })

    it('survives a restart with model test results intact and tolerates legacy documents', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'dsh-ma-store-'))
      try {
        const first = new StateStore(directory)
        await first.update((draft) => {
          draft.modelTests[PROVIDER] = {
            'm-1': { state: 'ok', code: null, message: null, at: 9, latencyMs: 3, model: 'm-1' },
          }
        })
        const second = new StateStore(directory)
        const snapshot = await second.snapshot()
        assert.deepEqual(snapshot.modelTests[PROVIDER]['m-1'], {
          state: 'ok', code: null, message: null, at: 9, latencyMs: 3, model: 'm-1',
        })
        // A document predating modelTests loads with an empty map.
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 1, providers: {} }))
        const third = new StateStore(directory)
        assert.deepEqual((await third.snapshot()).modelTests, {})
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })

  describe('background batch jobs', () => {
    /** Wait until the mock llm has received `count` probe calls. */
    async function waitForProbes(env, count) {
      for (let i = 0; i < 100; i += 1) {
        if (env.streamCalls.length >= count) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`timed out waiting for ${count} probes, saw ${env.streamCalls.length}`)
    }

    it('reports progress while running and aborts on demand', async () => {
      const env = await harness({ hang: true, testTimeoutMs: 5000 })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })

      const started = await env.call('test-start', { scope: 'provider-accounts', providerId: PROVIDER })
      assert.equal(started.status, 200)
      assert.equal(started.body.status, 'running')
      assert.equal(started.body.total, 2)
      await waitForProbes(env, 1)

      // Re-attachment seam for a reopened modal.
      const active = await env.call('test-active')
      assert.equal(active.body.jobs.length, 1)
      assert.equal(active.body.jobs[0].id, started.body.id)

      const aborted = await env.call('test-abort', { jobId: started.body.id })
      assert.equal(aborted.status, 200)
      const final = await env.runJobLoopUntilTerminal(started.body.id)
      assert.equal(final.status, 'aborted')
      assert.equal(final.done, 1)
      assert.equal(final.failed, 1)
      assert.equal(final.results[0].code, 'ABORTED')
      // The second probe never started.
      assert.equal(env.streamCalls.filter((call) => call[TEST_MARKER]).length, 1)
      // The first key was restored despite the abort.
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('rejects a second concurrent job with 409', async () => {
      const env = await harness({ hang: true, testTimeoutMs: 5000 })
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const first = await env.call('test-start', { scope: 'provider-accounts', providerId: PROVIDER })
      assert.equal(first.status, 200)
      await waitForProbes(env, 1)
      const second = await env.call('test-start', { scope: 'all-accounts' })
      assert.equal(second.status, 409)
      assert.equal(second.body.code, 'JOB_RUNNING')
      await env.call('test-abort', { jobId: first.body.id })
      await env.runJobLoopUntilTerminal(first.body.id)
    })

    it('returns 404 for unknown jobs on progress and abort routes', async () => {
      const env = await harness()
      home = env.home
      const progress = await env.call('test-progress', { jobId: 'job_nope' })
      assert.equal(progress.status, 404)
      const abort = await env.call('test-abort', { jobId: 'job_nope' })
      assert.equal(abort.status, 404)
    })

    it('keeps only a bounded number of finished jobs', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const ids = []
      for (let i = 0; i < 8; i += 1) {
        const job = await env.runJob('provider-accounts', { providerId: PROVIDER })
        ids.push(job.id)
      }
      // The cap is 5; the oldest job id must have been evicted.
      const oldest = await env.call('test-progress', { jobId: ids[0] })
      assert.equal(oldest.status, 404)
      const newest = await env.call('test-progress', { jobId: ids[7] })
      assert.equal(newest.status, 200)
      assert.equal(newest.body.status, 'done')
    })
  })

  describe('health-aware round robin', () => {
    it('parks flagged accounts during the cooldown and only rotates healthy ones', async () => {
      const env = await harness({ cooldownMs: 10 * 60 * 1000 })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      await env.call('add', { providerId: PROVIDER, label: 'C', apiKey: 'sk-ccc' })
      await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })

      // Mark A exhausted; on-error handling rotates the active account to B.
      const failure = await env.requestError('QUOTA')
      assert.deepEqual(failure.result, { kind: 'retry' })
      const flagged = (await env.call('state')).body.providers[0].accounts.find((a) => a.label === 'A')
      assert.equal(flagged.status.state, 'exhausted')

      // From B, healthy rotation goes to C and then back to B — A never wins.
      await env.stream()
      assert.equal(await env.refValue(), 'sk-ccc')
      await env.stream()
      assert.equal(await env.refValue(), 'sk-bbb')
      await env.stream()
      assert.equal(await env.refValue(), 'sk-ccc')
    })

    it('re-admits a parked account once the cooldown has elapsed', async () => {
      const env = await harness({ cooldownMs: 30 })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })
      await env.requestError('QUOTA')
      assert.equal(await env.refValue(), 'sk-bbb')

      await new Promise((resolve) => setTimeout(resolve, 60))
      // A is eligible again: from B the next rotation slot reaches A.
      await env.stream()
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('falls back to flagged accounts when every enabled account is unhealthy', async () => {
      const env = await harness({ cooldownMs: 60000 })
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('add', { providerId: PROVIDER, label: 'B', apiKey: 'sk-bbb' })
      await env.call('mode', { providerId: PROVIDER, mode: 'round-robin' })
      await env.requestError('QUOTA')
      await env.requestError('QUOTA')
      const states = (await env.call('state')).body.providers[0].accounts.map((a) => a.status.state)
      assert.ok(states.every((state) => state === 'exhausted'))
      // No healthy account exists, yet traffic must still pick someone.
      const out = await env.stream()
      assert.equal(out.result, 'stream-result')
      assert.ok(['sk-aaa', 'sk-bbb'].includes(await env.refValue()))
    })
  })

  describe('state housekeeping', () => {
    it('deletes the provider section when its last account is removed', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      const account = (await env.call('state')).body.providers[0].accounts[0]
      const removed = await env.call('remove', { providerId: PROVIDER, accountId: account.id })
      assert.equal(removed.status, 200)
      assert.equal(removed.body.provider.managed, false)
      const persisted = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      assert.deepEqual(persisted.providers, {})
      // The route ref itself keeps the key (pre-managed state).
      assert.equal(await env.refValue(), 'sk-aaa')
    })

    it('prunes model test results for models the provider no longer exposes', async () => {
      const catalog = new Map([[PROVIDER, [
        { provider: PROVIDER, id: 'm-1', name: 'One' },
        { provider: PROVIDER, id: 'm-2', name: 'Two' },
      ]]])
      const env = await harness({ catalogModels: catalog })
      home = env.home
      await env.call('add', { providerId: PROVIDER, apiKey: 'sk-aaa' })
      await env.runJob('provider-models', { providerId: PROVIDER })

      catalog.set(PROVIDER, [{ provider: PROVIDER, id: 'm-1', name: 'One' }])
      const listed = await env.call('models', { providerId: PROVIDER })
      assert.deepEqual(listed.body.models.map((m) => m.id), ['m-1'])
      const persisted = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      assert.deepEqual(Object.keys(persisted.modelTests[PROVIDER]), ['m-1'])
    })

    it('forget-provider removes the section, model tests and stored account refs', async () => {
      const env = await harness()
      home = env.home
      await env.call('add', { providerId: PROVIDER, label: 'A', apiKey: 'sk-aaa' })
      await env.call('test-model', { providerId: PROVIDER, model: 'test-model' })
      const before = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      const credentialRef = before.providers[PROVIDER].accounts[0].credentialRef
      assert.ok(await env.app.credentials.resolve(credentialRef))

      const forgotten = await env.call('forget-provider', { providerId: PROVIDER })
      assert.equal(forgotten.status, 200)
      assert.equal(forgotten.body.providers.find((p) => p.providerId === PROVIDER).managed, false)
      const after = JSON.parse(await readFile(join(home, 'multi-account', 'state.json'), 'utf8'))
      assert.deepEqual(after.providers, {})
      assert.equal(after.modelTests[PROVIDER], undefined)
      assert.equal(await env.app.credentials.resolve(credentialRef), undefined)

      const again = await env.call('forget-provider', { providerId: 'ghost' })
      assert.equal(again.status, 404)
    })
  })

  describe('unload handling', () => {
    it('dispose aborts a running job and every in-flight probe', async () => {
      const home2 = await mkdtemp(join(tmpdir(), 'dsh-ma-dispose-'))
      const startedProbes = []
      try {
        const ctx = {
          logger: { info() {}, warn() {}, error() {} },
          get: () => undefined,
          on: () => () => undefined,
          credentials: await (async () => {
            const app = new Context()
            await app.plugin(LocalCredentialProvider, {
              path: join(home2, '.credentials.yaml'),
              dshHome: home2,
              watch: false,
            })
            return app.credentials
          })(),
          llm: {
            listConfigurableProviders: async () => [{ provider: PROVIDER, displayName: 'DeepSeek', settingsNs: 'llm-pi-ai' }],
            listModels: async () => [{ provider: PROVIDER, id: 'test-model', name: 'Test Model' }],
            async *stream(options) {
              startedProbes.push(options)
              await new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true })
              })
              yield { type: 'text', text: 'OK' }
            },
          },
        }
        const store = new StateStore(join(home2, 'multi-account'))
        const directory = new plugin.ProviderDirectory(ctx)
        const manager = new plugin.AccountManager(ctx, store, directory, { testTimeoutMs: 60000 })
        const job = await manager.startJob({ scope: 'all-models' })
        for (let i = 0; i < 100 && startedProbes.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        assert.equal(startedProbes.length, 1)
        manager.dispose()
        for (let i = 0; i < 100; i += 1) {
          const view = manager.jobProgress({ jobId: job.id })
          if (view.status !== 'running') {
            assert.equal(view.status, 'aborted')
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        assert.fail('job did not abort after dispose')
      } finally {
        await rm(home2, { recursive: true, force: true })
      }
    })
  })
})
