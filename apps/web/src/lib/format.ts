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

export const RUN_STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };

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
