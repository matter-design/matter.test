import type { Browser } from "playwright";
import type { CheckCategory, FindingInput, Platform } from "@mattertest/core";
import { axeFindings } from "./a11y";
import { crawl, type CrawledPage, normaliseUrl } from "./crawl";
import { checkUrls, linkFindings } from "./links";
import { detectPlatform } from "./platform";
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
  /** How many pages per template get the (slower) axe scan. */
  a11yPagesPerTemplate?: number;
  onProgress?: (msg: string) => void;
}

export interface SiteCheckResult {
  platform: Platform;
  platformEvidence: string[];
  pages: Omit<CrawledPage, "html">[];
  templates: Record<string, number>;
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
  const pages = await crawl(browser, o.baseUrl, {
    maxPages: o.maxPages,
    concurrency: o.concurrency ?? 4,
    delayMs: o.delayMs ?? 250,
    userAgent: ua,
    respectRobots: o.respectRobots ?? true,
  });
  log(`crawled ${pages.length} pages`);

  const home = pages[0];
  const { platform, evidence } = home ? detectPlatform(home.html, home.headers) : { platform: "custom" as Platform, evidence: [] };

  const templates: Record<string, number> = {};
  const byTemplate = new Map<string, CrawledPage[]>();
  for (const p of pages) {
    const t = guessTemplate(p.url, platform);
    templates[t] = (templates[t] ?? 0) + 1;
    byTemplate.set(t, [...(byTemplate.get(t) ?? []), p]);
  }

  if (want.has("crawl")) {
    for (const p of pages) {
      if (p.error) findings.push({ category: "crawl", rule: "crawl.page-error", severity: "high", title: "Page failed to load", url: p.url, detail: p.error });
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
    findings.push(...linkFindings(await checkUrls([...linkRefs.keys()], ua), linkRefs, "link"));
    findings.push(...linkFindings(await checkUrls([...imgRefs.keys()].slice(0, 2000), ua), imgRefs, "image"));
  }

  if (want.has("seo")) {
    const facts = pages.filter((p) => p.html && (p.status ?? 0) < 400).map((p) => extractSeoFacts(p.url, p.html));
    for (const f of facts) findings.push(...seoPageFindings(f));
    findings.push(...seoSiteFindings(facts));
  }

  if (want.has("security") && home) {
    findings.push(...securityHeaderFindings(home.url, home.headers));
    const ctx = await browser.newContext({ userAgent: ua });
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
    const perTemplate = o.a11yPagesPerTemplate ?? 2;
    const sample = [...byTemplate.values()].flatMap((ps) => ps.filter((p) => !p.error).slice(0, perTemplate));
    log(`axe scan on ${sample.length} pages (WCAG 2.2 AA)`);
    const ctx = await browser.newContext({ userAgent: ua });
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

  // performance, visual, platform packs and reporting: next phase (see README roadmap).
  return {
    platform,
    platformEvidence: evidence,
    pages: pages.map(({ html: _html, ...rest }) => rest),
    templates,
    findings,
  };
}
