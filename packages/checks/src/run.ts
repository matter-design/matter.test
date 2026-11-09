import type { Browser } from "playwright";
import { newContext } from "./browser-shim";
import type { CheckCategory, FindingInput, Platform } from "@mattertest/core";
import { axeFindings } from "./a11y";
import { crawl, type CrawledPage, fetchText, normaliseUrl } from "./crawl";
import { checkUrls, linkFindings, RateLimiter } from "./links";
import { detectPlatform } from "./platform";
import { packFor, type PackPage } from "./packs";
import { startLighthouse, type LighthouseRunner } from "./lighthouse";
import { DEFAULT_BUDGETS, instrumentContext, measureInteraction, measurePage, perfFindings, type PerfBudgets, type PerfMetrics, type Throttle } from "./performance";
import { BROWSERS, runVisualChecks, visualFindings, type BrowserName, type VisualCapture, type VisualOptions, type ViewportName, VIEWPORTS } from "./visual";
import { securityHeaderFindings, cookieFindings, EXPOSED_FILE_PROBES } from "./security";
import { extractSeoFacts, seoPageFindings, seoSiteFindings } from "./seo";

export interface SiteCheckOptions {
  baseUrl: string;
  categories: CheckCategory[];
  maxPages: number;
  concurrency?: number;
  delayMs?: number;
  userAgent?: string;
  respectRobots?: boolean;
  /**
   * Pages of the same type (template) look alike, so accessibility, performance, SEO, security and visual checks
   * only test this many of each type. Default 1. The crawl, link checks and platform pack still cover every page.
   */
  pagesPerTemplate?: number;
  /** Override pagesPerTemplate for the axe scan. */
  a11yPagesPerTemplate?: number;
  /** Override pagesPerTemplate for performance measurement. */
  perfPagesPerTemplate?: number;
  /** Throttling for performance runs. Default "mobile" (same as PageSpeed Insights mobile). */
  perfThrottle?: Throttle;
  /** "lighthouse" (default) matches PageSpeed Insights; falls back to "browser" if Lighthouse cannot run. */
  perfEngine?: "lighthouse" | "browser";
  /** Time one harmless click per sampled page (lab stand-in for INP). Default true. */
  perfInteraction?: boolean;
  perfBudgets?: Partial<PerfBudgets>;
  /** Visual + cross-browser settings. Without a store, only the cross-browser checks run (no screenshot diffs). */
  visual?: Pick<VisualOptions, "browsers" | "viewports" | "store" | "mask" | "failRatio" | "threshold" | "maxHeight"> & { pagesPerTemplate?: number };
  onProgress?: (msg: string) => void;
}

export interface SiteCheckResult {
  platform: Platform;
  platformEvidence: string[];
  pages: Omit<CrawledPage, "html">[];
  templates: Record<string, number>;
  /** Lab performance metrics, one entry per measured page. */
  perf: (PerfMetrics & { template: string })[];
  /** Visual captures, one per page x browser x viewport. Null when the visual category was not run. */
  visual: { browsers: BrowserName[]; viewports: ViewportName[]; captures: VisualCapture[]; skippedBrowsers: { browser: BrowserName; reason: string }[] } | null;
  findings: FindingInput[];
}

