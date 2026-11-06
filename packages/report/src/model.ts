import { CHECK_CATEGORIES, SEVERITIES, type CheckCategory, type FindingInput, type Platform, type Severity } from "@mattertest/core";
import { ruleCopy } from "./copy";
import type { ReportVisual } from "./visual";

/** Performance numbers for one page. Structurally compatible with @mattertest/checks PerfMetrics. */
export interface ReportPerf {
  url: string;
  template: string;
  engine?: "lighthouse" | "browser";
  score: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  fcp?: number | null;
  ttfb?: number | null;
  transferBytes?: number;
  lcpElement?: string | null;
  insights?: { id: string; title: string; displayValue?: string }[];
  interaction?: { target: string; latency: number } | null;
}

export type ReportFinding = FindingInput & {
  /** First seen in this run (needs a previous run to mean anything). */
  isNew?: boolean;
};

export interface ReportInput {
  client: { name: string; branding?: { logoUrl?: string; primary?: string; accent?: string } | null };
  project: { name: string };
  environment: { name?: string; baseUrl: string };
  run: { id?: string; finishedAt: Date };
  platform: Platform;
  pagesChecked: number;
  templates: Record<string, number>;
  categoriesRun: CheckCategory[];
  perf: ReportPerf[];
  /** Visual + cross-browser captures, when the visual category ran. */
  visual?: ReportVisual | null;
  findings: ReportFinding[];
  /** Open findings from earlier runs not seen this time. */
  possiblyFixed?: number;
  /** "lab" note and throttle profile used for performance. */
  perfProfile?: "mobile" | "desktop" | "none";
  preparedBy?: string;
}

export interface IssueGroup {
  rule: string;
  category: CheckCategory;
  severity: Severity;
  label: string;
  why: string;
  fix: string;
  wcag?: string;
  count: number;
  pages: number;
  newCount: number;
  examples: { url: string; selector?: string; detail?: string }[];
}

export interface ReportModel {
  input: ReportInput;
  bySeverity: Record<Severity, number>;
  byCategory: { category: CheckCategory; counts: Record<Severity, number>; total: number }[];
  groups: IssueGroup[];
  priorities: IssueGroup[];
  wcag: { criterion: string; groups: IssueGroup[]; count: number }[];
  perfByTemplate: (ReportPerf & { pageLabel: string })[];
  headline: string;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const zero = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** Strip the per-URL bits from titles so one rule groups under one label. */
function genericTitle(t: string): string {
  return t.replace(/https?:\/\/\S+/g, "").replace(/:\s*$/, "").replace(/\s{2,}/g, " ").trim();
}

export function groupFindings(findings: ReportFinding[]): IssueGroup[] {
  const map = new Map<string, ReportFinding[]>();
  for (const f of findings) map.set(f.rule, [...(map.get(f.rule) ?? []), f]);
  const groups: IssueGroup[] = [];
  for (const [rule, list] of map) {
    const first = list[0]!;
    const severity = list.reduce<Severity>((s, f) => (SEV_RANK[f.severity] < SEV_RANK[s] ? f.severity : s), "info");
    const copy = ruleCopy(rule, genericTitle(first.title), first.detail);
    groups.push({
      rule,
      category: first.category,
      severity,
      label: copy.label,
      why: copy.why,
      fix: copy.fix,
      wcag: first.wcag,
      count: list.length,
      pages: new Set(list.map((f) => f.url)).size,
      newCount: list.filter((f) => f.isNew).length,
      examples: [...list].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]).map((f) => ({ url: f.url, selector: f.selector, detail: f.rule.startsWith("perf.") || f.rule.startsWith("links.") ? f.title : undefined })),
    });
  }
  return groups.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.pages - a.pages || b.count - a.count);
}

/** Shorter path label for tables: "/" or "/tents/trail-tent". */
export function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).slice(0, 70) || "/";
  } catch {
    return url;
  }
}

export function buildReport(input: ReportInput): ReportModel {
  const findings = input.findings;
  const bySeverity = zero();
  for (const f of findings) bySeverity[f.severity]++;

  const byCategory = CHECK_CATEGORIES.filter((c) => input.categoriesRun.includes(c) || findings.some((f) => f.category === c))
    .map((category) => {
      const counts = zero();
      for (const f of findings) if (f.category === category) counts[f.severity]++;
      return { category, counts, total: SEVERITIES.reduce((a, s) => a + counts[s], 0) };
    });

  const groups = groupFindings(findings);
  const priorities = groups.filter((g) => g.severity === "critical" || g.severity === "high").slice(0, 10);

  const wcagMap = new Map<string, IssueGroup[]>();
  for (const g of groups.filter((x) => x.category === "accessibility")) {
    const k = g.wcag ?? "Best practice";
    wcagMap.set(k, [...(wcagMap.get(k) ?? []), g]);
  }
  const wcag = [...wcagMap.entries()]
    .map(([criterion, gs]) => ({ criterion, groups: gs, count: gs.reduce((a, g) => a + g.count, 0) }))
    .sort((a, b) => a.criterion.localeCompare(b.criterion, "en", { numeric: true }));

  const order = ["home", "plp", "pdp", "search", "cart", "blog", "landing"];
  const perfByTemplate = [...input.perf]
    .sort((a, b) => (order.indexOf(a.template) + 1 || 99) - (order.indexOf(b.template) + 1 || 99) || a.template.localeCompare(b.template))
    .map((p) => ({ ...p, pageLabel: pageLabel(p.url) }));

  return { input, bySeverity, byCategory, groups, priorities, wcag, perfByTemplate, headline: headline(bySeverity, input.pagesChecked) };
}

function headline(s: Record<Severity, number>, pages: number): string {
  const urgent = s.critical + s.high;
  const pagesTxt = `${pages} page${pages === 1 ? "" : "s"}`;
  if (s.critical) return `${s.critical} critical and ${s.high} high-priority issue${urgent === 1 ? "" : "s"} across ${pagesTxt} need attention first.`;
  if (s.high) return `No critical issues. ${s.high} high-priority issue${s.high === 1 ? "" : "s"} across ${pagesTxt} should be fixed next.`;
  if (s.medium + s.low) return `No critical or high-priority issues across ${pagesTxt}. The remaining items are improvements.`;
  return `No issues found across ${pagesTxt}.`;
}

/** Template names as a client would say them. */
export const TEMPLATE_LABEL: Record<string, string> = {
  home: "Home page",
  plp: "Category page",
  pdp: "Product page",
  search: "Search results",
  cart: "Cart",
  checkout: "Checkout",
  account: "Account",
  blog: "Blog",
  landing: "Content page",
  compare: "Compare",
  "not-found": "Not found page",
};
export const templateLabel = (t: string) => TEMPLATE_LABEL[t] ?? t.replace(/^depth-(\d+)$/, "Page (level $1)");
