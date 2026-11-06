import type { ReportPerf } from "./model";

/** A check_results row as stored by the worker (category "performance"). */
export interface PerfRow {
  url: string;
  metric: string;
  value: unknown;
}

/**
 * Rebuild per-page performance from check_results rows: one row per metric per URL
 * (lcp, cls, tbt, fcp, ttfb, lighthouse-score, interaction, weight).
 */
export function perfFromCheckResults(rows: PerfRow[]): ReportPerf[] {
  const byUrl = new Map<string, ReportPerf>();
  for (const r of rows) {
    const v = (r.value ?? {}) as Record<string, unknown>;
    const p = byUrl.get(r.url) ?? { url: r.url, template: "unknown", score: null, lcp: null, cls: null, tbt: null, fcp: null, ttfb: null, interaction: null };
    if (typeof v.template === "string") p.template = v.template;
    if (v.engine === "lighthouse" || v.engine === "browser") p.engine = v.engine;
    const n = typeof v.value === "number" ? v.value : null;
    switch (r.metric) {
      case "lcp":
      case "cls":
      case "tbt":
      case "fcp":
      case "ttfb":
        p[r.metric] = n;
        break;
      case "lighthouse-score":
        p.score = n;
        p.engine = "lighthouse";
        if (Array.isArray(v.insights)) p.insights = v.insights as ReportPerf["insights"];
        break;
      case "interaction":
        if (n !== null) p.interaction = { latency: n, target: String(v.target ?? "") };
        break;
      case "weight":
        if (typeof v.transferBytes === "number") p.transferBytes = v.transferBytes;
        break;
    }
    byUrl.set(r.url, p);
  }
  return [...byUrl.values()];
}
