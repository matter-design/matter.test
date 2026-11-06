import type { Browser, BrowserContext } from "playwright";
import { newContext } from "./browser-shim";
import { RateLimiter } from "./links";
import { parseRobots, type RobotsRules } from "./robots";

export interface CrawledPage {
  url: string;
  status: number | null;
  headers: Record<string, string>;
  html: string;
  depth: number;
  links: string[];
  images: string[];
  contentType?: string;
  /** The site served a bot-protection challenge instead of the page. Excluded from every check. */
  blocked?: boolean;
  error?: string;
}

/**
 * Bot-protection interstitials (Cloudflare and similar). We never try to get past these:
 * the page is reported as not checked, and the site owner can allowlist the crawler.
 */
export const BOT_CHALLENGE = /Verify you are human|needs to be verified before you can proceed|<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare|\/cdn-cgi\/challenge-platform\/|cf-turnstile|Checking if the site connection is secure/i;
export const isBotChallenge = (html: string) => BOT_CHALLENGE.test(html.slice(0, 200_000));

export interface CrawlOptions {
  maxPages: number;
  concurrency: number;
  delayMs: number;
  userAgent: string;
  respectRobots: boolean;
  /** Extra hosts treated as internal (e.g. www and apex). */
  sameSiteHosts?: string[];
  onPage?: (page: CrawledPage) => void | Promise<void>;
  /** Shared limiter: on 429 every crawl worker pauses and slows down. Created per crawl when not given. */
  limiter?: RateLimiter;
}

const SKIP_EXT = /\.(pdf|zip|jpe?g|png|gif|webp|avif|svg|mp4|webm|mp3|woff2?|ttf|css|js|xml|json|md|txt|csv)(\?|$)/i;

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

/**
 * Pull <loc> entries from a sitemap, following one level of sitemap index.
 * Child sitemaps are interleaved (round robin) so one big product sitemap cannot crowd out
 * collections, pages and blog posts.
 */
export async function readSitemap(url: string, userAgent: string, limit = 2000): Promise<string[]> {
  const xml = await fetchText(url, userAgent);
  if (!xml) return [];
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  if (!/<sitemapindex/i.test(xml)) return locs.slice(0, limit);
  const children: string[][] = [];
  for (const child of locs.slice(0, 20)) {
    const cx = await fetchText(child, userAgent);
    if (cx) children.push([...cx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&")));
  }
  return interleave(children, limit);
}

/** Round-robin merge: a1, b1, c1, a2, b2, ... */
export function interleave<T>(lists: T[][], limit = Infinity): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i]!);
  return out;
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
  // Sitemap URLs fill at most half the budget, so pages linked from the home page (menus, categories) still get crawled.
  const sitemapBudget = Math.max(1, Math.floor(opts.maxPages / 2));
  const fromSitemaps: string[][] = [];
  for (const sm of sitemapUrls) fromSitemaps.push(await readSitemap(sm, opts.userAgent, sitemapBudget));
  const seeds = [baseUrl, ...interleave(fromSitemaps, sitemapBudget)];

  const seen = new Set<string>();
  const queue: { url: string; depth: number; attempts?: number }[] = [];
  // Never trips on its own: crawling just gets slower. maxConsecutive429 / budget effectively off.
  const limiter = opts.limiter ?? new RateLimiter(opts.delayMs, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const enqueue = (raw: string, depth: number, limit = opts.maxPages) => {
    const n = normaliseUrl(raw, baseUrl);
    if (!n || seen.has(n) || seen.size >= limit) return;
    const u = new URL(n);
    if (!hosts.has(u.host) || SKIP_EXT.test(u.pathname) || !robots.isAllowed(u.pathname + u.search)) return;
    seen.add(n);
    queue.push({ url: n, depth });
  };
  enqueue(baseUrl, 0);
  for (const s of seeds.slice(1)) enqueue(s, 1, sitemapBudget + 1);

  const context: BrowserContext = await newContext(browser, { userAgent: opts.userAgent });
  const results: CrawledPage[] = [];
  let challengesInARow = 0;

  const worker = async () => {
    const page = await context.newPage();
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await limiter.wait();
        const result = await visit(page, next.url, next.depth);
        if (result.html && isBotChallenge(result.html)) result.blocked = true;
        if (result.blocked) {
          // Slow down, and stop entirely if the site keeps challenging us: hammering on would only get worse.
          limiter.on429(null);
          if (++challengesInARow >= 5) queue.length = 0;
          results.push(result);
          continue;
        }
        challengesInARow = 0;
        if (result.status === 429) {
          limiter.on429(result.headers["retry-after"] ?? null);
          // Try the page again at the back of the queue (twice at most); after that keep the 429 as the result.
          if ((next.attempts ?? 0) < 2) {
            queue.push({ ...next, attempts: (next.attempts ?? 0) + 1 });
            continue;
          }
        } else limiter.onOk();
        // Markdown, JSON, PDFs and the like served without a telltale extension: not a web page, skip it.
        if (result.contentType && !/html/i.test(result.contentType)) continue;
        results.push(result);
        await opts.onPage?.(result);
        for (const l of result.links) enqueue(l, next.depth + 1);
        const pause = Math.max(opts.delayMs, limiter.delayMs);
        if (pause) await new Promise((r) => setTimeout(r, pause));
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
      contentType: res ? ((await res.allHeaders())["content-type"] ?? undefined) : undefined,
      status: res?.status() ?? null,
      headers: res ? await res.allHeaders() : {},
      html: await page.content(),
      blocked: undefined as boolean | undefined,
      depth,
      links,
      images,
    };
  } catch (e) {
    return { url, status: null, headers: {}, html: "", depth, links: [], images: [], error: (e as Error).message };
  }
}
