import type * as cheerio from "cheerio";
import type { FindingInput } from "@mattertest/core";

/** Shared helpers for platform packs. Everything here reads HTML the crawler already fetched. */

export function hostOf(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).host;
  } catch {
    return undefined;
  }
}

/** JSON-LD (including @graph) or microdata of type Product. */
export function hasProductSchema($: cheerio.CheerioAPI): boolean {
  if ($('[itemtype*="schema.org/Product" i]').length) return true;
  let found = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const walk = (v: unknown): boolean => {
        if (Array.isArray(v)) return v.some(walk);
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          const t = o["@type"];
          if (t === "Product" || t === "ProductGroup" || (Array.isArray(t) && (t.includes("Product") || t.includes("ProductGroup")))) return true;
          return walk(o["@graph"]);
        }
        return false;
      };
      found = walk(JSON.parse($(el).text()));
    } catch {
      /* invalid JSON-LD is reported by the SEO checks */
    }
  });
  return found;
}

export const robotsMeta = ($: cheerio.CheerioAPI) => $('meta[name="robots"]').attr("content")?.toLowerCase() ?? "";

/** Does robots.txt (any group) disallow this path prefix? Good enough for checking platform defaults are intact. */
export function robotsDisallows(robotsTxt: string, path: string): boolean {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*disallow\\s*:\\s*${esc}`, "im").test(robotsTxt);
}

/**
 * Canonicals, og:url and links pointing at the platform's temporary domain (*.mybigcommerce.com, *.myshopify.com)
 * when the site is served from its own domain.
 */
export function tempDomainFindings(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  siteHost: string,
  o: { domain: RegExp; domainLabel: string; canonicalRule: string; linksRule: string; canonicalFix: string },
): FindingInput[] {
  if (o.domain.test(siteHost)) return [];
  const out: FindingInput[] = [];
  for (const [sel, attr, label] of [['link[rel="canonical"]', "href", "Canonical"], ['meta[property="og:url"]', "content", "og:url"]] as const) {
    const v = $(sel).attr(attr);
    const h = hostOf(v, pageUrl);
    if (h && o.domain.test(h))
      out.push({ category: "platform", rule: o.canonicalRule, severity: "high", title: `${label} points at the store domain ${h}`, detail: `${o.canonicalFix} so ${label} uses ${siteHost}.`, url: pageUrl, selector: sel, evidence: { value: v } });
  }
  const links = new Set<string>();
  $("a[href], img[src], form[action]").each((_, el) => {
    const v = $(el).attr("href") ?? $(el).attr("src") ?? $(el).attr("action");
    const h = hostOf(v, pageUrl);
    if (h && o.domain.test(h)) links.add(v!);
  });
  if (links.size)
    out.push({ category: "platform", rule: o.linksRule, severity: "medium", title: `${links.size} link${links.size > 1 ? "s" : ""} to the ${o.domainLabel} store domain`, detail: "Hard-coded links to the store domain, usually from theme content or menus copied before go-live.", url: pageUrl, evidence: { links: [...links].slice(0, 20) } });
  return out;
}
