import type { CheckCategory } from "@mattertest/core";
import type { SiteCheckResult } from "@mattertest/checks";
import type { ReportInput } from "@mattertest/report";

/** Categories the engine actually runs today; visual and reporting are not checks yet. */
export const RUNNABLE: CheckCategory[] = ["crawl", "links", "seo", "performance", "accessibility", "security", "platform"];

export interface CliReportMeta {
  baseUrl: string;
  categories: CheckCategory[];
  finishedAt: string;
  perfThrottle?: "mobile" | "desktop" | "none";
}

/** Report input from a CLI site-check result (no database: client and project names come from flags). */
export function reportInputFromResult(result: SiteCheckResult, meta: CliReportMeta, names: { client?: string; project?: string } = {}): ReportInput {
  const host = new URL(meta.baseUrl).host.replace(/^www\./, "");
  return {
    client: { name: names.client ?? host },
    project: { name: names.project ?? host },
    environment: { baseUrl: meta.baseUrl },
    run: { finishedAt: new Date(meta.finishedAt) },
    platform: result.platform,
    pagesChecked: result.pages.length,
    templates: result.templates,
    categoriesRun: meta.categories.filter((c) => RUNNABLE.includes(c)),
    perf: result.perf,
    perfProfile: meta.perfThrottle,
    findings: result.findings,
  };
}
