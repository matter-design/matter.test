import type { BrowserContext, Page } from "playwright";
import type { FindingInput, Severity } from "@mattertest/core";

/**
 * Lab performance measurement in a real browser.
 *
 * These are lab numbers from one load on our machine, not field data (CrUX / real users),
 * which is what Google actually grades. Treat them as a regression signal, not a verdict.
 * INP needs real user interaction, so the lab proxy is Total Blocking Time (TBT).
 */
export interface PerfMetrics {
  url: string;
  /** "lighthouse" matches PageSpeed Insights; "browser" is the in-page fallback. */
  engine: "lighthouse" | "browser";
  /** Lighthouse performance score 0-100 (null for the browser engine). */
  score: number | null;
  /** Time to first byte, ms. */
  ttfb: number | null;
  /** First Contentful Paint, ms. */
  fcp: number | null;
  /** Largest Contentful Paint, ms. */
  lcp: number | null;
  /**
   * LCP actually observed during the Lighthouse load, unthrottled (Lighthouse engine only).
   * The simulated mobile LCP can be many times higher on request-heavy pages; reports show both.
   */
  observedLcp?: number | null;
  /** Element that was the LCP candidate. */
  lcpElement: string | null;
  /** Cumulative Layout Shift (session-window max, as web-vitals computes it). */
  cls: number;
  /** Total Blocking Time between FCP and load + 5 s settle, ms. Lab proxy for INP. */
  tbt: number;
  /** load event, ms from navigation start. */
  load: number | null;
  requests: number;
  /** Bytes over the wire, from resource timing (cross-origin without TAO reports 0). */
  transferBytes: number;
  jsBytes: number;
  imageBytes: number;
  /** Render-blocking scripts and stylesheets in <head>. */
  renderBlocking: string[];
  /** Images over the size budget: url and bytes. */
  heavyImages: { url: string; bytes: number }[];
  /** Failing Lighthouse insights, worst first (empty for the browser engine). */
  insights: { id: string; title: string; displayValue?: string }[];
  /** One scripted, side-effect-free interaction. Lab only: not real-user INP. */
  interaction: LabInteraction | null;
}

export interface LabInteraction {
  /** What was clicked, e.g. "button[aria-expanded] Menu". */
  target: string;
  /** Longest event duration for the interaction, ms (Event Timing API, same source INP uses). */
  latency: number;
}

// Thresholds and rating live in core so reports rate pages exactly as the checks do.
export { PERF_THRESHOLDS, rate, type PerfMetricName, type Rating } from "@mattertest/core";
import { PERF_THRESHOLDS, rate, type PerfMetricName, type Rating } from "@mattertest/core";

export interface PerfBudgets {
  /** Total page weight in bytes before a finding. */
  pageBytes: number;
  jsBytes: number;
  imageBytes: number;
  requests: number;
}
export const DEFAULT_BUDGETS: PerfBudgets = {
  pageBytes: 3_000_000,
  jsBytes: 1_000_000,
  imageBytes: 300_000,
  requests: 120,
};

/**
 * Throttling profiles. With Lighthouse: "mobile" and "desktop" match PageSpeed Insights.
 * With the browser engine: "mobile" is 4x CPU + slow 4G via CDP (Chromium only); "desktop" and "none" are unthrottled.
 */
export type Throttle = "none" | "mobile" | "desktop";

/** Installed before any page script runs: collects LCP, CLS and long tasks into window.__mtPerf. */
const OBSERVER_SCRIPT = `(() => {
  const s = { lcp: null, lcpElement: null, cls: 0, longTasks: [], fcp: null };
  window.__mtPerf = s;
  const describe = (el) => {
    if (!el || !el.tagName) return null;
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    else if (el.classList && el.classList.length) d += '.' + [...el.classList].slice(0, 2).join('.');
    if (el.currentSrc || el.src) d += ' ' + String(el.currentSrc || el.src).slice(0, 200);
    return d;
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { s.lcp = e.startTime; s.lcpElement = describe(e.element) || e.url || null; }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    let win = 0, first = 0, last = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        if (win && e.startTime - last < 1000 && e.startTime - first < 5000) { win += e.value; }
        else { win = e.value; first = e.startTime; }
        last = e.startTime;
        if (win > s.cls) s.cls = win;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) s.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') s.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch {}
})();`;

