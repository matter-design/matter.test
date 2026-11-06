import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";

/**
 * tsx/esbuild (used by the CLI and worker) compiles named functions with a `__name(fn, "name")` wrapper.
 * Functions we pass to page.evaluate are sent as source, wrapper included, but the page has no `__name`:
 * "ReferenceError: __name is not defined". Defining a no-op in every context fixes it for all evaluate calls.
 */
export const BUNDLER_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

export async function newContext(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.addInitScript(BUNDLER_SHIM);
  return context;
}
