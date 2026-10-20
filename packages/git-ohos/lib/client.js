/**
 * Client half of @dsh-ohos/git: the "Git 凭据" page in Settings.
 *
 * Lazy-CJS factory: script execution only registers the factory; every side effect (dictionary
 * registration, slot registration) runs inside the factory closure.
 *
 * The page is deliberately **write-mostly**. The client-reachable credential API serves
 * `describe` / `set` / `unset` over reference names and never returns a stored value, and it
 * cannot enumerate references either — so the page shows the hosts the user has entered here
 * (remembered in `localStorage`) plus, per host, whether a credential is configured and where it
 * came from. The value format and reference name are the host contract implemented in
 * `lib/auth.js` (`GIT_CREDENTIAL_<HOST>` with `host[:port]` upper-cased and every non-alphanumeric
 * character replaced by `_`, value `<username>:<password>`), and they are printed verbatim so a
 * user can also maintain `$DSH_HOME/.credentials.yaml` by hand.
 */

window.__ModuleLoader__.load({
  id: '@dsh-ohos/git',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOCALE_NS = 'gitCredentials'
    const STORAGE_KEY = '@dsh-ohos/git.hosts'
    const REF_PREFIX = 'GIT_CREDENTIAL_'

    /**
     * Mirror of the host-side reference-name rule (`lib/auth.js`). Kept as a two-line duplicate
     * rather than an import because the two halves ship in different module graphs; if one
     * changes, the other must change with it.
     */
    function refForHost(host) {
      return REF_PREFIX + String(host).toUpperCase().replace(/[^A-Z0-9]/g, '_')
    }

    /** Hosts the user has entered on this page, newest last. Never contains a secret. */
    function readHosts() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
        return Array.isArray(raw) ? raw.filter(entry => typeof entry === 'string' && entry.length > 0) : []
      } catch {
        return []
      }
    }

    /** @param hosts - the host list to persist. */
    function writeHosts(hosts) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
      } catch {
        // A full or unavailable localStorage must not break credential management: the store
        // itself is the source of truth, this list is only the page's own index.
      }
    }
    /**
     * Index one `credentials.describe` answer by reference name.
     *
     * The documented shape is an object keyed by ref, but this page cannot afford to *depend* on a
     * shape it cannot see: on device every row read "状态未知" while the credential was provably
     * stored, because the answer did not index the way the page read it and the failure was
     * swallowed. So an answer is accepted as an object, a `Map`, an array of `[ref, info]` pairs,
     * or an array of rows carrying `ref` / `name` / `credentialRef` — and a key that merely differs
     * in letter case, or that carries or omits the `GIT_CREDENTIAL_` prefix, matches too.
     *
     * Nothing is invented: a ref the answer never names stays absent, so its row keeps saying
     * "状态未知" rather than guessing a state the store did not report.
     *
     * @param answer - whatever `describe` returned.
     * @param refs - the reference names the caller asked about.
     * @returns an object with one entry per ref that could be matched.
     */
    function indexByRef(answer, refs) {
      const exact = new Set(refs)
      const folded = new Map()
      for (const ref of refs) {
        folded.set(ref, ref)
        folded.set(ref.toUpperCase(), ref)
        folded.set(ref.toUpperCase().replace(/^GIT_CREDENTIAL_/, ''), ref)
        folded.set(`GIT_CREDENTIAL_${ref.toUpperCase()}`, ref)
      }
      const match = rawRef => {
        if (typeof rawRef !== 'string') return undefined
        if (exact.has(rawRef)) return rawRef
        return folded.get(rawRef.toUpperCase())
      }
      const out = {}
      const take = (rawRef, info) => {
        const target = match(rawRef)
        if (target === undefined || info === undefined || info === null) return
        out[target] = info
      }
      if (answer instanceof Map) {
        for (const [ref, info] of answer) take(ref, info)
      } else if (Array.isArray(answer)) {
        for (const entry of answer) {
          if (Array.isArray(entry) && entry.length >= 2) take(entry[0], entry[1])
          else if (entry && typeof entry === 'object') take(entry.ref ?? entry.name ?? entry.credentialRef, entry)
        }
      } else if (answer && typeof answer === 'object') {
        for (const [ref, info] of Object.entries(answer)) take(ref, info)
      }
      return out
    }

    /**
     * A short, secret-free description of an unusable `describe` answer, for the page's error line.
     *
     * Only the container kind and key names are reported: `CredentialInfo` carries state and never
     * a value, and this must stay true even if it is handed something else.
     *
     * @param answer - whatever `describe` returned.
     * @returns a one-line description.
     */
    function describeShapeOf(answer) {
      if (answer === null) return 'null'
      if (answer === undefined) return 'undefined'
      if (answer instanceof Map) return `Map(${answer.size})`
      if (Array.isArray(answer)) {
        const first = answer[0]
        const keys = first && typeof first === 'object' && !Array.isArray(first)
          ? ' keys: ' + Object.keys(first).slice(0, 6).join('/')
          : ''
        return `array(${answer.length})${keys}`
      }
      if (typeof answer === 'object') return `object keys: ${Object.keys(answer).slice(0, 6).join('/')}`
      return typeof answer
    }

    /**
     * Unwrap a remote envelope before indexing it.
     *
     * A settings page is not entitled to assume it receives the raw business value: on device
     * `credentials.describe` answered `{ ok: true, value: {...} }`, and the page indexed the
     * envelope, which is exactly why every row read 状态未知 while the credential was stored. An
     * `{ ok: false }` answer is re-thrown so the page reports the failure the store actually
     * returned instead of inventing a state.
     *
     * @param answer - whatever the remote call resolved to.
     * @returns the business value, or the input unchanged when it is not an envelope.
     */
    function unwrapEnvelope(answer) {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer instanceof Map) return answer
      if (!('ok' in answer) && !('value' in answer)) return answer
      if (answer.ok === false) {
        const detail = answer.error && answer.error.message ? answer.error.message : (answer.error ?? 'unknown error')
        throw new Error(String(detail))
      }
      return 'value' in answer ? answer.value : answer
    }

    /**
     * One configured-host row: reference name, live status, and the two write actions.
     * @param props - row props assembled by the page.
     */
    function HostRow(props) {
      const { host, info, busy, t, onRemove, onUpdate } = props
      const ref = refForHost(host)
      const state = info === undefined
        ? 'unknown'
        : info.configured ? (info.writable ? 'configured' : 'readonly') : 'absent'
      return h('div', { className: 'git-cred-row' }, [
        h('div', { className: 'git-cred-id', key: 'id' }, [
          h('div', { className: 'git-cred-host', key: 'host' }, host),
          h('code', { className: 'git-cred-ref', key: 'ref', title: ref }, ref),
        ]),
        h('span', { className: `git-cred-state ${state}`, key: 'state' }, t(`state.${state}`)),
        h('div', { className: 'git-cred-actions', key: 'actions' }, [
          h('button', { type: 'button', className: 'git-cred-btn ghost', key: 'update', disabled: busy, onClick: () => onUpdate(host) }, t('action.update')),
          h('button', { type: 'button', className: 'git-cred-btn ghost danger', key: 'remove', disabled: busy, onClick: () => onRemove(host) }, t('action.remove')),
        ]),
      ])
    }

    // The section carries its own stylesheet (the sibling workspace-picker client does the same).
    // It borrows the shell's semantic tokens rather than hard-coding a palette — `--dsw-alias-*` is
    // the app's own layer, so the page follows the theme — and keeps a literal fallback on every
    // use, so a renamed token degrades to a readable page instead of an unstyled one.
    const stylesheet = [
      '.git-cred{display:flex;flex-direction:column;gap:14px;font-size:14px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.git-cred-head{display:flex;flex-direction:column;gap:4px}',
      '.git-cred-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}',
      '.git-cred-lead{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}',
      // One row, always: the three fields share the width (host takes twice the room of the two
      // short ones) and the save button stays put. `nowrap` plus the small `min-width` floors mean a
      // narrower window squeezes the fields instead of pushing the button onto a second line.
      '.git-cred-form{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}',
      '.git-cred-input{box-sizing:border-box;height:36px;padding:0 10px;font-size:14px;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-sm,8px);outline:none}',
      '.git-cred-input::placeholder{color:var(--dsw-alias-label-caption,#9aa0a6)}',
      '.git-cred-input:focus{border-color:var(--dsw-alias-brand-primary,#0f1115)}',
      '.git-cred-input:disabled{opacity:.6}',
      '.git-cred-input.is-host{flex:2 1 0;min-width:88px}',
      '.git-cred-input.is-user{flex:1 1 0;min-width:64px}',
      '.git-cred-input.is-pass{flex:1 1 0;min-width:64px}',
      '.git-cred-btn{height:36px;padding:0 16px;font-size:14px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;white-space:nowrap}',
      '.git-cred-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.git-cred-btn.primary{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.git-cred-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a3a3a)}',
      '.git-cred-btn.ghost{height:28px;padding:0 10px;font-size:13px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);border-color:var(--dsw-alias-border-l2,#0000001a)}',
      '.git-cred-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.git-cred-btn.ghost.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,#ec13130d);color:var(--dsw-alias-state-error-label,#d92d20);border-color:transparent}',
      '.git-cred-msg{margin:0;font-size:13px}',
      '.git-cred-msg.ok{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.git-cred-msg.error{color:var(--dsw-alias-state-error-label,#d92d20)}',
      '.git-cred-list{display:flex;flex-direction:column;gap:8px}',
      '.git-cred-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff))}',
      '.git-cred-id{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.git-cred-host{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.git-cred-ref{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-caption,#9aa0a6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.git-cred-state{flex:0 0 auto;padding:2px 8px;font-size:12px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#81858c);background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.git-cred-state.configured{color:var(--dsw-alias-brand-primary,#0f1115)}',
      '.git-cred-actions{display:flex;gap:6px;flex:0 0 auto}',
      '.git-cred-empty{margin:0;font-size:13px;color:var(--dsw-alias-label-caption,#9aa0a6)}',
      '.git-cred-foot{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-caption,#9aa0a6)}',
    ].join('\n')

    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = '@dsh-ohos/git'
    styleTag.textContent = stylesheet
    document.head.append(styleTag)

    /**
     * The settings section. Everything it renders is derived from `describe()` plus the local host
     * index; no secret is ever read back.
     * @param props - `{ t, describe, set, unset }` provided by the registration's `inject`.
     */
    function GitCredentialsSection(props) {
      const { t, describe, set, unset } = props
      const [hosts, setHosts] = React.useState(readHosts)
      const [info, setInfo] = React.useState({})
      const [form, setForm] = React.useState({ host: '', username: '', password: '' })
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      /**
       * Re-read every known host's status in one batched call.
       *
       * Returns the outcome so the caller can decide what to tell the user — a status read that
       * failed must not be overwritten by a success message.
       *
       * @param list - the hosts to describe.
       * @returns `{ ok: true }`, or `{ ok: false, message }` for the page's message line.
       */
      const refresh = React.useCallback(async (list) => {
        if (list.length === 0) {
          setInfo({})
          return { ok: true }
        }
        const refs = list.map(refForHost)
        try {
          // The remote layer hands back its own envelope, not the business value: on device the
          // answer was `{ ok, value }`, and this page indexed the envelope instead of the record
          // inside it, so every row read 状态未知.
          const answer = unwrapEnvelope(await describe(refs))
          const indexed = indexByRef(answer, refs)
          setInfo(indexed)
          const unmatched = refs.filter(ref => indexed[ref] === undefined)
          if (unmatched.length > 0) {
            // The store did not answer for a name it was asked about: report the shape instead of
            // rendering a silent "状态未知", which is what hid this defect on device.
            return {
              ok: false,
              message: { kind: 'error', text: `${t('error.describe')} (${describeShapeOf(answer)})` },
            }
          }
          return { ok: true }
        } catch (error) {
          setInfo({})
          return {
            ok: false,
            message: {
              kind: 'error',
              text: t('error.describe') + ' ' + String(error && error.message ? error.message : error),
            },
          }
        }
      }, [describe, t])

      React.useEffect(() => { void refresh(hosts) }, [hosts, refresh])

      /** Save one host's credentials, remembering the host so the page can find it again. */
      const save = React.useCallback(async (host, username, password) => {
        if (host.trim() === '' || username === '' || password === '') {
          setMessage({ kind: 'error', text: t('error.incomplete') })
          return
        }
        setBusy(true)
        setMessage(null)
        try {
          await set(refForHost(host.trim()), `${username}:${password}`)
          const next = hosts.includes(host.trim()) ? hosts : [...hosts, host.trim()]
          setHosts(next)
          writeHosts(next)
          // Only claim success when the status read that follows actually worked: the earlier build
          // painted "已保存。" over a describe failure, so every row silently stayed 状态未知.
          const refreshed = await refresh(next)
          setMessage(refreshed.ok ? { kind: 'ok', text: t('saved') } : refreshed.message)
        } catch (error) {
          setMessage({ kind: 'error', text: String(error && error.message ? error.message : error) })
        } finally {
          setBusy(false)
        }
      }, [hosts, refresh, set, t])

      return h('section', { className: 'git-cred' }, [
        h('div', { className: 'git-cred-head', key: 'head' }, [
          h('h2', { className: 'git-cred-title', key: 'title' }, t('title')),
          h('p', { className: 'git-cred-lead', key: 'lead' }, t('lead')),
        ]),
        h('div', { className: 'git-cred-form', key: 'form' }, [
          h('input', {
            key: 'host', className: 'git-cred-input is-host', placeholder: t('field.host'), title: t('field.host.hint'), value: form.host, disabled: busy,
            onChange: event => setForm({ ...form, host: event.target.value }),
          }),
          h('input', {
            key: 'user', className: 'git-cred-input is-user', placeholder: t('field.username'), value: form.username, disabled: busy,
            onChange: event => setForm({ ...form, username: event.target.value }),
          }),
          h('input', {
            key: 'pass', className: 'git-cred-input is-pass', type: 'password', placeholder: t('field.password'), value: form.password, disabled: busy,
            onChange: event => setForm({ ...form, password: event.target.value }),
            // Enter saves, the way the other forms in this shell behave.
            onKeyDown: event => {
              if (event.key !== 'Enter' || busy) return
              void (async () => {
                await save(form.host, form.username, form.password)
                setForm({ host: '', username: '', password: '' })
              })()
            },
          }),
          h('button', {
            key: 'save', className: 'git-cred-btn primary', type: 'button', disabled: busy,
            onClick: async () => {
              await save(form.host, form.username, form.password)
              setForm({ host: '', username: '', password: '' })
            },
          }, t('action.save')),
        ]),
        message === null ? null : h('p', { className: `git-cred-msg ${message.kind}`, key: 'msg' }, message.text),
        hosts.length === 0
          ? h('p', { className: 'git-cred-empty', key: 'empty' }, t('empty'))
          : h('div', { className: 'git-cred-list', key: 'list' }, hosts.map(host => h(HostRow, {
            key: host,
            host,
            info: info[refForHost(host)],
            busy,
            t,
            onRemove: async (target) => {
              setBusy(true)
              setMessage(null)
              try {
                await unset(refForHost(target))
                const next = hosts.filter(entry => entry !== target)
                setHosts(next)
                writeHosts(next)
                await refresh(next)
                setMessage({ kind: 'ok', text: t('removed') })
              } catch (error) {
                setMessage({ kind: 'error', text: String(error && error.message ? error.message : error) })
              } finally {
                setBusy(false)
              }
            },
            onUpdate: (target) => setForm({ host: target, username: '', password: '' }),
          }))),
        h('p', { className: 'git-cred-foot', key: 'warn' }, t('warn')),
      ])
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials'],

      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          const dictionaries = [
            ['zh', {
              'nav': 'Git 凭据',
              'title': 'Git 凭据',
              'lead': '需要认证的远端所用的凭据；保存在 ~/.dsh/.git-credentials（git 原生格式，可手工编辑）。',
              'field.host': '主机名:端口',
              'field.host.hint': '例如 git.example.com:8443',
              'field.username': '用户名',
              'field.password': '密码',
              'action.save': '保存',
              'action.update': '更新',
              'action.remove': '删除',
              'state.configured': '已配置',
              'state.readonly': '只读来源',
              'state.absent': '未配置',
              'state.unknown': '状态未知',
              'saved': '已保存。',
              'removed': '已删除。',
              'empty': '还没有保存任何主机。',
              'error.incomplete': '请填写主机、用户名与密码。',
              'error.describe': '读取凭据状态失败：',
              'warn': '明文 http:// 远端会以 Base64 传输该凭据，生产环境请使用 https://。',
            }],
            ['en', {
              'nav': 'Git credentials',
              'title': 'Git credentials',
              'lead': 'Credentials for authenticated remotes; stored in ~/.dsh/.git-credentials in git\u2019s own format, so they can be edited or copied by hand.',
              'field.host': 'host:port',
              'field.host.hint': 'e.g. git.example.com:8443',
              'field.username': 'Username',
              'field.password': 'Password',
              'action.save': 'Save',
              'action.update': 'Update',
              'action.remove': 'Remove',
              'state.configured': 'Configured',
              'state.readonly': 'Read-only source',
              'state.absent': 'Not configured',
              'state.unknown': 'Unknown',
              'saved': 'Saved.',
              'removed': 'Removed.',
              'empty': 'No host saved yet.',
              'error.incomplete': 'Host, username and password are all required.',
              'error.describe': 'Could not read credential status: ',
              'warn': 'A plaintext http:// remote sends this credential as Base64 \u2014 use https:// in production.',
            }],
          ]
          try {
            for (const [locale, dict] of dictionaries) disposers.push(ctx.locale.register(LOCALE_NS, locale, dict))
          } catch (error) {
            for (const dispose of disposers.reverse()) dispose()
            throw error
          }
          return () => { for (const dispose of disposers) dispose() }
        }, 'git-credentials: dictionaries')

        const t = ctx.locale.bind(LOCALE_NS)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'git-credentials',
          order: 40,
          label: () => t('nav'),
          locale: LOCALE_NS,
          inject: () => ({
            t,
            describe: refs => ctx.remote.credentials.describe(refs),
            set: (ref, value) => ctx.remote.credentials.set(ref, value),
            unset: ref => ctx.remote.credentials.unset(ref),
          }),
        }, GitCredentialsSection))
      },
    }
  },
})
