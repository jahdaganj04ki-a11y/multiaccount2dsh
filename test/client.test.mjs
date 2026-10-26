import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Minimal React stub: the factory only calls createElement at render time. */
function stubReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
  }
}

function stubPrimitives() {
  const make = (name) => function Stub() { return { name } }
  return {
    Modal: make('Modal'), Button: make('Button'), Input: make('Input'), Switch: make('Switch'),
    SegmentedControl: make('SegmentedControl'), Tag: make('Tag'), Tooltip: make('Tooltip'),
    IconUsersOutlineRegular: make('IconUsers'), IconPlusOutlineRegular: make('IconPlus'),
    IconRefreshOutlineRegular: make('IconRefresh'),
    IconPlayOutlineRegular: make('IconPlay'), IconChecklistOutlineRegular: make('IconChecklist'),
    IconCheckCircleOutlineRegular: make('IconCheckCircle'), IconWarningOutlineRegular: make('IconWarning'),
    IconStopFillRegular: make('IconStop'), IconTrashOutlineRegular: make('IconTrash'),
  }
}

async function loadClient() {
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => loaded.push(spec),
    },
  }
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // Evaluate the browser single-file module in the current realm.
  const fn = new Function(source)
  fn.call(globalThis)
  delete globalThis.window
  assert.equal(loaded.length, 1)
  return loaded[0]
}

describe('dsh-multi-account client module', () => {
  let spec

  beforeEach(async () => {
    spec = await loadClient()
  })

  it('registers through the module loader with the expected id', () => {
    assert.equal(spec.id, 'dsh-multi-account')
    assert.equal(typeof spec.factory, 'function')
  })

  it('declares the slots and locale service dependencies', () => {
    const mod = spec.factory((name) => {
      if (name === 'react') return stubReact()
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
      throw new Error(`unexpected require ${name}`)
    })
    assert.deepEqual(mod.inject, ['slots', 'locale'])
    assert.equal(typeof mod.apply, 'function')
  })

  it('registers a keyed provider-card slot contribution for llm-pi-ai and adopts extra namespaces', async () => {
    const mod = spec.factory((name) => {
      if (name === 'react') return stubReact()
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
      throw new Error(`unexpected require ${name}`)
    })

    const registrations = []
    const injections = []
    const dictionaries = []
    const ctx = {
      effect: (fn) => {
        if (typeof fn === 'function') fn()
        return () => undefined
      },
      locale: {
        register: (ns, dict) => dictionaries.push([ns, dict]),
        bind: (ns) => (key) => `${ns}.${key}`,
      },
      slots: {
        inject: (slotName, callback) => {
          injections.push(slotName)
          callback()
        },
        register: (options, component) => {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }

    // Global fetch is used for the initial state refresh.
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      providers: [{ providerId: 'custom-gw', settingsNs: 'llm-pi-ai' }, { providerId: 'x', settingsNs: 'other-ns' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    try {
      mod.apply(ctx)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.ok(injections.includes('settings.models.provider-card'))
    const keys = registrations.map((entry) => entry.options.key)
    assert.ok(keys.includes('llm-pi-ai'))
    assert.ok(keys.includes('other-ns'))
    for (const entry of registrations) {
      assert.equal(entry.options.name, 'settings.models.provider-card')
      assert.equal(entry.options.locale, 'dsh.multiAccount')
      assert.equal(typeof entry.component, 'function')
    }
    // Locale dictionaries maintain zh/en key parity.
    const [, dict] = dictionaries.find(([ns]) => ns === 'dsh.multiAccount')
    assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
    assert.ok(Object.keys(dict.en).length > 30)
  })

  it('does not touch document when it is unavailable', () => {
    const mod = spec.factory((name) => {
      if (name === 'react') return stubReact()
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
      throw new Error(`unexpected require ${name}`)
    })
    const ctx = {
      effect: () => undefined,
      locale: { register: () => undefined, bind: () => () => '' },
      slots: { inject: () => undefined, register: () => () => undefined },
    }
    assert.doesNotThrow(() => mod.apply(ctx))
  })
})