/** Rough template guess from the URL shape, so expensive checks can sample one page per template. */
export function guessTemplate(url: string, platform: Platform): string {
  const p = new URL(url).pathname;
  if (p === "/" || p === "") return "home";
  if (/\/(cart|basket)/i.test(p)) return "cart";
  if (/\/(checkout)/i.test(p)) return "checkout";
  if (/\/(account|login|register)/i.test(p)) return "account";
  if (/\/(search)/i.test(p)) return "search";
  if (/\/(blog|news|articles?)\//i.test(p)) return "blog";
  if (platform === "shopify") {
    if (/\/products\//.test(p)) return "pdp";
    if (/\/collections\//.test(p)) return "plp";
  }
  if (/\/(products?|p)\//i.test(p)) return "pdp";
  if (/\/(categor(y|ies)|c|collections?|shop)\//i.test(p)) return "plp";
  const depth = p.split("/").filter(Boolean).length;
  return depth <= 1 ? "landing" : `depth-${depth}`;
}

export async function runSiteCheck(browser: Browser, o: SiteCheckOptions): Promise<SiteCheckResult> {
  const ua = o.userAgent ?? "MatterTestBot/0.1 (+internal QA crawler)";
  const want = new Set(o.categories);
  const log = o.onProgress ?? (() => undefined);
  const findings: FindingInput[] = [];

  log(`crawling ${o.baseUrl} (max ${o.maxPages} pages)`);
  const crawlLimiter = new RateLimiter(o.delayMs ?? 250, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const crawled = await crawl(browser, o.baseUrl, {
    limiter: crawlLimiter,
    maxPages: o.maxPages,
    concurrency: o.concurrency ?? 4,
    delayMs: o.delayMs ?? 250,
    userAgent: ua,
    respectRobots: o.respectRobots ?? true,
  });
  // Pages behind a bot-protection challenge are not the site: keep them out of every check.
  const blocked = crawled.filter((p) => p.blocked);
  const pages = crawled.filter((p) => !p.blocked);
  log(`crawled ${crawled.length} pages${blocked.length ? ` (${blocked.length} blocked by bot protection)` : ""}`);
  if (blocked.length)
    findings.push({
      category: "crawl",
      rule: "crawl.bot-protection",
      severity: "info",
      title: `${blocked.length} page${blocked.length === 1 ? "" : "s"} not checked: blocked by bot protection`,
      url: blocked[0]!.url,
      detail: "The site served a \"verify you are human\" challenge (e.g. Cloudflare) instead of the page. We do not try to get past these. Ask the site owner to allowlist the MatterTest crawler (user agent or IP) so scheduled checks can see every page.",
      evidence: { count: blocked.length, examples: blocked.slice(0, 20).map((p) => p.url) },
    });

  // The crawl order is not guaranteed (sitemap seeds, concurrency), so find the home page explicitly.
  const baseNorm = normaliseUrl(o.baseUrl, o.baseUrl);
  const home = pages.find((p) => p.url === baseNorm && p.html) ?? pages.find((p) => p.html && !p.error && (p.status ?? 0) < 400) ?? pages[0];
  const { platform, evidence } = home ? detectPlatform(home.html, home.headers) : { platform: "custom" as Platform, evidence: [] };

  const pack = packFor(platform);
  const templateOf = new Map<string, string>();
  const templates: Record<string, number> = {};
  const byTemplate = new Map<string, CrawledPage[]>();
  for (const p of pages) {
    // Platform markup (e.g. Stencil page_type) beats URL shape when the pack can read it.
    const t = (p.html && pack?.templateOf?.(p.html)) || guessTemplate(p.url, platform);
    templateOf.set(p.url, t);
    templates[t] = (templates[t] ?? 0) + 1;
    byTemplate.set(t, [...(byTemplate.get(t) ?? []), p]);
  }

  /** The first `n` healthy pages of each type: what the per-type checks look at. */
  const perType = o.pagesPerTemplate ?? 1;
  const sampleOf = (n = perType) => [...byTemplate.values()].flatMap((ps) => ps.filter((p) => p.html && !p.error && (p.status ?? 0) < 400).slice(0, n));

  if (want.has("crawl")) {
    for (const p of pages) {
      if (p.error) findings.push({ category: "crawl", rule: "crawl.page-error", severity: "high", title: "Page failed to load", url: p.url, detail: p.error });
      else if (p.status === 429) findings.push({ category: "crawl", rule: "crawl.rate-limited", severity: "info", title: "Page not checked: the site asked us to slow down (429)", url: p.url });
      else if (p.status && p.status >= 400) findings.push({ category: "crawl", rule: `crawl.status-${p.status}`, severity: p.status >= 500 ? "high" : "medium", title: `Page returned ${p.status}`, url: p.url });
    }
  }

  if (want.has("links")) {
    const crawled = new Set(pages.map((p) => p.url));
    const linkRefs = new Map<string, Set<string>>();
    const imgRefs = new Map<string, Set<string>>();
    const base = new URL(o.baseUrl);
    for (const p of pages) {
      for (const l of p.links) {
        const n = normaliseUrl(l, p.url);
        if (!n || crawled.has(n) || new URL(n).host !== base.host) continue;
        linkRefs.set(n, (linkRefs.get(n) ?? new Set()).add(p.url));
      }
      for (const i of p.images) {
        const n = normaliseUrl(i, p.url);
        if (n) imgRefs.set(n, (imgRefs.get(n) ?? new Set()).add(p.url));
      }
    }
    // Crawled pages already have a status; only fetch what the crawler did not visit.
    log(`checking ${linkRefs.size} uncrawled links and ${imgRefs.size} images`);
    // One limiter for links and images: if the site rate-limits us, both slow down, and both stop together.
    // Start at the pace the crawl settled on: if the site pushed back during the crawl, don't hammer it now.
    const limiter = new RateLimiter(Math.max(150, crawlLimiter.delayMs));
    // Most-linked first (menus, footers, shared banners): if the budget runs out, what is left is the long tail.
    const byReach = (m: Map<string, Set<string>>) => [...m.keys()].sort((a, b) => m.get(b)!.size - m.get(a)!.size);
    findings.push(...linkFindings(await checkUrls(byReach(linkRefs), ua, { limiter }), linkRefs, "link"));
    findings.push(...linkFindings(await checkUrls(byReach(imgRefs).slice(0, 2000), ua, { limiter }), imgRefs, "image"));
    if (limiter.tripped) log(`link checks stopped early (${limiter.tripped}); the rest are reported as not verified`);
  }

  if (want.has("seo")) {
    const seoPages = sampleOf();
    log(`SEO on ${seoPages.length} pages`);
    const facts = seoPages.map((p) => extractSeoFacts(p.url, p.html));
    for (const f of facts) findings.push(...seoPageFindings(f));
    findings.push(...seoSiteFindings(facts));
  }

  if (want.has("security") && home) {
    // Headers can differ by page type (e.g. checkout behind a different server rule), so sample each type.
    const secPages = sampleOf();
    if (!secPages.some((p) => p.url === home.url)) secPages.unshift(home);
    log(`security headers on ${secPages.length} pages`);
    for (const p of secPages) findings.push(...securityHeaderFindings(p.url, p.headers));
    const ctx = await newContext(browser, { userAgent: ua });
    const pg = await ctx.newPage();
    await pg.goto(home.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    const cookies = await ctx.cookies();
    findings.push(...cookieFindings(home.url, cookies.map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }))));
    await ctx.close();
    for (const probe of EXPOSED_FILE_PROBES) {
      const url = new URL(probe.path, o.baseUrl).toString();
      try {
        const res = await fetch(url, { headers: { "user-agent": ua }, redirect: "manual", signal: AbortSignal.timeout(8_000) });
        if (res.status === 200 && probe.looksLike.test((await res.text()).slice(0, 5000)))
          findings.push({ category: "security", rule: "security.exposed-file", severity: probe.severity, title: `Publicly readable: ${probe.path}`, url, selector: probe.path });
      } catch {
        /* unreachable is fine */
      }
    }
  }

  if (want.has("accessibility")) {
    const sample = sampleOf(o.a11yPagesPerTemplate ?? perType);
    log(`axe scan on ${sample.length} pages (WCAG 2.2 AA)`);
    const ctx = await newContext(browser, { userAgent: ua });
    const pg = await ctx.newPage();
    for (const p of sample) {
      try {
        await pg.goto(p.url, { waitUntil: "load", timeout: 30_000 });
        findings.push(...(await axeFindings(pg)));
      } catch (e) {
        log(`axe failed on ${p.url}: ${(e as Error).message}`);
      }
    }
    await ctx.close();
  }

  const perf: SiteCheckResult["perf"] = [];
  if (want.has("performance")) {
    const throttle = o.perfThrottle ?? "mobile";
    const budgets = { ...DEFAULT_BUDGETS, ...o.perfBudgets };
    const sample = sampleOf(o.perfPagesPerTemplate ?? perType);
    let lh: LighthouseRunner | undefined;
    if ((o.perfEngine ?? "lighthouse") === "lighthouse") {
      try {
        lh = await startLighthouse();
      } catch (e) {
        log(`Lighthouse unavailable, using in-browser measurement: ${(e as Error).message}`);
      }
    }
    log(`performance on ${sample.length} pages (${lh ? "Lighthouse" : "browser"}, throttle: ${throttle})`);
    try {
      for (const p of sample) {
        const template = templateOf.get(p.url) ?? "unknown";
        // Fresh context per page: cold cache, like a first visit.
        const ctx = await newContext(browser, { userAgent: ua, viewport: throttle === "mobile" ? { width: 412, height: 823 } : undefined });
        try {
          let m: PerfMetrics | undefined;
          if (lh) {
            try {
              m = await lh.run(p.url, throttle);
            } catch (e) {
              log(`Lighthouse failed on ${p.url}, falling back: ${(e as Error).message}`);
            }
          }
          if (!m) {
            await instrumentContext(ctx);
            m = await measurePage(ctx, p.url, { throttle });
          }
          if (o.perfInteraction ?? true) {
            m.interaction = await measureInteraction(ctx, p.url, template, { throttle }).catch((e: Error) => {
              log(`interaction failed on ${p.url}: ${e.message}`);
              return null;
            });
          }
          perf.push({ ...m, template });
          findings.push(...perfFindings(m, budgets, throttle));
        } catch (e) {
          log(`performance failed on ${p.url}: ${(e as Error).message}`);
        } finally {
          await ctx.close();
        }
      }
    } finally {
      await lh?.close();
    }
  }

  if (want.has("platform") && pack) {
    log(`${platform} pack`);
    const ctx = { baseUrl: o.baseUrl, robotsTxt: await fetchText(new URL("/robots.txt", o.baseUrl).toString(), ua) };
    const packPages: PackPage[] = pages.map((p) => ({ url: p.url, status: p.status, headers: p.headers, html: p.html, template: templateOf.get(p.url) ?? "unknown" }));
    for (const p of packPages) findings.push(...pack.pageFindings(p, ctx));
    findings.push(...pack.siteFindings(packPages, ctx));
    if (pack.probe) {
      const get = async (path: string) => {
        try {
          const res = await fetch(new URL(path, o.baseUrl), { headers: { "user-agent": ua }, redirect: "manual", signal: AbortSignal.timeout(8_000) });
          const text = await res.text();
          return { status: res.status, body: text.slice(0, 100_000), headers: Object.fromEntries(res.headers) };
        } catch {
          return null;
        }
      };
      findings.push(...(await pack.probe(ctx, get)));
    }
  }

  let visual: SiteCheckResult["visual"] = null;
  if (want.has("visual")) {
    const v = o.visual ?? {};
    const browsers = v.browsers ?? [...BROWSERS];
    const viewports = v.viewports ?? (Object.keys(VIEWPORTS) as ViewportName[]);
    const sample = sampleOf(v.pagesPerTemplate ?? perType).map((p) => ({ url: p.url, template: templateOf.get(p.url) ?? "unknown" }));
    log(`visual: ${sample.length} pages x ${browsers.length} browsers x ${viewports.length} viewports${v.store ? "" : " (no baseline store: cross-browser checks only)"}`);
    const r = await runVisualChecks(sample, { ...v, browsers, viewports, chromium: browser, userAgent: ua, onProgress: log });
    const tested = browsers.filter((b) => !r.skippedBrowsers.some((s) => s.browser === b));
    visual = { browsers: tested, viewports, captures: r.captures, skippedBrowsers: r.skippedBrowsers };
    findings.push(...visualFindings(r.captures, tested));
  }

  return {
    platform,
    platformEvidence: evidence,
    pages: crawled.map(({ html: _html, ...rest }) => rest),
    templates,
    perf,
    visual,
    findings,
  };
}
