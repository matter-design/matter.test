import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import type { FindingInput, Severity } from "@mattertest/core";

/** WCAG 2.2 Level AA by default (A + AA rules across 2.0, 2.1 and 2.2). */
export const WCAG_22_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const IMPACT_TO_SEVERITY: Record<string, Severity> = { critical: "critical", serious: "high", moderate: "medium", minor: "low" };

/** "wcag412" -> "4.1.2" */
function wcagFromTags(tags: string[]): string | undefined {
  const t = tags.find((x) => /^wcag\d{3,4}$/.test(x));
  if (!t) return undefined;
  const d = t.slice(4);
  return d.length === 3 ? `${d[0]}.${d[1]}.${d[2]}` : `${d[0]}.${d[1]}.${d.slice(2)}`;
}

export async function axeFindings(page: Page, tags = WCAG_22_AA_TAGS): Promise<FindingInput[]> {
  const res = await new AxeBuilder({ page }).withTags(tags).analyze();
  const url = page.url();
  return res.violations.flatMap((v) =>
    v.nodes.slice(0, 20).map((n) => ({
      category: "accessibility" as const,
      rule: `axe.${v.id}`,
      severity: IMPACT_TO_SEVERITY[v.impact ?? "moderate"] ?? "medium",
      title: v.help,
      url,
      detail: n.failureSummary ?? v.description,
      wcag: wcagFromTags(v.tags),
      selector: n.target.join(" "),
      evidence: { html: n.html.slice(0, 2000), helpUrl: v.helpUrl, totalNodes: v.nodes.length },
    })),
  );
}
