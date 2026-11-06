import type { Browser, BrowserContext } from "playwright";
import { parseRobots, type RobotsRules } from "./robots";

export interface CrawledPage {
  url: string;
  status: number | null;
  headers: Record<string, string>;
  html: string;
  depth: number;
  links: string[];
  images: string[];
  error?: string;
}

export interface CrawlOptions {
  maxPages: number;
  concurrency: number;
  delayMs: number;
  userAgent: string;
  respectRobots: boolean;
  /** Extra hosts treated as internal (e.g. www and apex). */
  sameSiteHosts?: string[];
  onPage?: (page: CrawledPage) => void | Promise<void>;
}

const SKIP_EXT = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|webm|mp3|woff2?|ttf|css|js|xml|json)(\?|$)/i;

/** Strip hash and common tracking params so the same page is not crawled twice. */
export function normaliseUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|mc_)/i.test(p)) u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return null;
  }
}

export async function fetchText(url: string, userAgent: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Pull <loc> entries from a sitemap, following one level of sitemap index. */
export async function readSitemap(url: string, userAgent: string, limit = 2000): Promise<string[]> {
  const xml = await fetchText(url, userAgent);
  if (!xml) return [];
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);
  if (/<sitemapindex/i.test(xml)) {
    const nested: string[] = [];
    for (const child of locs.slice(0, 20)) {
      nested.push(...(await readSitemap(child, userAgent, limit - nested.length)));
      if (nested.length >= limit) break;
    }
    return nested.slice(0, limit);
  }
  return locs.slice(0, limit);
}

/**
 * Breadth-first crawl with a real browser so JS-rendered links are found.
 * Seeds from the base URL plus sitemap URLs; stays on the same site.
 */
export async function crawl(browser: Browser, baseUrl: string, opts: CrawlOptions): Promise<CrawledPage[]> {
  const base = new URL(baseUrl);
  const hosts = new Set([base.host, ...(opts.sameSiteHosts ?? [])]);
  let robots: RobotsRules = parseRobots("");
  if (opts.respectRobots) {
    const txt = await fetchText(new URL("/robots.txt", base).toString(), opts.userAgent);
    if (txt) robots = parseRobots(txt, opts.userAgent);
  }

  const sitemapUrls = robots.sitemaps.length ? robots.sitemaps : [new URL("/sitemap.xml", base).toString()];
  const seeds = [baseUrl];
  for (const sm of sitemapUrls) seeds.push(...(await readSitemap(sm, opts.userAgent, opts.maxPages)));

  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const enqueue = (raw: string, depth: number) => {
    const n = normaliseUrl(raw, baseUrl);
    if (!n || seen.has(n) || seen.size >= opts.maxPages) return;
    const u = new URL(n);
    if (!hosts.has(u.host) || SKIP_EXT.test(u.pathname) || !robots.isAllowed(u.pathname + u.search)) return;
    seen.add(n);
    queue.push({ url: n, depth });
  };
  for (const s of seeds) enqueue(s, 0);

  const context: BrowserContext = await browser.newContext({ userAgent: opts.userAgent });
  const results: CrawledPage[] = [];

  const worker = async () => {
    const page = await context.newPage();
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await visit(page, next.url, next.depth);
        results.push(result);
        await opts.onPage?.(result);
        for (const l of result.links) enqueue(l, next.depth + 1);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
    } finally {
      await page.close();
    }
  };

  // Workers stop when the queue is momentarily empty; loop until nothing new appears.
  while (queue.length) {
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, queue.length) }, worker));
  }
  await context.close();
  return results;
}

async function visit(page: import("playwright").Page, url: string, depth: number): Promise<CrawledPage> {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const { links, images } = await page.evaluate(() => ({
      links: Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href),
      images: Array.from(document.images, (i) => i.currentSrc || i.src).filter(Boolean),
    }));
    return {
      url,
      status: res?.status() ?? null,
      headers: res ? await res.allHeaders() : {},
      html: await page.content(),
      depth,
      links,
      images,
    };
  } catch (e) {
    return { url, status: null, headers: {}, html: "", depth, links: [], images: [], error: (e as Error).message };
  }
}
