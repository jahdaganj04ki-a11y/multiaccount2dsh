/**
 * dsh-multi-account — server entry.
 *
 * Wires the durable store, provider discovery, the account switching engine
 * and the fetch routes into one Cordis plugin. The plugin only consumes host
 * seams (credentials, llm directory, connection routes, config editor) and
 * host events (`llm/stream`, `agent/request-error`); it patches no host code.
 *
 * @module dsh-multi-account
 */
import Schema from '@deepseek-ai/schemastery'
import { StateStore } from './lib/state-store.js'
import { ProviderDirectory } from './lib/provider-directory.js'
import { AccountManager, mountSwitcher } from './lib/account-switcher.js'
import { registerRoutes } from './lib/api-routes.js'
import { DEFAULT_COOLDOWN_MS, LIMITS, PLUGIN_NAME } from './lib/protocol.js'

export const name = PLUGIN_NAME
export const inject = ['connection', 'credentials', 'llm']
export const Config = Schema.object({
  root: Schema.string().required(),
  testTimeoutMs: Schema.natural().default(LIMITS.TEST_TIMEOUT_MS),
  cooldownMs: Schema.natural().default(DEFAULT_COOLDOWN_MS),
})

export function apply(ctx, config) {
  const store = new StateStore(config.root)
  const directory = new ProviderDirectory(ctx)
  const manager = new AccountManager(ctx, store, directory, {
    testTimeoutMs: config.testTimeoutMs,
    cooldownMs: config.cooldownMs,
  })

  // Surface a corrupt or unreadable state document without blocking Harness.
  store.ready.then(() => {
    if (store.readyError) {
      ctx.logger.warn('dsh-multi-account: state document at %s could not be read: %s', store.path, store.readyError.message)
    }
  }, () => undefined)

  const disposeRoutes = registerRoutes(ctx, manager)
  const disposeSwitcher = mountSwitcher(ctx, manager)

  ctx.logger.info('dsh-multi-account: active; state directory %s', config.root)

  ctx.effect(() => () => {
    manager.dispose()
    disposeSwitcher()
    disposeRoutes()
  }, 'dsh-multi-account: teardown')
}

export { AccountManager, ProviderDirectory, StateStore, mountSwitcher, registerRoutes }