/** Prepare a context so every page in it records vitals from the first byte. */
export async function instrumentContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(OBSERVER_SCRIPT);
}

async function applyThrottle(page: Page, throttle: Throttle): Promise<void> {
  if (throttle !== "mobile") return;
  const browserName = page.context().browser()?.browserType().name();
  if (browserName !== "chromium") return; // CDP throttling is Chromium-only; other engines run unthrottled.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
}

/**
 * Load a page once in the given (instrumented) context and read its metrics.
 * Uses a fresh page each time so cache and observers do not leak between URLs.
 */
export async function measurePage(context: BrowserContext, url: string, opts: { throttle?: Throttle; settleMs?: number; timeoutMs?: number } = {}): Promise<PerfMetrics> {
  const page = await context.newPage();
  try {
    await applyThrottle(page, opts.throttle ?? "none");
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs ?? 60_000 });
    await page.waitForLoadState("networkidle", { timeout: opts.settleMs ?? 5_000 }).catch(() => undefined);
    // LCP stops updating on first input; with no input the last candidate after load + settle is the value.
    return await page.evaluate((u) => {
      const s = (window as unknown as { __mtPerf?: { lcp: number | null; lcpElement: string | null; cls: number; longTasks: [number, number][]; fcp: number | null } }).__mtPerf;
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const fcp = s?.fcp ?? null;
      const tbt = (s?.longTasks ?? [])
        .filter(([start]) => fcp === null || start >= fcp)
        .reduce((sum, [, d]) => sum + Math.max(0, d - 50), 0);
      const isImg = (r: PerformanceResourceTiming) => r.initiatorType === "img" || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(r.name);
      const isJs = (r: PerformanceResourceTiming) => r.initiatorType === "script" || /\.m?js(\?|$)/i.test(r.name);
      const size = (r: PerformanceResourceTiming) => r.transferSize || r.encodedBodySize || 0;
      const renderBlocking = Array.from(
        document.querySelectorAll('head script[src]:not([async]):not([defer]):not([type="module"]), head link[rel="stylesheet"]:not([media="print"])'),
        (el) => (el as HTMLScriptElement).src || (el as HTMLLinkElement).href,
      );
      return {
        url: u,
        engine: "browser" as const,
        score: null,
        insights: [],
        interaction: null,
        ttfb: nav ? Math.round(nav.responseStart - nav.startTime) : null,
        fcp: fcp === null ? null : Math.round(fcp),
        lcp: s?.lcp == null ? null : Math.round(s.lcp),
        lcpElement: s?.lcpElement ?? null,
        cls: Math.round((s?.cls ?? 0) * 1000) / 1000,
        tbt: Math.round(tbt),
        load: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd - nav.startTime) : null,
        requests: res.length + 1,
        transferBytes: res.reduce((a, r) => a + size(r), nav ? nav.transferSize || nav.encodedBodySize || 0 : 0),
        jsBytes: res.filter(isJs).reduce((a, r) => a + size(r), 0),
        imageBytes: res.filter(isImg).reduce((a, r) => a + size(r), 0),
        renderBlocking,
        heavyImages: res.filter(isImg).map((r) => ({ url: r.name, bytes: size(r) })),
      };
    }, url);
  } finally {
    await page.close();
  }
}

/**
 * Candidates for a harmless interaction, best first. Nothing here submits a form:
 * menus, accordions, disclosure widgets, gallery thumbnails and variant swatches (which only change client state).
 * Add-to-cart is deliberately excluded: it creates a cart on the client's store.
 */
