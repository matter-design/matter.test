import * as cheerio from "cheerio";
import type { FindingInput } from "@mattertest/core";

export interface SeoPageFacts {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  h1Count: number;
  hasOg: boolean;
  jsonLdErrors: string[];
}

export function extractSeoFacts(url: string, html: string): SeoPageFacts {
  const $ = cheerio.load(html);
  const jsonLdErrors: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      JSON.parse(raw);
    } catch (e) {
      jsonLdErrors.push((e as Error).message);
    }
  });
  return {
    url,
    title: $("head > title").first().text().trim() || undefined,
    description: $('meta[name="description"]').attr("content")?.trim() || undefined,
    canonical: $('link[rel="canonical"]').attr("href")?.trim() || undefined,
    robots: $('meta[name="robots"]').attr("content")?.toLowerCase() || undefined,
    h1Count: $("h1").length,
    hasOg: $('meta[property="og:title"]').length > 0,
    jsonLdErrors,
  };
}

/** Per-page SEO rules. Cross-page rules (duplicates) live in seoSiteFindings. */
export function seoPageFindings(f: SeoPageFacts): FindingInput[] {
  const out: FindingInput[] = [];
  const add = (rule: string, severity: FindingInput["severity"], title: string, detail?: string) =>
    out.push({ category: "seo", rule: `seo.${rule}`, severity, title, url: f.url, detail });

  if (!f.title) add("title-missing", "high", "Page has no <title>");
  else if (f.title.length > 60) add("title-long", "low", "Title longer than 60 characters", f.title);
  if (!f.description) add("description-missing", "medium", "Meta description missing");
  else if (f.description.length > 160) add("description-long", "low", "Meta description longer than 160 characters");
  if (!f.canonical) add("canonical-missing", "medium", "Canonical link missing");
  if (f.robots?.includes("noindex")) add("noindex", "high", "Page is set to noindex", `meta robots: ${f.robots}`);
  if (f.h1Count === 0) add("h1-missing", "medium", "No <h1> on the page");
  if (f.h1Count > 1) add("h1-multiple", "low", `${f.h1Count} <h1> elements on the page`);
  if (!f.hasOg) add("og-missing", "low", "Open Graph tags missing");
  for (const err of f.jsonLdErrors) add("jsonld-invalid", "medium", "JSON-LD block is not valid JSON", err);
  return out;
}

export function seoSiteFindings(all: SeoPageFacts[]): FindingInput[] {
  const byTitle = new Map<string, string[]>();
  for (const f of all) {
    if (!f.title) continue;
    byTitle.set(f.title, [...(byTitle.get(f.title) ?? []), f.url]);
  }
  const out: FindingInput[] = [];
  for (const [title, urls] of byTitle) {
    if (urls.length < 2) continue;
    for (const url of urls) {
      out.push({
        category: "seo",
        rule: "seo.title-duplicate",
        severity: "medium",
        title: `Title shared by ${urls.length} pages`,
        url,
        detail: title,
        evidence: { urls },
      });
    }
  }
  return out;
}
