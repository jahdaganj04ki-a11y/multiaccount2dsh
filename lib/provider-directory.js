/**
 * Discovery of the provider routes the Models settings page lists, together
 * with the credential ref (`apiKeyEnv`) each route resolves its key through.
 *
 * The public `ctx.llm.listConfigurableProviders()` directory supplies stable
 * route ids, display names and settings namespaces. The ref each route reads
 * is llm-pi-ai configuration; it is read through the same `configEditor`
 * service the settings forms use, then memoized briefly because reading the
 * profile directory touches disk. A `loader/volatile-update` invalidates the
 * memo immediately when configuration changes.
 *
 * @module dsh-multi-account/provider-directory
 */

const MEMO_TTL_MS = 1500

export class ProviderDirectory {
  #ctx
  #memo
  #memoAt = 0

  /** @param {import('@deepseek-ai/cordis').Context} ctx host context. */
  constructor(ctx) {
    this.#ctx = ctx
    // Configuration edits emit this event on the same fiber the loader owns;
    // dropping the memo means the next request re-reads fresh values.
    ctx.on('loader/volatile-update', () => {
      this.#memo = undefined
      this.#memoAt = 0
    })
  }

  /**
   * Read every `llm-pi-ai` settings namespace visible to the config editor as
   * `namespace -> providerId -> raw profile`. Defensive throughout: this is
   * an internal host seam, and a missing service must degrade to "no refs
   * discoverable" rather than failing model requests.
   *
   * @returns {Map<string, Record<string, { apiKeyEnv?: unknown }>>}
   */
  #readProfiles() {
    const result = new Map()
    const editor = this.#ctx.get?.('configEditor')
    if (!editor || typeof editor.configuration !== 'function') return result
    let rows
    try {
      rows = editor.configuration()
    } catch (error) {
      this.#ctx.logger.warn('dsh-multi-account: configEditor.configuration() failed: %s', error?.message ?? error)
      return result
    }
    if (!Array.isArray(rows)) return result
    for (const row of rows) {
      const ns = row?.entry?.options?.id
      if (typeof ns !== 'string') continue
      const config = row.entry?.fiber?.config
      const providers = typeof config?.providers?.get === 'function'
        ? config.providers.get()
        : config?.providers
      if (providers && typeof providers === 'object') result.set(ns, providers)
    }
    return result
  }

  /**
   * Snapshot of every configurable provider with (when discoverable) the
   * credential ref its route reads.
   *
   * @returns {Promise<Array<{provider:string, displayName:string, settingsNs:string, ref:string|null, declared:boolean}>>}
   */
  async list() {
    const now = Date.now()
    if (this.#memo && now - this.#memoAt < MEMO_TTL_MS) return structuredClone(this.#memo)

    let entries = []
    try {
      entries = await this.#ctx.llm.listConfigurableProviders()
    } catch (error) {
      this.#ctx.logger.warn('dsh-multi-account: llm.listConfigurableProviders() failed: %s', error?.message ?? error)
      return []
    }
    const profiles = this.#readProfiles()

    const snapshot = entries.map((entry) => {
      const provider = String(entry?.provider ?? '')
      const settingsNs = String(entry?.settingsNs ?? 'llm-pi-ai')
      const rawRef = profiles.get(settingsNs)?.[provider]?.apiKeyEnv
      return {
        provider,
        displayName: String(entry?.displayName ?? provider),
        settingsNs,
        ref: typeof rawRef === 'string' && rawRef.length > 0 ? rawRef : null,
        declared: entry?.declared === true,
      }
    }).filter((entry) => entry.provider.length > 0)

    this.#memo = snapshot
    this.#memoAt = now
    return structuredClone(snapshot)
  }

  /**
   * @param {string} providerId route id.
   * @returns {Promise<object|null>}
   */
  async describe(providerId) {
    const all = await this.list()
    return all.find((entry) => entry.provider === providerId) ?? null
  }

  /**
   * Model ids configured for one route in the llm-pi-ai profile, read through
   * the same config-editor seam as the credential ref. Used as a fallback for
   * account tests when the adapter catalog (`llm.listModels`) is unavailable.
   *
   * @param {string} providerId route id.
   * @returns {Promise<string[]>} configured model ids, possibly empty.
   */
  async providerModels(providerId) {
    const profiles = this.#readProfiles()
    for (const providers of profiles.values()) {
      const profile = providers?.[providerId]
      const models = profile?.models
      if (!Array.isArray(models)) continue
      return models
        .map((model) => (typeof model?.id === 'string' ? model.id : null))
        .filter((id) => id !== null)
    }
    return []
  }

  /**
   * Distinct settings namespaces currently present (used by the client to
   * register one keyed slot contribution per namespace).
   *
   * @returns {Promise<string[]>}
   */
  async namespaces() {
    const all = await this.list()
    return [...new Set(all.map((entry) => entry.settingsNs))]
  }
}
