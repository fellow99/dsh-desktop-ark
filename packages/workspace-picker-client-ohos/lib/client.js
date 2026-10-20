window.__ModuleLoader__.load({
  id: '@dsh-ohos/workspace-picker-client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 与 Host 侧 `PACKER_ROUTE_PREFIX` 一致（`packages/workspace-picker-ohos/lib/routes.js`）。 */
    const ROUTES = '/_ohos/picker'

    /** 文案（本包自带；不注册 locale 命名空间，避免和上游 picker 抢）。 */
    const COPY = {
      title: '选择工作区目录',
      tabs: { sandbox: '沙箱', documents: '文档', download: '下载' },
      loading: '加载中…',
      empty: '该目录下没有子文件夹',
      newFolder: '新建文件夹',
      folderName: '文件夹名称',
      create: '创建',
      cancel: '取消',
      open: '打开',
      requestPermission: '请求权限',
      refresh: '刷新',
      truncated: '文件夹过多，仅显示开头部分。',
      permissionTitle: '未获得该目录的访问权限',
      permissionBody: '点「请求权限」按系统提示授权；授权后点「刷新」即可浏览。',
      permissionDenied: '用户拒绝了授权。系统在「曾经拒绝/被撤销」后不再弹窗，可去系统设置里开启该权限再点「刷新」。',
      permissionInvalid: '平台不受理本次授权请求（authResult=2，常见于手机形态或应用不在前台）。可点「刷新」重试，或改用系统文件选择器。',
      permissionUnknown: '平台没有给出授权结果（authResults 为空），且目录仍不可读——可能是刚才点了「不允许」，也可能是平台不受理该请求。可点「请求权限」重试；若反复无效，请到「设置 → 应用 → 权限」手动开启后点「刷新」。',
      permissionUnreadable: '平台报「已授权」，但目录实际仍不可读。可重启应用后再点「刷新」，或去系统设置里撤销后重新授权。',
      permissionUnavailable: '无法判定权限状态（宿主桥不可用）——请确认应用已正常启动后再试。',
      missingTitle: '此设备没有该目录',
      missingBody: '路径不存在（不是权限问题）。可点「刷新」重新检测，或用「沙箱」目录作为工作区。',
      failed: '打开失败',
    }

    const S = {
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 40,
      },
      card: {
        width: 'min(680px, 92vw)',
        maxHeight: '78vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        color: '#1a1a1a',
        borderRadius: 14,
        boxShadow: '0 18px 48px rgba(0,0,0,0.22)',
        overflow: 'hidden',
        font: '14px/1.5 system-ui, -apple-system, "HarmonyOS Sans", sans-serif',
      },
      header: { padding: '16px 18px 10px', fontWeight: 600, fontSize: 16 },
      tabs: { display: 'flex', gap: 6, padding: '0 14px 10px', borderBottom: '1px solid #ececec' },
      tab: (active) => ({
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid ' + (active ? '#d0d0d0' : 'transparent'),
        background: active ? '#f3f3f3' : 'transparent',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        color: '#1a1a1a',
      }),
      crumbRow: { display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 18px', borderBottom: '1px solid #f2f2f2', fontSize: 12, color: '#666' },
      crumb: { cursor: 'pointer', textDecoration: 'underline' },
      body: { flex: 1, overflowY: 'auto', padding: '8px 10px', minHeight: 180 },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 10px',
        borderRadius: 8,
        cursor: 'pointer',
      },
      muted: { padding: '26px 18px', color: '#888', textAlign: 'center' },
      footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid #ececec' },
      spacer: { flex: 1 },
      btn: (primary) => ({
        padding: '7px 16px',
        borderRadius: 9,
        border: '1px solid ' + (primary ? '#111' : '#dcdcdc'),
        background: primary ? '#111' : '#fff',
        color: primary ? '#fff' : '#1a1a1a',
        cursor: 'pointer',
        fontWeight: primary ? 600 : 400,
      }),
      gate: { padding: '28px 20px', textAlign: 'center' },
      gateTitle: { fontWeight: 600, marginBottom: 6 },
      gateBody: { color: '#666', fontSize: 13, marginBottom: 16 },
      input: { padding: '7px 10px', borderRadius: 8, border: '1px solid #dcdcdc', minWidth: 180, font: 'inherit' },
      error: { color: '#b3261e', fontSize: 12, padding: '0 18px 8px' },
    }

    /**
     * 调 Host 路由。
     *
     * **必须有上限**：授权类请求要等用户在系统窗里点按，平台也可能永远不应答
     * （真机上出现过停在「加载中…」直到超时的情况）。所以给一个明确上限，
     * 超时后抛出可读错误，而不是让界面一直转圈。
     *
     * @param {string} path
     * @param {unknown} [body] - 省略则为 GET
     * @param {number} [timeoutMs] - 默认 180 s（授权窗点击 + 系统往返留足余量）
     */
    async function callRoute(path, body, timeoutMs = 180_000) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(ROUTES + path, body === undefined
          ? { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller?.signal }
          : {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(body),
              signal: controller?.signal,
            })
        if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
        return response.json()
      } catch (failure) {
        if (failure instanceof Error && failure.name === 'AbortError') {
          throw new Error(`${path} -> 超时（${Math.round(timeoutMs / 1000)} s 未应答）`)
        }
        throw failure
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /**
     * 对话框本体。owner props（`DirectoryFlowOwnerProps`）：`open` / `busy` / `onPicked` / `onCancel`。
     */
    function WorkspacePickerFlow(props) {
      const { open, onPicked, onCancel } = props
      const [roots, setRoots] = React.useState([])
      const [tab, setTab] = React.useState('sandbox')
      const [listing, setListing] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [gate, setGate] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      const [folderName, setFolderName] = React.useState('')
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const rootOf = React.useCallback((id) => roots.find((root) => root.id === id), [roots])

      /** 拉根清单（含授权状态）。 */
      const loadRoots = React.useCallback(async () => {
        try {
          const payload = await callRoute('/roots')
          if (!mounted.current) return []
          const next = Array.isArray(payload.roots) ? payload.roots : []
          setRoots(next)
          return next
        } catch (failure) {
          if (mounted.current) setError(`${COPY.failed}: ${failure instanceof Error ? failure.message : String(failure)}`)
          return []
        }
      }, [])

      /** 列目录；失败时若带 permissionRequired 就切到授权门。 */
      const loadListing = React.useCallback(async (path) => {
        setLoading(true)
        setError('')
        try {
          const payload = await callRoute('/list', path === undefined ? {} : { path })
          if (!mounted.current) return
          if (payload.ok === true) {
            setListing(payload.listing)
            setGate(null)
          } else if (payload.error && payload.error.missing === true) {
            setListing(null)
            setGate({ kind: 'missing', rootId: tab, message: payload.error.message || '' })
          } else if (payload.error && payload.error.permissionRequired === true) {
            setListing(null)
            setGate({ kind: 'permission', rootId: tab, reason: 'not-granted', message: '' })
          } else {
            setListing(null)
            setError(`${COPY.failed}: ${payload.error ? payload.error.message : 'unknown'}`)
          }
        } catch (failure) {
          if (mounted.current) setError(`${COPY.failed}: ${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          if (mounted.current) setLoading(false)
        }
      }, [tab])

      /** 进入某个 Tab：**只查权限、不申请**。 */
      const enterTab = React.useCallback(async (id) => {
        setTab(id)
        setCreating(false)
        setFolderName('')
        setError('')
        const root = (await loadRoots()).find((candidate) => candidate.id === id)
        if (id === 'sandbox') {
          await loadListing(undefined)
          return
        }
        if (root === undefined) {
          setGate({ kind: 'permission', rootId: id, reason: 'unavailable', message: '' })
          setListing(null)
          return
        }
        // 目录本身不存在（设备没有用户主目录体系）⇒ 不是权限问题，不给授权按钮。
        if (root.missing === true) {
          setListing(null)
          setGate({ kind: 'missing', rootId: id, message: root.permissionDetail || '' })
          return
        }
        if (root.granted === true) {
          await loadListing(root.path)
          return
        }
        // 未授权 / 无法判定：不列目录、不申请，直接给「请求权限 / 刷新」两个按钮。
        setListing(null)
        setGate({
          kind: 'permission',
          rootId: id,
          reason: root.result ?? 'not-granted',
          message: root.permissionDetail || '',
        })
      }, [loadListing, loadRoots])

      // 打开时进入当前 Tab。
      React.useEffect(() => {
        if (!open) return
        setListing(null)
        setGate(null)
        setError('')
        enterTab('sandbox')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open])

      if (!open) return null

      const requestPermission = async () => {
        setLoading(true)
        setError('')
        try {
          const payload = await callRoute('/permission/request', { rootId: gate?.rootId ?? tab })
          if (!mounted.current) return
          if (payload.granted === true) {
            setGate(null)
            const root = rootOf(tab)
            await loadListing(root ? root.path : undefined)
          } else if (payload.result === 'missing') {
            setGate({ kind: 'missing', rootId: tab, message: payload.detail || '' })
          } else {
            // denied(-1) / invalid(2) / unavailable 三种原因分开呈现，不混成一句「失败」。
            setGate({ kind: 'permission', rootId: tab, reason: payload.result || 'unknown', message: payload.detail || '' })
          }
        } catch (failure) {
          if (mounted.current) setError(`${COPY.failed}: ${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          if (mounted.current) setLoading(false)
        }
      }

      const refresh = async () => {
        const root = (await loadRoots()).find((candidate) => candidate.id === tab)
        if (root === undefined) return
        if (root.missing === true) {
          setGate({ kind: 'missing', rootId: tab, message: root.permissionDetail || '' })
        } else if (root.granted === true || tab === 'sandbox') {
          await loadListing(root.path)
        } else {
          setGate({
            kind: 'permission',
            rootId: tab,
            reason: root.result ?? 'not-granted',
            message: root.permissionDetail || '',
          })
        }
      }

      const createFolder = async () => {
        const name = folderName.trim()
        if (name === '' || listing === null) return
        setLoading(true)
        setError('')
        try {
          const payload = await callRoute('/create', { path: listing.path, name })
          if (!mounted.current) return
          if (payload.ok === true) {
            setCreating(false)
            setFolderName('')
            await loadListing(listing.path)
          } else if (payload.error && payload.error.permissionRequired === true) {
            setGate({ kind: 'permission', rootId: tab, reason: 'denied', message: payload.error.message || '' })
          } else {
            setError(`${COPY.failed}: ${payload.error ? payload.error.message : 'unknown'}`)
          }
        } finally {
          if (mounted.current) setLoading(false)
        }
      }

      const crumbs = listing === null ? [] : listing.crumbs ?? []
      const currentPath = listing === null ? (rootOf(tab)?.path ?? '') : listing.path

      return h('div', { style: S.overlay, role: 'dialog', 'aria-modal': true, 'aria-label': COPY.title },
        h('div', { style: S.card },
          h('div', { style: S.header }, COPY.title),
          h('div', { style: S.tabs },
            ...['sandbox', 'documents', 'download'].map((id) =>
              h('button', {
                key: id,
                type: 'button',
                style: S.tab(tab === id),
                onClick: () => enterTab(id),
              }, COPY.tabs[id]),
            ),
          ),
          crumbs.length > 0 && h('div', { style: S.crumbRow },
            ...crumbs.map((crumb, index) =>
              h('span', { key: crumb.path },
                index > 0 ? h('span', { style: { margin: '0 4px', color: '#c4c4c4' } }, '/') : null,
                h('span', {
                  style: S.crumb,
                  onClick: () => loadListing(crumb.path),
                }, crumb.name || crumb.path),
              ),
            ),
          ),
          error !== '' && h('div', { style: S.error }, error),
          h('div', { style: S.body },
            loading && h('div', { style: S.muted }, COPY.loading),
            // 目录不存在（设备没有用户主目录）：只给「刷新」，不给「请求权限」——授权解决不了。
            !loading && gate !== null && gate.kind === 'missing' && h('div', { style: S.gate },
              h('div', { style: S.gateTitle }, COPY.missingTitle),
              h('div', { style: S.gateBody },
                COPY.missingBody,
                gate.message ? h('div', { style: { marginTop: 6, color: '#999' } }, gate.message) : null,
              ),
              h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
                h('button', { type: 'button', style: S.btn(true), onClick: refresh }, COPY.refresh),
              ),
            ),
            // 授权门：未授权 / 用户拒绝 / 平台不受理 / 桥不可用，四种原因分别给文案。
            !loading && gate !== null && gate.kind !== 'missing' && h('div', { style: S.gate },
              h('div', { style: S.gateTitle }, COPY.permissionTitle),
              h('div', { style: S.gateBody },
                COPY.permissionBody,
                gate.reason === 'denied' ? h('div', { style: { marginTop: 6 } }, COPY.permissionDenied) : null,
                gate.reason === 'invalid' ? h('div', { style: { marginTop: 6 } }, COPY.permissionInvalid) : null,
                gate.reason === 'unknown' ? h('div', { style: { marginTop: 6 } }, COPY.permissionUnknown) : null,
                gate.reason === 'granted-unreadable' ? h('div', { style: { marginTop: 6 } }, COPY.permissionUnreadable) : null,
                gate.reason === 'unavailable' ? h('div', { style: { marginTop: 6 } }, COPY.permissionUnavailable) : null,
                gate.message ? h('div', { style: { marginTop: 6, color: '#999' } }, gate.message) : null,
              ),
              h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
                h('button', { type: 'button', style: S.btn(true), onClick: requestPermission }, COPY.requestPermission),
                h('button', { type: 'button', style: S.btn(false), onClick: refresh }, COPY.refresh),
              ),
            ),
            !loading && gate === null && listing !== null && (listing.entries ?? []).length === 0 &&
              h('div', { style: S.muted }, COPY.empty),
            !loading && gate === null && listing !== null && (listing.entries ?? []).length > 0 &&
              h('div', null,
                ...(listing.entries ?? []).map((entry) =>
                  h('div', {
                    key: entry.path,
                    style: S.row,
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => loadListing(entry.path),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') loadListing(entry.path)
                    },
                  },
                    h('span', { style: { opacity: 0.65 } }, '📁'),
                    h('span', null, entry.name),
                  ),
                ),
                listing.truncated ? h('div', { style: S.muted }, COPY.truncated) : null,
              ),
          ),
          h('div', { style: S.footer },
            creating
              ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('input', {
                    style: S.input,
                    autoFocus: true,
                    placeholder: COPY.folderName,
                    value: folderName,
                    onChange: (event) => setFolderName(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') createFolder()
                      if (event.key === 'Escape') setCreating(false)
                    },
                  }),
                  h('button', { type: 'button', style: S.btn(true), onClick: createFolder }, COPY.create),
                )
              : h('button', {
                  type: 'button',
                  style: S.btn(false),
                  disabled: listing === null,
                  onClick: () => setCreating(true),
                }, COPY.newFolder),
            h('div', { style: S.spacer }),
            h('button', { type: 'button', style: S.btn(false), onClick: onCancel }, COPY.cancel),
            h('button', {
              type: 'button',
              style: S.btn(true),
              disabled: currentPath === '',
              onClick: () => onPicked(currentPath),
            }, COPY.open),
          ),
        ),
      )
    }

    /** 客户端插件：把对话框挂到 ui-workspace 的两个 directoryFlow 槽。 */
    const inject = ['slots', 'uiWorkspace']

    function apply(ctx) {
      ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
        ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
          yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow' }, WorkspacePickerFlow)
          yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow' }, WorkspacePickerFlow)
        }),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.WorkspacePickerFlow = WorkspacePickerFlow
    exports.ROUTES = ROUTES
    exports.COPY = COPY
    return module.exports
  },
})
