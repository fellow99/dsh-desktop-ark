/**
 * Minimal stand-in for `@deepseek-ai/cordis` used ONLY by the smoke tests.
 *
 * The real package is resolved by the host at runtime; the packages in this
 * repository have no `node_modules` (no build, no install), so tests map the
 * bare specifier here with `module.registerHooks`. `Service` records the name it
 * would register and calls `ctx.provide` when the fake context offers one.
 */

export class Context {}

export class Service {
  constructor(ctx, name) {
    this.ctx = ctx
    this.name = name
    if (ctx !== undefined && typeof ctx.provide === 'function') ctx.provide(name, this)
  }
}

export default { Context, Service }
