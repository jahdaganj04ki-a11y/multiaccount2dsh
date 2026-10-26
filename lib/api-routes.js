/**
 * Fetch routes backing the account manager window.
 *
 * Every route stays under the plugin-owned `/api/multi-account.` prefix and
 * speaks buffered JSON, matching the conventions of the host's own plugins
 * (see dsh-image-generation's connection.fetch.register usage). Secrets only
 * ever travel on the add-account request; every read returns metadata and
 * key hints instead.
 *
 * @module dsh-multi-account/api-routes
 */
import { readJsonBody, ROUTE_PREFIX, safeError } from './protocol.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./account-switcher.js').AccountManager} manager
 * @returns {() => void} disposer
 */
export function registerRoutes(ctx, manager) {
  const json = (payload, status = 200) => Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })

  const handle = (run) => async (request) => {
    try {
      return await run(request)
    } catch (error) {
      const safe = safeError(error)
      ctx.logger.warn('dsh-multi-account: route failed: code=%s message=%s', safe.code, safe.message)
      return json({ code: safe.code, error: safe.message }, safe.status)
    }
  }

  const register = (suffix, methods, fetch) => ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}${suffix}`,
    methods,
    requestBody: 'buffered',
    fetch: handle(fetch),
  })

  const disposers = []

  // Full provider/account view for the manager window.
  disposers.push(register('state', ['GET'], async () => {
    const providers = await manager.describeAll()
    return json({ providers })
  }))

  // Add an account (the only route that receives a raw secret).
  disposers.push(register('add', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.addAccount(body)
    return json({ provider })
  }))

  // Turn the key currently saved on the route ref into a managed account
  // without the value crossing the client.
  disposers.push(register('import', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.importCurrentKey(body)
    return json({ provider })
  }))

  disposers.push(register('remove', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.removeAccount(body)
    return json({ provider })
  }))

  disposers.push(register('toggle', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.toggleAccount(body)
    return json({ provider })
  }))

  // Manual activation ("switch by click").
  disposers.push(register('switch', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.switchAccount(body)
    return json({ provider })
  }))

  disposers.push(register('mode', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.setMode(body)
    return json({ provider })
  }))

  disposers.push(register('clear-status', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const provider = await manager.clearStatus(body)
    return json({ provider })
  }))

  // Probe one account's key with a minimal one-token model request.
  disposers.push(register('test-account', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const payload = await manager.runAccountTest(body)
    return json(payload)
  }))

  // Probe every account configured for one provider.
  disposers.push(register('test-provider', ['POST'], async (request) => {
    const body = await readJsonBody(request, request.signal)
    const payload = await manager.testProvider(body)
    return json(payload)
  }))

  // Probe every account of every managed provider.
  disposers.push(register('test-all', ['POST'], async () => {
    const payload = await manager.testAll()
    return json(payload)
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (error) {
        ctx.logger.warn('dsh-multi-account: route dispose failed: %s', error?.message ?? error)
      }
    }
  }
}
