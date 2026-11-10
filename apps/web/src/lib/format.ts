import type { CheckCategory, Platform, Severity } from "@mattertest/core";

export const PLATFORM_LABEL: Record<Platform, string> = {
  bigcommerce: "BigCommerce",
  shopify: "Shopify",
  wordpress: "WordPress",
  laravel: "Laravel",
  nextjs: "Next.js",
  custom: "Custom",
};

export const CATEGORY_LABEL: Record<CheckCategory, string> = {
  crawl: "Crawling and discovery",
  links: "Links and images",
  seo: "SEO",
  performance: "Performance",
  accessibility: "Accessibility (WCAG 2.2 AA)",
  security: "Security hygiene",
  visual: "Visual and browsers",
  reporting: "Reporting",
  platform: "Platform pack",
} as Record<CheckCategory, string>;

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

export const STATE_LABEL: Record<string, string> = {
  new: "New",
  open: "Open",
  fixed: "Fixed",
  ignored: "False positive",
  "accepted-risk": "Accepted risk",
};

export const RUN_STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled", "needs-review": "Needs input" };

export const TRIGGER_LABEL: Record<string, string> = { manual: "Manual", schedule: "Schedule", webhook: "Webhook", deploy: "Deploy", supervisor: "Agent" };

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 hours ago", "just now". */
export function timeAgo(date: Date, now = new Date()): string {
  const secs = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en-AU", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return rtf.format(Math.trunc(secs / size), unit);
  }
  return "just now";
}

export function dateTime(date: Date): string {
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "6 m 41 s", "48 s". */
export function duration(from: Date | null, to: Date | null): string | null {
  if (!from || !to) return null;
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 1) return null; // imported runs have no real start time
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} m ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} m`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-AU")} ${n === 1 ? one : many}`;

/** US dollars: "$2.31", or whole dollars with digits=0. Sub-cent amounts show as "<$0.01". */
export function usd(n: number, digits = 2): string {
  if (n > 0 && n < 0.01 && digits > 0) return "<$0.01";
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const REVIEW_LABEL: Record<string, string> = { "needs-review": "Needs review", approved: "Approved", rejected: "Rejected", superseded: "Superseded", draft: "Draft", mixed: "Partly approved" };

export const SOURCE_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  ingesting: "Reading",
  ready: "Ingested",
  "needs-transcript": "Needs a transcript",
  failed: "Failed",
  superseded: "Older version",
};

export const SOURCE_TYPE_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word", md: "Markdown", transcript: "Transcript", loom: "Loom video", confluence: "Confluence page" };

export const KIND_LABEL: Record<string, string> = { happy: "Positive", negative: "Negative", edge: "Edge" };

/** 125 → "02:05" (video timestamps). */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