const INTERACTION_TARGETS: Record<string, string[]> = {
  pdp: ["[data-product-attribute] label", ".productView-thumbnail-link", "[data-image-gallery-item]", "variant-radios label", ".product__media-toggle", "button[aria-controls]"],
  plp: ["[data-facet-toggle]", ".facetedSearch-toggle", "button[aria-expanded]", "details > summary"],
};
const GENERIC_TARGETS = ["button[aria-expanded]", "[aria-controls][role='button']", ".mobileMenu-toggle", "button[aria-haspopup]", "details > summary", "[role='tab']", "button:not([type='submit'])"];

/**
 * Click one harmless element after load and read the longest Event Timing entry for it.
 * Every non-GET request and every main-frame navigation after load is aborted, so the click cannot change server state.
 */
export async function measureInteraction(context: BrowserContext, url: string, template: string, opts: { throttle?: Throttle; timeoutMs?: number } = {}): Promise<LabInteraction | null> {
  const page = await context.newPage();
  let loaded = false;
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() !== "GET" && req.method() !== "HEAD") return route.abort("blockedbyclient");
    if (loaded && req.isNavigationRequest() && req.frame() === page.mainFrame()) return route.abort("blockedbyclient");
    return route.continue();
  });
  try {
    await applyThrottle(page, opts.throttle ?? "none");
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs ?? 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    loaded = true;
    await page.evaluate(() => {
      const w = window as unknown as { __mtEvents: number[] };
      w.__mtEvents = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & { interactionId?: number })[]) if (e.interactionId) w.__mtEvents.push(e.duration);
      }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    });
    for (const sel of [...(INTERACTION_TARGETS[template] ?? []), ...GENERIC_TARGETS]) {
      const el = page.locator(sel).filter({ visible: true }).first();
      if (!(await el.count())) continue;
      // Skip anything inside a POST form (submit buttons, add-to-cart) as a second line of defence.
      if (await el.evaluate((n) => !!n.closest("form[method='post' i]") && !(n.matches("label") || n.closest("[data-product-attribute]")))) continue;
      const label = await el.evaluate((n) => `${n.tagName.toLowerCase()} ${(n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}`.trim());
      try {
        await el.click({ timeout: 3_000 });
      } catch {
        continue;
      }
      await page.waitForTimeout(1_000);
      // Event Timing reports duration rounded to 8 ms and only entries >= 16 ms; nothing recorded means it was fast.
      const latency = await page.evaluate(() => Math.max(0, ...(window as unknown as { __mtEvents: number[] }).__mtEvents));
      return { target: `${sel} → ${label}`, latency: Math.round(latency) };
    }
    return null;
  } finally {
    await page.close();
  }
}

const SEV: Record<Rating, Severity | null> = { good: null, "needs-improvement": "medium", poor: "high" };
const LABEL: Record<PerfMetricName, string> = { lcp: "Largest Contentful Paint", cls: "Cumulative Layout Shift", tbt: "Total Blocking Time", fcp: "First Contentful Paint", ttfb: "Time to first byte", interaction: "Lab interaction latency" };
const fmt = (m: PerfMetricName, v: number) => (m === "cls" ? v.toFixed(3) : `${(v / 1000).toFixed(2)} s`);

