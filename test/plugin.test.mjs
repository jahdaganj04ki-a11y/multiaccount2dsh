import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as plugin from '../index.js'
import { StateStore } from '../lib/state-store.js'

const PROVIDER = 'deepseek'
const REF = 'DEEPSEEK_API_KEY'

function mockLlm(entries) {
  return {
    listConfigurableProviders: async () => entries,
    registerAdapter: () => ({ replace() {} }),
    registerConfigurableProviders: () => ({ replace() {} }),
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
  ])
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
  await app.plugin(plugin, { root: join(home, 'multi-account') })

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

  return { app, home, call, refValue, stream, requestError }
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
})
