import { readFile } from "node:fs/promises";
import { artefactPath, type CheckCategory } from "@mattertest/core";
import type { SiteCheckResult } from "@mattertest/checks";
import { visualChanges, type ReportInput } from "@mattertest/report";

/** Read a stored artefact, or null if it is missing. */
export const readArtefact = (uri: string) => readFile(artefactPath(uri)).catch(() => null);

/** Categories the engine runs; "reporting" is not a check. */
export const RUNNABLE: CheckCategory[] = ["crawl", "links", "seo", "performance", "accessibility", "security", "platform", "visual"];

export interface CliReportMeta {
  baseUrl: string;
  categories: CheckCategory[];
  finishedAt: string;
  perfThrottle?: "mobile" | "desktop" | "none";
}

/** Report input from a CLI site-check result (no database: client and project names come from flags). */
export async function reportInputFromResult(result: SiteCheckResult, meta: CliReportMeta, names: { client?: string; project?: string } = {}): Promise<ReportInput> {
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
    visual: result.visual ? { ...result.visual, changes: await visualChanges(result.visual.captures, readArtefact) } : null,
    perfProfile: meta.perfThrottle,
    findings: result.findings,
  };
}
