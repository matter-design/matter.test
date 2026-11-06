import { describe, expect, it } from "vitest";
import { categoryScore, healthScore, type HealthFinding } from "../src/lib/health";

const many = (n: number, f: HealthFinding) => Array.from({ length: n }, () => f);

describe("health score", () => {
  it("is 100 with nothing open, and ignores info findings", () => {
    expect(categoryScore([])).toBe(100);
    expect(categoryScore([{ category: "links", rule: "links.link-rate-limited", severity: "info" }])).toBe(100);
  });

  it("charges each distinct issue once, more when it is widespread", () => {
    const one = categoryScore([{ category: "accessibility", rule: "axe.color-contrast", severity: "high" }]);
    const wide = categoryScore(many(99, { category: "accessibility", rule: "axe.color-contrast", severity: "high" }));
    expect(one).toBe(88);
    expect(wide).toBe(82); // capped at 1.5x, not 99x
  });

  it("uses the worst severity seen for a rule and never goes below 0", () => {
    expect(categoryScore([
      { category: "seo", rule: "seo.x", severity: "low" },
      { category: "seo", rule: "seo.x", severity: "critical" },
    ])).toBe(74);
    expect(categoryScore(Array.from({ length: 10 }, (_, i) => ({ category: "seo" as const, rule: `r${i}`, severity: "critical" as const })))).toBe(0);
  });

  it("uses the median Lighthouse score for performance and skips categories that were not checked", () => {
    const h = healthScore(
      [{ category: "performance", rule: "perf.lcp-poor", severity: "high" }, { category: "seo", rule: "seo.h1-multiple", severity: "low" }],
      ["performance", "seo", "crawl"],
      [34, 38, 36],
    );
    expect(h.categories).toEqual([
      { category: "performance", score: 36, issues: 1, findings: 1, source: "lighthouse" },
      { category: "seo", score: 99, issues: 1, findings: 1, source: "findings" },
    ]);
    // weights: performance 20, seo 15 -> (36*20 + 99*15) / 35
    expect(h.overall).toBe(63);
  });

  it("has no overall score when no scored category was checked", () => {
    expect(healthScore([], ["crawl"]).overall).toBeNull();
  });
});
