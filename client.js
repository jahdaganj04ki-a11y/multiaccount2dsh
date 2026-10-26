/**
 * dsh-multi-account — client entry (single-file module, plain JS).
 *
 * Contributes an "Accounts" button to every API-key provider row on the
 * Settings → Models page through the declared `settings.models.provider-card`
 * keyed slot, and opens an account manager modal for that provider. All data
 * crosses the plugin's own /api/multi-account.* fetch routes; the raw API key
 * is only sent once, when an account is added.
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-account',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const {
      Modal, Button, Input, Switch, SegmentedControl, Tag, Tooltip,
      IconUsersOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
      IconPlayOutlineRegular, IconChecklistOutlineRegular,
      IconCheckCircleOutlineRegular, IconWarningOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh.multiAccount'
    const DEFAULT_SETTINGS_NS = 'llm-pi-ai'
    const LEGAL_API_KEY = /^[\x21-\x7E]+$/

    const zh = {
      entryLabel: '账号',
      entryHint: '多账号',
      openManager: '管理 {name} 的账号',
      title: '账号管理 — {name}',
      close: '关闭',
      loading: '正在加载账号…',
      loadError: '账号数据暂时无法加载，请重试。',
      retry: '重试',
      refLine: '凭据变量：{ref}',
      refMissing: '此服务商未配置 API Key 变量，请先在模型设置中添加服务商。',
      modeLabel: '切换方式',
      modeManual: '手动切换',
      modeManualHint: '点击“启用”立即切换到该账号。',
      modeOnError: '出错自动切换',
      modeOnErrorHint: '当前账号遇到 401/403、额度不足或限流时自动切换到下一个可用账号。',
      modeRoundRobin: '轮流使用',
      modeRoundRobinHint: '每次请求自动轮流使用下一个已启用账号。',
      modeSaving: '正在保存…',
      accountsHeading: '账号',
      empty: '还没有账号。添加第一个 API Key，或导入当前已保存的 Key。',
      columnAccount: '账号',
      columnStatus: '状态',
      columnEnabled: '启用',
      columnActions: '操作',
      active: '当前使用',
      activate: '启用此账号',
      activated: '已切换',
      enable: '启用',
      disable: '停用',
      enabled: '已启用',
      disabled: '已停用',
      statusOk: '正常',
      statusRateLimited: '限流中',
      statusExhausted: '额度用尽',
      statusInvalid: '密钥无效',
      statusError: '异常',
      statusUnknown: '未知',
      clearStatus: '清除标记',
      addHeading: '添加账号',
      labelField: '名称（可选）',
      labelPlaceholder: '例如：主账号',
      keyField: 'API Key',
      keyPlaceholder: '粘贴该账号的 API Key',
      add: '添加账号',
      adding: '正在添加…',
      importCurrent: '导入当前已保存的 Key',
      importing: '正在导入…',
      remove: '移除',
      confirmRemove: '确认移除？',
      confirmRemoveYes: '确认移除',
      cancel: '取消',
      saveBlocked: '请等待当前操作完成。',
      errRequired: '请填写 API Key。',
      errIllegal: 'Key 包含不支持的字符。',
      errLabelLong: '名称过长。',
      keyHintLabel: '密钥尾号',
      noKeyStored: '密钥缺失',
      operationOk: '操作已完成。',
      operationFailed: '操作失败：{message}',
      accountCount: '{count} 个账号',
      accountCountOne: '1 个账号',
      none: '无',
      test: '测试',
      testTooltip: '用此账号的 Key 发起一次极简请求来验证',
      testProvider: '测试本服务商全部账号',
      testAllProviders: '测试所有服务商的全部账号',
      testing: '测试中…',
      testSummaryOk: '{ok}/{total} 个账号测试通过',
      testSummaryMixed: '{ok}/{total} 个通过，{failed} 个失败',
      testNever: '尚未测试',
      testPassed: '测试通过 · {latency} ms',
      testFailed: '测试失败 · {code}',
      testAllEmpty: '暂无可测试的账号。',
    }

    const en = {
      entryLabel: 'Accounts',
      entryHint: 'Multi-account',
      openManager: 'Manage accounts for {name}',
      title: 'Account manager — {name}',
      close: 'Close',
      loading: 'Loading accounts…',
      loadError: 'Account data is temporarily unavailable. Try again.',
      retry: 'Retry',
      refLine: 'Credential variable: {ref}',
      refMissing: 'This provider has no API-key credential variable. Add it in the Models settings first.',
      modeLabel: 'Switching mode',
      modeManual: 'Manual',
      modeManualHint: 'Click “Activate” to switch to an account immediately.',
      modeOnError: 'On error',
      modeOnErrorHint: 'Automatically switch to the next enabled account on 401/403, exhausted quota or rate limiting.',
      modeRoundRobin: 'Round robin',
      modeRoundRobinHint: 'Rotate to the next enabled account on every request.',
      modeSaving: 'Saving…',
      accountsHeading: 'Accounts',
      empty: 'No accounts yet. Add an API key, or import the key currently saved for this provider.',
      columnAccount: 'Account',
      columnStatus: 'Status',
      columnEnabled: 'Enabled',
      columnActions: 'Actions',
      active: 'Active',
      activate: 'Activate',
      activated: 'Active',
      enable: 'Enable',
      disable: 'Disable',
      enabled: 'Enabled',
      disabled: 'Disabled',
      statusOk: 'OK',
      statusRateLimited: 'Rate limited',
      statusExhausted: 'Quota exhausted',
      statusInvalid: 'Invalid key',
      statusError: 'Error',
      statusUnknown: 'Unknown',
      clearStatus: 'Clear flag',
      addHeading: 'Add account',
      labelField: 'Label (optional)',
      labelPlaceholder: 'e.g. Main account',
      keyField: 'API key',
      keyPlaceholder: 'Paste this account’s API key',
      add: 'Add account',
      adding: 'Adding…',
      importCurrent: 'Import the currently saved key',
      importing: 'Importing…',
      remove: 'Remove',
      confirmRemove: 'Remove this account?',
      confirmRemoveYes: 'Confirm removal',
      cancel: 'Cancel',
      saveBlocked: 'Wait for the current operation to finish.',
      errRequired: 'Enter an API key.',
      errIllegal: 'The key contains unsupported characters.',
      errLabelLong: 'The label is too long.',
      keyHintLabel: 'Key ending',
      noKeyStored: 'Key missing',
      operationOk: 'Done.',
      operationFailed: 'Operation failed: {message}',
      accountCount: '{count} accounts',
      accountCountOne: '1 account',
      none: 'None',
      test: 'Test',
      testTooltip: 'Verify this key with a minimal one-token request',
      testProvider: 'Test all accounts of this provider',
      testAllProviders: 'Test all accounts of all providers',
      testing: 'Testing…',
      testSummaryOk: '{ok}/{total} accounts passed',
      testSummaryMixed: '{ok}/{total} passed, {failed} failed',
      testNever: 'Not tested yet',
      testPassed: 'Passed · {latency} ms',
      testFailed: 'Failed · {code}',
      testAllEmpty: 'No accounts to test.',
    }

    const css = `
.dshMaRoot{display:flex;flex-direction:column;gap:10px;width:100%}
.dshMaEntry{display:inline-flex;align-items:center;gap:8px}
.dshMaEntryButton{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:5px 11px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;max-width:100%}
.dshMaEntryButton:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshMaEntryButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dshMaEntryButton:disabled{opacity:.6;cursor:default}
.dshMaCount{font-size:11px;line-height:16px;padding:0 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshMaCount.isActive{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.dshMaModal{width:min(680px,calc(100vw - 48px));max-width:680px}
.dshMaBody{display:flex;flex-direction:column;gap:16px;max-height:min(62vh,560px);overflow-y:auto;padding-right:4px}
.dshMaRef{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;word-break:break-all}
.dshMaRefMissing{font-size:12px;color:var(--dsw-alias-state-warn-label);margin:0}
.dshMaMode{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-settings-card-fill)}
.dshMaModeTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0}
.dshMaModeHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0}
.dshMaList{display:flex;flex-direction:column;gap:8px}
.dshMaListHead{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) auto auto;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 2px}
.dshMaRow{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) auto auto;gap:8px;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 11px;background:var(--dsw-alias-settings-card-fill)}
.dshMaRow.isActive{border-color:var(--dsw-alias-brand-primary)}
.dshMaIdentity{min-width:0;display:flex;flex-direction:column;gap:2px}
.dshMaName{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshMaMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap}
.dshMaStatusCell{display:flex;align-items:center;min-width:0}
.dshMaActions{display:flex;align-items:center;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.dshMaSwitchCell{display:flex;align-items:center;justify-content:center}
.dshMaDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshMaDanger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshMaAdd{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-settings-card-fill)}
.dshMaAddTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0}
.dshMaField{display:flex;flex-direction:column;gap:5px;min-width:0}
.dshMaFieldLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshMaFieldRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:8px;align-items:end}
.dshMaError{font-size:12px;color:var(--dsw-alias-state-error-primary);margin:0}
.dshMaNotice{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0}
.dshMaEmpty{font-size:12px;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px;margin:0}
.dshMaLive{min-height:18px;font-size:12px;margin:0}
.dshMaConfirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshMaTestLine{display:inline-flex;align-items:center;gap:4px;font-size:11px}
.dshMaTestLine.isOk{color:var(--dsw-alias-state-success-label,var(--dsw-alias-label-secondary))}
.dshMaTestLine.isBad{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.dshMaTestLine.isError{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.dshMaTestLine.isIdle{color:var(--dsw-alias-label-tertiary)}
.dshMaBatchActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
@keyframes dshMaSpin{to{transform:rotate(360deg)}}
.dshMaSpin{animation:dshMaSpin 1s linear infinite}
@media (prefers-reduced-motion: reduce){.dshMaEntryButton,.dshMaRow{transition:none}.dshMaSpin{animation:none}}
@media (width<=620px){
.dshMaFieldRow{grid-template-columns:1fr}
.dshMaListHead{display:none}
.dshMaRow{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"identity actions" "status switch"}
.dshMaIdentity{grid-area:identity}.dshMaActions{grid-area:actions}.dshMaStatusCell{grid-area:status}.dshMaSwitchCell{grid-area:switch;justify-content:flex-start}
}
`

    /** POST/GET helper; throws plain {code,message} envelopes. */
    function callApiFactory(ctx) {
      return async function callApi(endpoint, payload) {
        const init = endpoint === 'state'
          ? { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
          : {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload ?? {}),
            }
        const response = await fetch(`/api/multi-account.${endpoint}`, init)
        const text = await response.text()
        let data = {}
        if (text) {
          try { data = JSON.parse(text) } catch { data = {} }
        }
        if (!response.ok) throw { code: data.code ?? 'UNAVAILABLE', message: data.error ?? response.statusText }
        return data
      }
    }

    function StatusTag({ state, t }) {
      const map = {
        ok: { tone: 'success', label: t('statusOk') },
        'rate-limited': { tone: 'warning', label: t('statusRateLimited') },
        exhausted: { tone: 'danger', label: t('statusExhausted') },
        invalid: { tone: 'danger', label: t('statusInvalid') },
        error: { tone: 'neutral', label: t('statusError') },
      }
      const found = map[state] ?? { tone: 'neutral', label: t('statusUnknown') }
      return h(Tag, { tone: found.tone }, found.label)
    }

    function AddAccountForm({ busy, t, onAdd, onImport, canImport }) {
      const [label, setLabel] = React.useState('')
      const [apiKey, setApiKey] = React.useState('')
      const [error, setError] = React.useState(null)
      const submit = async (event) => {
        event.preventDefault()
        if (busy) return
        const trimmed = apiKey.trim()
        if (!trimmed) { setError(t('errRequired')); return }
        if (!LEGAL_API_KEY.test(trimmed)) { setError(t('errIllegal')); return }
        if (label.length > 80) { setError(t('errLabelLong')); return }
        setError(null)
        await onAdd({ label: label.trim(), apiKey: trimmed })
        setLabel(''); setApiKey('')
      }
      return h('form', { className: 'dshMaAdd', onSubmit: submit },
        h('p', { className: 'dshMaAddTitle' }, t('addHeading')),
        h('div', { className: 'dshMaFieldRow' },
          h('label', { className: 'dshMaField' },
            h('span', { className: 'dshMaFieldLabel' }, t('labelField')),
            h(Input, { value: label, placeholder: t('labelPlaceholder'), maxLength: 80,
              disabled: busy, onChange: (e) => setLabel(e.target.value) })),
          h('label', { className: 'dshMaField' },
            h('span', { className: 'dshMaFieldLabel' }, t('keyField')),
            h(Input, { type: 'password', value: apiKey, placeholder: t('keyPlaceholder'),
              autoComplete: 'off', disabled: busy, onChange: (e) => setApiKey(e.target.value) })),
          h(Button, { variant: 'primary', type: 'submit', disabled: busy,
            icon: h(IconPlusOutlineRegular, { size: 14 }) }, busy ? t('adding') : t('add'))),
        h(Button, { variant: 'outline', type: 'button', disabled: busy || !canImport,
          onClick: onImport }, busy ? t('importing') : t('importCurrent')),
        error ? h('p', { className: 'dshMaError', role: 'alert' }, error) : null)
    }

    function LastTestLine({ account, t }) {
      const test = account.lastTest
      if (!test) {
        return h('span', { className: 'dshMaTestLine isIdle' }, t('testNever'))
      }
      const ok = test.state === 'ok'
      const toneClass = ok ? 'isOk' : (test.state === 'error' ? 'isError' : 'isBad')
      const label = ok
        ? t('testPassed', { latency: test.latencyMs ?? 0 })
        : t('testFailed', { code: test.code ?? t('statusUnknown') })
      return h('span', {
        className: `dshMaTestLine ${toneClass}`,
        title: test.message ? `${label} — ${test.message}` : label,
      },
        h(ok ? IconCheckCircleOutlineRegular : IconWarningOutlineRegular, { size: 12 }),
        label)
    }

    function AccountRow({ account, mode, busy, testing, t, onSwitch, onToggle, onRemove, onClearStatus, onTest }) {
      const [confirming, setConfirming] = React.useState(false)
      const isActive = account.active === true
      return h('li', { className: `dshMaRow${isActive ? ' isActive' : ''}` },
        h('div', { className: 'dshMaIdentity' },
          h('span', { className: 'dshMaName', title: account.label }, account.label),
          h('span', { className: 'dshMaMeta' },
            isActive ? h(Tag, { tone: 'solid' }, t('active')) : null,
            h('span', null, `${t('keyHintLabel')}: ${account.keyHint ?? t('noKeyStored')}`),
            account.enabled ? null : h('span', null, t('disabled'))),
          h(LastTestLine, { account, t })),
        h('div', { className: 'dshMaStatusCell' },
          h(StatusTag, { state: account.status?.state ?? 'ok', t })),
        h('div', { className: 'dshMaSwitchCell' },
          h(Switch, {
            checked: account.enabled,
            disabled: busy,
            label: `${account.enabled ? t('disable') : t('enable')}: ${account.label}`,
            title: account.enabled ? t('disable') : t('enable'),
            onChange: (checked) => onToggle(account, checked),
          })),
        h('div', { className: 'dshMaActions' },
          h(Tooltip, { label: t('testTooltip') },
            h(Button, {
              variant: 'outline', size: 'sm', disabled: busy,
              'aria-label': `${t('test')}: ${account.label}`,
              icon: testing
                ? h(IconRefreshOutlineRegular, { size: 14, className: 'dshMaSpin' })
                : h(IconPlayOutlineRegular, { size: 14 }),
              onClick: () => onTest(account),
            }, testing ? t('testing') : t('test'))),
          account.status?.state && account.status.state !== 'ok'
            ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => onClearStatus(account) }, t('clearStatus'))
            : null,
          h(Button, {
            variant: isActive ? 'outline' : 'primary', size: 'sm', disabled: busy || isActive || !account.enabled,
            onClick: () => onSwitch(account),
            title: t('activate'),
          }, isActive ? t('activated') : t('activate')),
          confirming
            ? h('span', { className: 'dshMaConfirm', role: 'group', 'aria-label': t('confirmRemove') },
                h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => setConfirming(false) }, t('cancel')),
                h(Button, { variant: 'outline', size: 'sm', className: 'dshMaDanger', disabled: busy, onClick: () => onRemove(account) }, t('confirmRemoveYes')))
            : h(Button, { variant: 'ghost', size: 'sm', className: 'dshMaDanger', disabled: busy,
                'aria-label': `${t('remove')}: ${account.label}`, onClick: () => setConfirming(true) }, t('remove'))))
    }

    function AccountManagerModal({ entry, onClose, callApi, t }) {
      const [provider, setProvider] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      // Account ids whose test request is currently in flight (row spinners).
      const [testingIds, setTestingIds] = React.useState(() => new Set())

      const refresh = React.useCallback(async () => {
        setLoading(true); setLoadError(false)
        try {
          const data = await callApi('state')
          const found = data.providers?.find((candidate) => candidate.providerId === entry.provider)
          setProvider(found ?? null)
        } catch {
          setLoadError(true)
        } finally {
          setLoading(false)
        }
      }, [callApi, entry.provider])

      React.useEffect(() => { void refresh() }, [refresh])

      const run = async (work) => {
        if (busy) { setNotice({ kind: 'error', text: t('saveBlocked') }); return }
        setBusy(true); setNotice(null)
        try {
          const next = await work()
          if (next?.provider) setProvider(next.provider)
          setNotice({ kind: 'ok', text: t('operationOk') })
        } catch (error) {
          setNotice({ kind: 'error', text: t('operationFailed', { message: error?.message ?? '' }) })
        } finally {
          setBusy(false)
        }
      }

      const summarizeResults = (results) => {
        const total = Array.isArray(results) ? results.length : 0
        if (total === 0) return { kind: 'error', text: t('testAllEmpty') }
        const ok = results.filter((result) => result.state === 'ok').length
        const failed = total - ok
        if (failed === 0) return { kind: 'ok', text: t('testSummaryOk', { ok, total }) }
        return { kind: 'error', text: t('testSummaryMixed', { ok, total, failed }) }
      }

      const runTest = async (scope, account) => {
        if (busy) { setNotice({ kind: 'error', text: t('saveBlocked') }); return }
        const ids = scope === 'account'
          ? [account.id]
          : (provider?.accounts ?? []).map((candidate) => candidate.id)
        // The global batch may still have work on other providers even when
        // the currently open one has no accounts.
        if (scope !== 'all' && ids.length === 0) {
          setNotice({ kind: 'error', text: t('testAllEmpty') }); return
        }
        setBusy(true)
        setTestingIds(new Set(ids))
        setNotice(null)
        try {
          if (scope === 'account') {
            const body = await callApi('test-account', { providerId: entry.provider, accountId: account.id })
            if (body?.provider) setProvider(body.provider)
            const result = body?.result
            setNotice(result?.state === 'ok'
              ? { kind: 'ok', text: t('testPassed', { latency: result.latencyMs ?? 0 }) }
              : { kind: 'error', text: t('testFailed', { code: result?.code ?? t('statusUnknown') }) })
          } else if (scope === 'provider') {
            const body = await callApi('test-provider', { providerId: entry.provider })
            if (body?.provider) setProvider(body.provider)
            setNotice(summarizeResults(body?.results))
          } else {
            const body = await callApi('test-all')
            const current = body?.providers?.find((candidate) => candidate.providerId === entry.provider)
            if (current) setProvider(current)
            setNotice(summarizeResults(body?.results))
          }
        } catch (error) {
          setNotice({ kind: 'error', text: t('operationFailed', { message: error?.message ?? '' }) })
        } finally {
          setBusy(false)
          setTestingIds(new Set())
        }
      }

      const guardedClose = () => { if (!busy) onClose() }
      const modeOptions = [
        { value: 'manual', label: t('modeManual') },
        { value: 'on-error', label: t('modeOnError') },
        { value: 'round-robin', label: t('modeRoundRobin') },
      ]
      const modeHint = {
        manual: t('modeManualHint'),
        'on-error': t('modeOnErrorHint'),
        'round-robin': t('modeRoundRobinHint'),
      }

      return h(Modal, {
        open: true,
        onClose: guardedClose,
        title: t('title', { name: entry.displayName ?? entry.provider }),
        closeLabel: t('close'),
        className: 'dshMaModal',
      },
        h('div', { className: 'dshMaBody' },
          provider?.ref
            ? h('p', { className: 'dshMaRef' }, t('refLine', { ref: provider.ref }))
            : h('p', { className: 'dshMaRefMissing', role: 'alert' }, t('refMissing')),
          loading
            ? h('p', { className: 'dshMaNotice', role: 'status' }, t('loading'))
            : loadError
              ? h('div', null,
                  h('p', { className: 'dshMaError', role: 'alert' }, t('loadError')),
                  h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), onClick: refresh }, t('retry')))
              : h(React.Fragment, null,
                  h('section', { className: 'dshMaMode', 'aria-label': t('modeLabel') },
                    h('p', { className: 'dshMaModeTitle' }, t('modeLabel')),
                    h(SegmentedControl, {
                      id: 'dshMaMode',
                      label: t('modeLabel'),
                      value: provider?.mode ?? 'manual',
                      options: modeOptions,
                      disabled: busy || !provider?.managed,
                      onChange: (mode) => run(() => callApi('mode', { providerId: entry.provider, mode })),
                    }),
                    h('p', { className: 'dshMaModeHint' }, modeHint[provider?.mode ?? 'manual'])),
                  h('section', { 'aria-label': t('accountsHeading') },
                    h('div', { className: 'dshMaBatchActions' },
                      h('p', { className: 'dshMaModeTitle', style: { margin: 0 } },
                        `${t('accountsHeading')} · ${provider?.accounts?.length ? t('accountCount', { count: provider.accounts.length }) : t('none')}`),
                      h(Tooltip, { label: t('testProvider') },
                        h(Button, {
                          variant: 'outline', size: 'sm', disabled: busy || !provider?.accounts?.length,
                          icon: h(IconPlayOutlineRegular, { size: 14 }),
                          onClick: () => runTest('provider'),
                        }, t('testProvider'))),
                      h(Tooltip, { label: t('testAllProviders') },
                        h(Button, {
                          variant: 'ghost', size: 'sm', disabled: busy,
                          icon: h(IconChecklistOutlineRegular, { size: 14 }),
                          onClick: () => runTest('all'),
                        }, t('testAllProviders')))),
                    provider?.accounts?.length
                      ? h('ul', { className: 'dshMaList', style: { listStyle: 'none', margin: 0, padding: 0 } },
                          h('li', { className: 'dshMaListHead', 'aria-hidden': true },
                            h('span', null, t('columnAccount')),
                            h('span', null, t('columnStatus')),
                            h('span', null, t('columnEnabled')),
                            h('span', null, t('columnActions'))),
                          provider.accounts.map((account) => h(AccountRow, {
                            key: account.id, account, mode: provider.mode, busy,
                            testing: testingIds.has(account.id), t,
                            onTest: (target) => runTest('account', target),
                            onSwitch: (target) => run(() => callApi('switch', { providerId: entry.provider, accountId: target.id })),
                            onToggle: (target, enabled) => run(() => callApi('toggle', { providerId: entry.provider, accountId: target.id, enabled })),
                            onRemove: (target) => run(() => callApi('remove', { providerId: entry.provider, accountId: target.id })),
                            onClearStatus: (target) => run(() => callApi('clear-status', { providerId: entry.provider, accountId: target.id })),
                          })))
                      : h('p', { className: 'dshMaEmpty' }, t('empty'))),
                  h(AddAccountForm, {
                    busy, t,
                    canImport: provider?.refConfigured === true,
                    onAdd: (payload) => run(() => callApi('add', { providerId: entry.provider, ...payload })),
                    onImport: () => run(() => callApi('import', { providerId: entry.provider })),
                  }),
                  h('p', { className: 'dshMaLive', role: 'status', 'aria-live': 'polite' },
                    notice ? h('span', { style: { color: notice.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' } }, notice.text) : null))))
    }

    /** Slot contribution rendered on every provider row of the Models page. */
    function ProviderAccountButton(props) {
      // ownerProps name the directory entry `provider`; rename for clarity.
      const entry = props.provider
      const { callApi, t } = props
      const [open, setOpen] = React.useState(false)
      const [summary, setSummary] = React.useState({ count: 0, active: false, hasRef: false })

      React.useEffect(() => {
        let cancelled = false
        callApi('state').then((data) => {
          if (cancelled) return
          const found = data.providers?.find((candidate) => candidate.providerId === entry.provider)
          if (!found) return
          setSummary({
            count: found.accounts?.length ?? 0,
            active: found.accounts?.some((account) => account.active) ?? false,
            hasRef: Boolean(found.ref),
          })
        }).catch(() => undefined)
        return () => { cancelled = true }
      }, [callApi, entry.provider, open])

      // OAuth-only routes (e.g. the first-party DeepSeek account) have no
      // apiKeyEnv ref and cannot be switched by rotating stored keys.
      if (!summary.hasRef) return null

      return h('div', { className: 'dshMaRoot' },
        h('div', { className: 'dshMaEntry' },
          h(Tooltip, { label: t('entryHint') },
            h(Button, {
              variant: 'outline',
              size: 'sm',
              className: 'dshMaEntryButton',
              icon: h(IconUsersOutlineRegular, { size: 14 }),
              'aria-label': t('openManager', { name: entry.displayName ?? entry.provider }),
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              onClick: () => setOpen(true),
            },
              h('span', null, t('entryLabel')),
              h('span', { className: `dshMaCount${summary.active ? ' isActive' : ''}` },
                summary.count === 1 ? t('accountCountOne') : t('accountCount', { count: summary.count }))))),
        open
          ? h(AccountManagerModal, {
              entry,
              callApi,
              t,
              onClose: () => {
                setOpen(false)
                // Refresh the row badge after the modal changed accounts.
                callApi('state').then((data) => {
                  const found = data.providers?.find((candidate) => candidate.providerId === entry.provider)
                  if (!found) return
                  setSummary({
                    count: found.accounts?.length ?? 0,
                    active: found.accounts?.some((account) => account.active) ?? false,
                    hasRef: Boolean(found.ref),
                  })
                }).catch(() => undefined)
              },
            })
          : null)
    }

    function injectStyles() {
      const guard = 'dsh-multi-account'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${guard}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = guard
      tag.dataset.plugin = 'dsh-multi-account'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-multi-account: locale')
      ctx.effect(injectStyles, 'dsh-multi-account: styles')
      const t = ctx.locale.bind(NS)
      const callApi = callApiFactory(ctx)

      const registered = new Set()
      const registerFor = (settingsNs) => {
        if (!settingsNs || registered.has(settingsNs)) return
        registered.add(settingsNs)
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: settingsNs,
          locale: NS,
          inject: () => ({ callApi, t }),
        }, ProviderAccountButton))
      }

      // The standard llm-pi-ai namespace covers every built-in and custom
      // provider route; register it immediately, then adopt any extra
      // namespaces the running composition happens to expose.
      registerFor(DEFAULT_SETTINGS_NS)
      callApi('state').then((data) => {
        for (const provider of data.providers ?? []) {
          if (provider.settingsNs) registerFor(provider.settingsNs)
        }
      }).catch(() => undefined)
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
