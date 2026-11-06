import * as cheerio from "cheerio";
import type { FindingInput } from "@mattertest/core";
import type { PackContext, PackPage, PlatformPack } from "./types";
import { hasProductSchema, hostOf, robotsDisallows, robotsMeta, tempDomainFindings } from "./util";

/**
 * Shopify pack.
 *
 * Launch and catalogue mistakes we see on Shopify builds: storefront password left on,
 * canonicals and links pointing at *.myshopify.com, theme placeholder content, product pages that
 * cannot be bought or show $0, missing Product schema, internal links to collection-scoped product
 * URLs, indexable filter/cart URLs, edited robots.txt, and app scripts injected on every page.
 */

/** Shopify page type -> MatterTest template. */
const PAGE_TYPE_TO_TEMPLATE: Record<string, string> = {
  index: "home",
  home: "home",
  product: "pdp",
  collection: "plp",
  "list-collections": "plp",
  collections: "plp",
  search: "search",
  searchresults: "search",
  cart: "cart",
  page: "landing",
  blog: "blog",
  article: "blog",
  password: "password",
  "404": "not-found",
  gift_card: "landing",
};

/**
 * Page type from the markup. Most themes put `template-<name>` on <body> (Dawn and older themes alike);
 * Shopify's own analytics snippet carries "pageType" on every storefront page as a fallback.
 */
