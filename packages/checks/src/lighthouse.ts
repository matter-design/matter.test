import * as chromeLauncher from "chrome-launcher";
import lighthouse, { desktopConfig } from "lighthouse";
import { chromium } from "playwright";
import type { PerfMetrics, Throttle } from "./performance";

/**
 * Lighthouse lab runs, configured like PageSpeed Insights:
 *   mobile  -> Lighthouse default (Moto G Power emulation, simulated slow 4G + 4x CPU), same as PSI mobile
 *   desktop -> Lighthouse desktop config, same as PSI desktop
 *   none    -> no throttling (fast, for tests and local debugging)
 *
 * Uses Playwright's Chromium binary so there is nothing extra to install.
 * One Chrome is shared across URLs; Lighthouse runs one page at a time.
 */
export interface LighthouseRunner {
  run(url: string, throttle: Throttle): Promise<PerfMetrics>;
  close(): Promise<void>;
}

type Audit = { score: number | null; numericValue?: number; displayValue?: string; title: string; details?: unknown; scoreDisplayMode?: string };

export async function startLighthouse(opts: { chromePath?: string } = {}): Promise<LighthouseRunner> {
  const chrome = await chromeLauncher.launch({
    chromePath: opts.chromePath ?? process.env.LIGHTHOUSE_CHROME_PATH ?? chromium.executablePath(),
    // --no-sandbox matches Playwright's default; Ubuntu 24 CI runners block Chrome's user-namespace sandbox.
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    logLevel: "silent",
  });

  return {
    async run(url, throttle) {
      const flags = { port: chrome.port, output: "json" as const, logLevel: "error" as const, onlyCategories: ["performance"] };
      const config =
        throttle === "desktop"
          ? desktopConfig
          : throttle === "none"
            ? { extends: "lighthouse:default", settings: { onlyCategories: ["performance"], throttlingMethod: "provided" as const, formFactor: "desktop" as const, screenEmulation: { disabled: true } } }
            : undefined;
      const result = await lighthouse(url, flags, config);
      if (!result) throw new Error("Lighthouse returned no result");
      const lhr = result.lhr;
      if (lhr.runtimeError) throw new Error(`Lighthouse: ${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
      return toMetrics(url, lhr as unknown as { audits: Record<string, Audit>; categories: { performance?: { score: number | null } } });
    },
    async close() {
      chrome.kill();
    },
  };
}

const num = (a: Audit | undefined) => (a?.numericValue === undefined ? null : Math.round(a.numericValue));

/** First node description found anywhere in an audit's details (LCP element lives in the lcp-breakdown insight). */
function findNode(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (d.type === "node") return (d.selector as string) || (d.snippet as string) || (d.nodeLabel as string) || null;
  for (const v of Object.values(d)) {
    const found = Array.isArray(v) ? v.map(findNode).find(Boolean) : findNode(v);
    if (found) return found;
  }
  return null;
}

function tableItems(a: Audit | undefined): Record<string, unknown>[] {
  const d = a?.details as { items?: unknown[] } | undefined;
  return Array.isArray(d?.items) ? (d!.items as Record<string, unknown>[]) : [];
}

/** Map a Lighthouse result onto the same metric shape the browser fallback produces. */
export function toMetrics(url: string, lhr: { audits: Record<string, Audit>; categories: { performance?: { score: number | null } } }): PerfMetrics {
  const a = lhr.audits;
  const requests = tableItems(a["network-requests"]);
  const summary = tableItems(a["resource-summary"]);
  const bytesOf = (type: string) => Number(summary.find((i) => i.resourceType === type)?.transferSize ?? 0);
  const score = lhr.categories.performance?.score;

  // Failing insights and diagnostics, worst first: these are the "what to fix" list in the report.
  const insights = Object.entries(a)
    .filter(([id, x]) => (id.endsWith("-insight") || x.details && (x.details as { type?: string }).type === "opportunity") && x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== "informative" && x.scoreDisplayMode !== "notApplicable")
    .sort(([, x], [, y]) => (x.score ?? 1) - (y.score ?? 1))
    .slice(0, 10)
    .map(([id, x]) => ({ id, title: x.title, displayValue: x.displayValue }));

  return {
    url,
    engine: "lighthouse",
    score: score === null || score === undefined ? null : Math.round(score * 100),
    ttfb: num(a["server-response-time"]),
    fcp: num(a["first-contentful-paint"]),
    lcp: num(a["largest-contentful-paint"]),
    lcpElement: findNode(a["lcp-breakdown-insight"]?.details) ?? findNode(a["largest-contentful-paint-element"]?.details),
    cls: Math.round((a["cumulative-layout-shift"]?.numericValue ?? 0) * 1000) / 1000,
    tbt: num(a["total-blocking-time"]) ?? 0,
    load: num(a["interactive"]),
    requests: requests.length,
    transferBytes: num(a["total-byte-weight"]) ?? bytesOf("total"),
    jsBytes: bytesOf("script"),
    imageBytes: bytesOf("image"),
    renderBlocking: tableItems(a["render-blocking-insight"]).map((i) => String(i.url ?? "")).filter(Boolean),
    heavyImages: requests.filter((r) => r.resourceType === "Image").map((r) => ({ url: String(r.url), bytes: Number(r.transferSize ?? 0) })),
    insights,
    interaction: null,
  };
}