/** Turn measured metrics into findings against the CWV thresholds and the weight budgets. */
export function perfFindings(m: PerfMetrics, budgets: PerfBudgets = DEFAULT_BUDGETS, throttle: Throttle = "none"): FindingInput[] {
  const out: FindingInput[] = [];
  const lab = { lab: true, engine: m.engine, throttle, note: "Lab measurement from a single load; field data (CrUX) may differ." };

  if (m.score !== null && m.score < 90)
    out.push({
      category: "performance",
      rule: m.score < 50 ? "perf.lighthouse-score-poor" : "perf.lighthouse-score-needs-improvement",
      severity: m.score < 50 ? "high" : "low",
      title: `Lighthouse performance score ${m.score}`,
      url: m.url,
      detail: m.insights.length ? `Top issues: ${m.insights.slice(0, 3).map((i) => i.title + (i.displayValue ? ` (${i.displayValue})` : "")).join("; ")}` : undefined,
      evidence: { score: m.score, insights: m.insights, ...lab },
    });

  for (const metric of ["lcp", "cls", "tbt", "fcp", "ttfb"] as const) {
    const v = m[metric];
    if (v === null) continue;
    const rating = rate(metric, v);
    const severity = SEV[rating];
    if (!severity) continue;
    // FCP and TTFB are diagnostics, not Core Web Vitals: keep them a notch lower.
    const sev: Severity = metric === "fcp" || metric === "ttfb" ? (severity === "high" ? "medium" : "low") : severity;
    const t = PERF_THRESHOLDS[metric];
    out.push({
      category: "performance",
      rule: `perf.${metric}-${rating}`,
      severity: sev,
      title: `${LABEL[metric]} ${rating === "poor" ? "poor" : "needs improvement"}: ${fmt(metric, v)}`,
      url: m.url,
      detail: `Good is ≤ ${fmt(metric, t.good)}, poor is > ${fmt(metric, t.poor)}.${metric === "lcp" && m.lcpElement ? ` LCP element: ${m.lcpElement}` : ""}${metric === "lcp" && m.observedLcp ? ` Observed without throttling: ${fmt("lcp", m.observedLcp)} (the simulated mobile figure assumes a slow 4G phone; ${m.requests} requests and ${mb(m.transferBytes)} drive it).` : ""}${metric === "tbt" ? " TBT is the lab proxy for INP." : ""}`,
      evidence: { metric, value: v, rating, thresholds: t, ...lab, ...(metric === "lcp" ? { lcpElement: m.lcpElement, observedLcp: m.observedLcp } : {}) },
    });
  }

  if (m.interaction) {
    const r = rate("interaction", m.interaction.latency);
    if (r !== "good")
      out.push({
        category: "performance",
        rule: `perf.interaction-${r}`,
        severity: r === "poor" ? "medium" : "low",
        title: `Slow response to a click: ${m.interaction.latency} ms`,
        url: m.url,
        selector: m.interaction.target.split(" → ")[0],
        detail: `Scripted lab interaction on ${m.interaction.target}. Uses INP thresholds (good ≤ 200 ms, poor > 500 ms) but is not real-user INP.`,
        evidence: { ...m.interaction, rating: r, ...lab },
      });
  }

  if (m.transferBytes > budgets.pageBytes)
    out.push({ category: "performance", rule: "perf.page-weight", severity: "medium", title: `Page weight ${mb(m.transferBytes)} over ${mb(budgets.pageBytes)} budget`, url: m.url, evidence: { bytes: m.transferBytes, budget: budgets.pageBytes, ...lab } });
  if (m.jsBytes > budgets.jsBytes)
    out.push({ category: "performance", rule: "perf.js-weight", severity: "medium", title: `JavaScript ${mb(m.jsBytes)} over ${mb(budgets.jsBytes)} budget`, url: m.url, evidence: { bytes: m.jsBytes, budget: budgets.jsBytes, ...lab } });
  if (m.requests > budgets.requests)
    out.push({ category: "performance", rule: "perf.request-count", severity: "low", title: `${m.requests} requests on load (budget ${budgets.requests})`, url: m.url, evidence: { requests: m.requests, budget: budgets.requests, ...lab } });
  for (const img of m.heavyImages.filter((i) => i.bytes > budgets.imageBytes).slice(0, 10))
    out.push({ category: "performance", rule: "perf.heavy-image", severity: "low", title: `Image ${kb(img.bytes)} over ${kb(budgets.imageBytes)} budget`, url: m.url, selector: img.url, evidence: { image: img.url, bytes: img.bytes, budget: budgets.imageBytes } });
  if (m.renderBlocking.length > 3)
    out.push({ category: "performance", rule: "perf.render-blocking", severity: "low", title: `${m.renderBlocking.length} render-blocking resources in <head>`, url: m.url, evidence: { resources: m.renderBlocking.slice(0, 30) } });
  return out;
}

const mb = (b: number) => `${(b / 1_000_000).toFixed(1)} MB`;
const kb = (b: number) => `${Math.round(b / 1000)} KB`;