export function shopifyPageType(html: string): string | undefined {
  const body = /<body[^>]*class=["'][^"']*\btemplate-([a-z0-9_-]+)/i.exec(html)?.[1];
  if (body) return body.toLowerCase();
  return /["']pageType["']\s*:\s*["']([a-z0-9_-]+)["']/i.exec(html)?.[1]?.toLowerCase();
}

export function shopifyTemplate(html: string): string | undefined {
  const t = shopifyPageType(html);
  if (!t) return undefined;
  if (t.startsWith("customers")) return "account";
  if (PAGE_TYPE_TO_TEMPLATE[t]) return PAGE_TYPE_TO_TEMPLATE[t];
  // Alternate templates (page.contact, product.bundle) show up as page-contact, product-bundle: group under the base type.
  const base = t.split(/[.-]/)[0]!;
  return PAGE_TYPE_TO_TEMPLATE[base] ?? t;
}

const STORE_DOMAIN = /(^|\.)myshopify\.com$/i;
/** First-party hosts that are not "apps". */
const SHOPIFY_HOSTS = /(^|\.)(shopify\.com|shopifycdn\.(com|net)|shopifysvc\.com|shopifycloud\.com|shop\.app|myshopify\.com)$/i;
/** Text left over from Shopify themes' default sections. */
const PLACEHOLDER = /Example product title|Talk about your brand|Use this text to share information about your brand|Pair text with an image to focus on your chosen product|Share information about your brand with your customers|Your content goes here/i;
const SOLD_OUT = /sold out|out of stock|unavailable/i;
const ADD_TO_CART = "form[action*='/cart/add'], button[name='add'], [data-add-to-cart], product-form";

function pageFindings(p: PackPage, ctx: PackContext): FindingInput[] {
  if (!p.html || (p.status ?? 0) >= 400) return [];
  const $ = cheerio.load(p.html);
  const out: FindingInput[] = [];
  const add = (f: Omit<FindingInput, "category" | "url">) => out.push({ category: "platform", url: p.url, ...f });
  const siteHost = new URL(ctx.baseUrl).host;
  const path = new URL(p.url).pathname;

  // Storefront password page: the whole store is closed to shoppers and search engines.
  if (p.template === "password" || path === "/password" || $("form[action$='/password'] input[type='password']").length)
    add({ rule: "shopify.password-protected", severity: p.template === "home" || path === "/" || path === "/password" ? "critical" : "high", title: "Storefront is password protected", detail: "Shoppers and search engines see the password page. Remove the password under Online Store › Preferences when ready to launch." });

  out.push(...tempDomainFindings($, p.url, siteHost, { domain: STORE_DOMAIN, domainLabel: "*.myshopify.com", canonicalRule: "shopify.store-domain-canonical", linksRule: "shopify.store-domain-links", canonicalFix: "Set the custom domain as primary in Shopify (Settings › Domains)" }));

  const bodyText = $("body").text().replace(/\s+/g, " ");
  const placeholder = PLACEHOLDER.exec(bodyText)?.[0];
  if (placeholder)
    add({ rule: "shopify.placeholder-content", severity: "high", title: "Theme placeholder text is visible", detail: `Default section text "${placeholder}" is still on the page. Replace or remove the section in the theme editor.`, evidence: { text: placeholder } });

  if (p.template === "pdp") {
    const soldOut = SOLD_OUT.test($("form[action*='/cart/add'], .product-form, .product__info-container, .product-single__meta").text()) || $("button[name='add'][disabled]").length > 0;
    if (!$(ADD_TO_CART).length && !soldOut)
      add({ rule: "shopify.pdp-no-add-to-cart", severity: "high", title: "Product page has no add-to-cart form", detail: "No /cart/add form and no sold-out message. Check the product template, or whether the product is only available on another sales channel." });

    // Shopify themes publish the price in og:price:amount; JSON-LD offers as a fallback.
    const og = $('meta[property="og:price:amount"]').attr("content");
    if (og !== undefined && Number(og.replace(/,/g, "")) === 0)
      add({ rule: "shopify.pdp-zero-price", severity: "high", title: "Product is priced at 0", detail: "og:price:amount is 0. Shoppers see a free product, or the price is missing.", selector: 'meta[property="og:price:amount"]', evidence: { amount: og, currency: $('meta[property="og:price:currency"]').attr("content") } });

    if (!hasProductSchema($))
      add({ rule: "shopify.pdp-schema-missing", severity: "medium", title: "Product page has no Product structured data", detail: "No JSON-LD or microdata of type Product. Most Shopify themes include it; a theme edit or app likely removed it." });
  }

  // Collection-scoped product URLs (/collections/x/products/y) are duplicates of /products/y.
  // Shopify canonicalises them by default; a theme that changes the canonical turns them into real duplicates.
  if (/^\/collections\/[^/]+\/products\//.test(path)) {
    const canonical = $('link[rel="canonical"]').attr("href");
    const canonPath = canonical ? new URL(canonical, p.url).pathname : "";
    if (!canonPath.startsWith("/products/"))
      add({ rule: "shopify.collection-product-not-canonical", severity: "medium", title: "Collection product URL is not canonicalised to /products/", detail: "This page duplicates the product's own URL. Restore the theme's default canonical tag.", evidence: { canonical } });
  }

  // Filtered, sorted and tagged collection pages: duplicate content when indexable.
  const u = new URL(p.url);
  const filterParams = [...u.searchParams.keys()].some((k) => k.startsWith("filter.") || k === "sort_by" || k === "q");
  const tagPath = /^\/collections\/[^/]+\/[^/]+$/.test(path) && !path.includes("/products/"); // /collections/tents/blue
  const filtered = filterParams || tagPath;
  if (["plp", "search"].includes(p.template) && filtered) {
    const canonical = $('link[rel="canonical"]').attr("href");
    // Clean = canonical has no query string and, for tag paths, points away from the tag URL itself.
    const c = canonical ? new URL(canonical, p.url) : undefined;
    const canonicalClean = !!c && !c.search && !(tagPath && c.pathname === path);
    if (!robotsMeta($).includes("noindex") && !canonicalClean)
      add({ rule: "shopify.filter-url-indexable", severity: "low", title: "Filtered or tagged collection URL is indexable", detail: "No noindex and the canonical points at itself. Shopify's default robots.txt blocks these; check it was not edited.", evidence: { canonical } });
  }
  return out;
}

/** Paths Shopify's default robots.txt disallows. */
const DEFAULT_DISALLOWS = ["/admin", "/cart", "/checkout", "/account"];
const TRANSACTIONAL = /^\/(cart|checkout|account|orders)(\/|$)/i;

/** Third-party script hosts on a page: <script src> outside Shopify and the store itself. */
function appScripts(html: string, pageUrl: string, siteHost: string): { hosts: Set<string>; scriptTags: Set<string> } {
  const $ = cheerio.load(html);
  const hosts = new Set<string>();
  const scriptTags = new Set<string>();
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src")!;
    const h = hostOf(src, pageUrl);
    if (!h || h === siteHost || SHOPIFY_HOSTS.test(h)) return;
    hosts.add(h);
    // Legacy ScriptTag apps load with ?shop=<store>.myshopify.com on every page, whether needed or not.
    if (/[?&]shop=[^&]+\.myshopify\.com/i.test(src)) scriptTags.add(h);
  });
  // Shopify's loader injects ScriptTag URLs into an inline `var urls = [...]` list instead of <script src>.
  for (const m of html.matchAll(/["'](https?:\\?\/\\?\/[^"']+[?&]shop=[^"'&]+\.myshopify\.com[^"']*)["']/gi)) {
    const h = hostOf(m[1]!.replace(/\\\//g, "/"), pageUrl);
    if (h && !SHOPIFY_HOSTS.test(h)) {
      hosts.add(h);
      scriptTags.add(h);
    }
  }
  return { hosts, scriptTags };
}

function siteFindings(pages: PackPage[], ctx: PackContext): FindingInput[] {
  const out: FindingInput[] = [];
  const robotsUrl = new URL("/robots.txt", ctx.baseUrl).toString();
  const siteHost = new URL(ctx.baseUrl).host;

  if (ctx.robotsTxt === null)
    out.push({ category: "platform", rule: "shopify.robots-missing", severity: "medium", title: "robots.txt missing", detail: "Shopify always serves one; a missing robots.txt usually means a proxy or CDN rule is intercepting it.", url: robotsUrl });
  else {
    const missing = DEFAULT_DISALLOWS.filter((path) => !robotsDisallows(ctx.robotsTxt!, path));
    if (missing.length)
      out.push({ category: "platform", rule: "shopify.robots-defaults-removed", severity: "medium", title: `robots.txt no longer disallows ${missing.join(", ")}`, detail: "Shopify's default rules have been removed, probably by a robots.txt.liquid edit. Restore them with {{ group.rules }} in the template.", url: robotsUrl, evidence: { missing } });
    if (!/^\s*sitemap\s*:/im.test(ctx.robotsTxt))
      out.push({ category: "platform", rule: "shopify.robots-no-sitemap", severity: "low", title: "robots.txt does not list a sitemap", detail: "Shopify's default lists /sitemap.xml. Add it back so crawlers find the catalogue.", url: robotsUrl });
  }

  for (const p of pages) {
    const path = new URL(p.url).pathname;
    if (!TRANSACTIONAL.test(path) || !p.html || (p.status ?? 0) >= 400) continue;
    if (!robotsMeta(cheerio.load(p.html)).includes("noindex"))
      out.push({ category: "platform", rule: "shopify.transactional-indexable", severity: "low", title: `${path} is crawlable and indexable`, detail: "Cart, checkout and account pages should be blocked by robots.txt or carry noindex.", url: p.url });
  }

  // Internal links to collection-scoped product URLs: counted across the site, reported once.
  const scoped = new Set<string>();
  for (const p of pages) {
    if (!p.html) continue;
    for (const m of p.html.matchAll(/href=["']([^"']*\/collections\/[^/"']+\/products\/[^"'?#]+)/gi)) scoped.add(new URL(m[1]!, p.url).pathname);
  }
  if (scoped.size >= 5)
    out.push({ category: "platform", rule: "shopify.collection-product-links", severity: "low", title: `${scoped.size} internal links use collection-scoped product URLs`, detail: "Links like /collections/x/products/y spread crawling across duplicate URLs. Link to /products/y instead (remove `within: collection` from product card links in the theme).", url: ctx.baseUrl, evidence: { examples: [...scoped].slice(0, 20) } });

  // App scripts on the home page (every app script on the home page usually loads on every page).
  const home = pages.find((p) => p.template === "home" && p.html) ?? pages.find((p) => p.html);
  if (home) {
    const { hosts, scriptTags } = appScripts(home.html, home.url, siteHost);
    if (hosts.size > 12)
      out.push({ category: "platform", rule: "shopify.many-app-scripts", severity: "medium", title: `${hosts.size} third-party script hosts on the home page`, detail: "Each app script adds download and JavaScript work to every page. Remove apps you no longer use; uninstalled apps can leave code in the theme.", url: home.url, evidence: { hosts: [...hosts].sort() } });
    if (scriptTags.size)
      out.push({ category: "platform", rule: "shopify.legacy-scripttag-apps", severity: "low", title: `${scriptTags.size} app${scriptTags.size > 1 ? "s" : ""} injected with legacy ScriptTags`, detail: "ScriptTag apps load on every page whether needed or not. Prefer apps that use theme app extensions (app embeds), which can be switched off per theme.", url: home.url, evidence: { hosts: [...scriptTags].sort() } });
  }
  return out;
}

export const shopifyPack: PlatformPack = {
  platform: "shopify",
  templateOf: shopifyTemplate,
  pageFindings,
  siteFindings,
};
