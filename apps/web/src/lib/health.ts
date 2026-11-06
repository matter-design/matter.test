import type { CheckCategory, Severity } from "@mattertest/core";

/**
 * Health score: 0–100 per category and overall, from the open findings of the latest check.
 *
 * Each distinct issue (rule) costs points by its worst severity, so 99 pages with the same
 * contrast problem count as one issue that is widespread, not 99 issues. A widespread issue
 * costs up to 1.5× its base (reached at 21+ affected pages). Info findings cost nothing.
 *
 * Performance uses the median Lighthouse score of the measured pages when there is one,
 * because that is the number clients already know from PageSpeed Insights.
 *
 * Overall is a weighted average of the categories that were checked.
 */

export const SEVERITY_COST: Record<Severity, number> = { critical: 25, high: 12, medium: 5, low: 1.5, info: 0 };

/** How much each category counts towards the overall score. Crawl and reporting are not scored. */
export const CATEGORY_WEIGHT: Partial<Record<CheckCategory, number>> = {
  accessibility: 25,
  performance: 20,
  seo: 15,
  links: 15,
  security: 10,
  platform: 10,
  visual: 5,
};

export const SCORED_CATEGORIES = Object.keys(CATEGORY_WEIGHT) as CheckCategory[];

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export interface HealthFinding {
  category: CheckCategory;
  rule: string;
  severity: Severity;
}

export interface CategoryHealth {
  category: CheckCategory;
  score: number;
  /** Distinct issues (rules) with at least one open finding, info excluded. */
  issues: number;
  /** Open findings in this category, info excluded. */
  findings: number;
  /** Where the score came from. */
  source: "findings" | "lighthouse";
}

export interface Health {
  overall: number | null;
  categories: CategoryHealth[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Score one category's findings: 100 minus the cost of each distinct issue. */
export function categoryScore(findings: HealthFinding[]): number {
  const byRule = new Map<string, { worst: Severity; count: number }>();
  for (const f of findings) {
    if (f.severity === "info") continue;
    const cur = byRule.get(f.rule);
    if (!cur) byRule.set(f.rule, { worst: f.severity, count: 1 });
    else {
      cur.count++;
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.worst]) cur.worst = f.severity;
    }
  }
  let cost = 0;
  for (const { worst, count } of byRule.values()) {
    const spread = Math.min(1, (count - 1) / 20);
    cost += SEVERITY_COST[worst] * (1 + 0.5 * spread);
  }
  return Math.max(0, Math.round(100 - cost));
}

/**
 * @param findings open findings from the latest check
 * @param checked categories that check covered (others are left out, not scored as perfect)
 * @param lighthouseScores Lighthouse performance scores (0–100) of the measured pages
 */
export function healthScore(findings: HealthFinding[], checked: CheckCategory[], lighthouseScores: number[] = []): Health {
  const categories: CategoryHealth[] = [];
  for (const category of SCORED_CATEGORIES) {
    if (!checked.includes(category)) continue;
    const mine = findings.filter((f) => f.category === category && f.severity !== "info");
    const lh = category === "performance" ? median(lighthouseScores) : null;
    categories.push({
      category,
      score: lh !== null ? Math.round(lh) : categoryScore(mine),
      issues: new Set(mine.map((f) => f.rule)).size,
      findings: mine.length,
      source: lh !== null ? "lighthouse" : "findings",
    });
  }
  const total = categories.reduce((sum, c) => sum + CATEGORY_WEIGHT[c.category]!, 0);
  const overall = total ? Math.round(categories.reduce((sum, c) => sum + c.score * CATEGORY_WEIGHT[c.category]!, 0) / total) : null;
  return { overall, categories };
}
