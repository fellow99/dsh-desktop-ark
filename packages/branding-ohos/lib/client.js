window.__ModuleLoader__.load({
  id: '@dsh-ohos/branding',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 自有文案命名空间：不与上游任何包的命名空间抢占用者（`locale.register` 同名同语言会抛错）。 */
    const NS = 'brand.ohos'

    /**
     * 产品名。与 `AppScope/resources/base/element/string.json` 的 `app_name` 保持一致；
     * 换产品名时改这两行 + `lib/index.js` 的 `PRODUCT_TITLE`（`specs/205-plugin-branding` 有回归用例）。
     */
    const zh = { product: 'DSH Desktop' }
    const en = { product: 'DSH Desktop' }

    /**
     * 产品图标的几何（1024 × 1024）。与本应用 HAP 图标的图形一致；
     * 这里内联渲染（不是 data URI），避免依赖 `img-src` 之类的 CSP 配置，
     * 并顺带丢掉原始 SVG 里的编辑器/图标库元数据属性。
     */
    const LOGO_VIEWBOX = 1024
    const LOGO_PATHS = [
      {
        d: 'M42.666667 469.333333a341.333333 341.333333 0 0 1 341.333333-341.333333h256a341.333333 341.333333 0 0 1 341.333333 341.333333v85.333334a341.333333 341.333333 0 0 1-341.333333 341.333333H384a341.333333 341.333333 0 0 1-341.333333-341.333333v-85.333334z',
        fill: '#1296db',
      },
      {
        d: 'M170.666667 512a256 256 0 0 1 256-256h170.666666a256 256 0 0 1 0 512h-170.666666a256 256 0 0 1-256-256z',
        fill: '#FFFFFF',
      },
      {
        d: 'M539.861333 658.56l230.229334 35.498667-224.554667 160.981333-5.674667-196.437333z',
        fill: '#FFFFFF',
      },
      {
        d: 'M426.666667 512a85.333333 85.333333 0 1 1-170.666667 0 85.333333 85.333333 0 0 1 170.666667 0zM768 512a85.333333 85.333333 0 1 1-170.666667 0 85.333333 85.333333 0 0 1 170.666667 0z',
        fill: '#1296db',
      },
    ]

    /** hero 品牌位标记属性：Host 半边下发的样式以它为锚点（值必须与 `lib/index.js` 的 `HERO_ATTR` 一致）。 */
    const HERO_ATTR = 'data-dsh-ohos-hero'

    /**
     * 产品图标。
     * @param {{ size?: number }} props - 边长（px）；宽度即高度，图标是正方形。
     * @returns {unknown} 内联 `<svg>` 元素。
     */
    function Logo(props) {
      const size = props.size === undefined ? 24 : props.size
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 ' + LOGO_VIEWBOX + ' ' + LOGO_VIEWBOX,
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, LOGO_PATHS.map((path, index) => h('path', { key: index, d: path.d, fill: path.fill })))
    }

    /**
     * 侧栏折叠轨的品牌位（`sidebar.brand.mark`，尺寸由 owner 给）。
     * @param {{ size?: number }} props - owner 传入的图标边长。
     * @returns {unknown} 产品图标。
     */
    function SidebarMark(props) {
      return h(Logo, { size: props.size })
    }

    /**
     * 侧栏展开态的产品名（`sidebar.brand.name`）。字体/行高/字重由上游 `.brandName` 容器给。
     * @param {{ t: (key: 'product') => string }} props - 槽位 owner 面 + 渲染器合成的 `t`。
     * @returns {unknown} 产品名文本。
     */
    function SidebarName(props) {
      return h('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, props.t('product'))
    }

    /**
     * 会话空态 hero 的品牌位（`conversation.hero.brand.mark`）：图标 + 产品名。
     *
     * 上游把"图标 + 标语 + Preview 徽标"拆成两段：图标走这个槽位，标语写死在组件里。
     * 因此这里把'图标 + 产品名'作为一个整体渲染，并用 `data-dsh-ohos-hero` 让 Host 半边
     * 下发的样式隐藏上游那段标语（见 `lib/index.js` 的 `HERO_CSS`）。
     * `className`（上游给鱼形图标的类）刻意不转发：那是海洋生物的动画/裁剪规则。
     * @param {{ size?: number, t: (key: 'product') => string }} props - owner 面 + `t`。
     * @returns {unknown} 图标 + 产品名。
     */
    function HeroBrand(props) {
      return h('span', {
        [HERO_ATTR]: '',
        style: { display: 'inline-flex', alignItems: 'center', columnGap: 10, flex: 'none' },
      },
        h(Logo, { size: props.size === undefined ? 34 : props.size }),
        h('span', { style: { whiteSpace: 'nowrap' } }, props.t('product')),
      )
    }

    /** 客户端插件：槽位注册表 + 自有文案命名空间。 */
    const inject = ['slots', 'locale']

    /**
     * 上游客户端也会写窗口标题：`ui-layout` 的 `DocumentTitle` 用
     * `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`，而预构建的 Web 产物里
     * `process.env` 被折叠成空对象 ⇒ 标题恒为 `brand.localBuild` 的文案（"DSH 本地构建" /
     * "DSH Local Build"），并且每次切换会话都会被重写成「会话名 — <该文案>」。
     * `brand.localBuild` 属于上游 `common` 命名空间，`locale.register` 不允许第二个占用者，
     * 所以这里改**产物字符串**：观察 `<title>` 的文本变化，把上游产品名替换成我们的。
     */
    const UPSTREAM_PRODUCT_TITLES = ['DSH Local Build', 'DSH 本地构建']

    /**
     * 把窗口标题里的上游产品名换成我们的产品名（幂等；无变化时不写，避免观察器自激）。
     * @param {string} raw - 当前 `document.title`。
     * @param {string} product - 我们的产品名。
     * @returns {string} 替换后的标题。
     */
    function rewriteTitle(raw, product) {
      let next = raw
      for (const upstream of UPSTREAM_PRODUCT_TITLES) {
        if (next.includes(upstream)) next = next.split(upstream).join(product)
      }
      return next
    }

    /**
     * 安装标题守卫：立刻纠正一次，并跟随上游后续的标题写入（会话标题、语言切换）。
     * @param {() => string} product - 读取当前语言下的产品名。
     * @returns {() => void} 卸载函数（断开观察器）。
     */
    function installTitleGuard(product) {
      const apply = () => {
        const raw = document.title
        const next = rewriteTitle(raw, product())
        if (next !== raw) document.title = next
      }
      apply()
      const target = document.head
      if (target === null) return () => {}
      const observer = new MutationObserver(apply)
      observer.observe(target, { subtree: true, childList: true, characterData: true })
      return () => observer.disconnect()
    }

    /**
     * 注册自有文案，占用三个品牌槽位。
     * @param {{ locale: { register: Function }, slots: { inject: Function, register: Function } }} ctx
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'branding: dictionaries')
      ctx.effect(() => installTitleGuard(() => ctx.locale.bind(NS)('product')), 'branding: window title')
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark', locale: NS }, SidebarMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, SidebarName)
            yield ctx.slots.register({ name: 'conversation.hero.brand.mark', locale: NS }, HeroBrand)
          }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.HERO_ATTR = HERO_ATTR
    exports.LOGO_PATHS = LOGO_PATHS
    exports.Logo = Logo
    exports.SidebarMark = SidebarMark
    exports.SidebarName = SidebarName
    exports.HeroBrand = HeroBrand
    exports.rewriteTitle = rewriteTitle
    exports.installTitleGuard = installTitleGuard
    exports.UPSTREAM_PRODUCT_TITLES = UPSTREAM_PRODUCT_TITLES
    return module.exports
  },
})
