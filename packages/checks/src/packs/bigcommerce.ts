import * as cheerio from "cheerio";
import type { FindingInput } from "@mattertest/core";
import type { PackContext, PackPage, PlatformPack } from "./types";
import { hasProductSchema, robotsDisallows, robotsMeta, tempDomainFindings } from "./util";

/**
 * BigCommerce (Stencil) pack.
 *
 * Catches the launch and catalogue mistakes we see on BigCommerce builds:
 * sample catalogue left live, canonicals pointing at the *.mybigcommerce.com store domain,
 * maintenance mode, product pages that cannot be bought, $0.00 prices, missing Product schema,
 * and crawlable cart/checkout/facet URLs.
 */

/** Stencil page_type (first argument to window.stencilBootstrap) -> MatterTest template. */
const PAGE_TYPE_TO_TEMPLATE: Record<string, string> = {
  default: "home",
  product: "pdp",
  category: "plp",
  brand: "plp",
  brands: "plp",
  search: "search",
  cart: "cart",
  checkout: "checkout",
  blog: "blog",
  blog_post: "blog",
  page: "landing",
  page_contact_form: "landing",
  compare: "compare",
  login: "account",
  create_account: "account",
  forgot_password: "account",
  "404": "not-found",
};

export function stencilPageType(html: string): string | undefined {
  return /stencilBootstrap\(\s*["']([a-z_0-9-]+)["']/i.exec(html)?.[1]?.toLowerCase() ?? /["']page_type["']\s*:\s*["']([a-z_0-9-]+)["']/i.exec(html)?.[1]?.toLowerCase();
}

export function bigcommerceTemplate(html: string): string | undefined {
  const t = stencilPageType(html);
  if (!t) return undefined;
  if (t.startsWith("account")) return "account";
  return PAGE_TYPE_TO_TEMPLATE[t] ?? t;
}

const STORE_DOMAIN = /(^|\.)mybigcommerce\.com$/i;
const MAINTENANCE = /down for maintenance|store is (currently )?(closed|unavailable|offline)|we['’]ll be back soon/i;
const SAMPLE = /\[Sample\]/;
const ZERO_PRICE = /^[^\d]*0+(?:[.,]0+)?[^\d]*$/;
const OUT_OF_STOCK = /out of stock|sold out|currently unavailable/i;
const PRICE_SELECTORS = "[data-product-price-without-tax], [data-product-price-with-tax], .productView-price .price--withoutTax, .productView-price .price--withTax";
const ADD_TO_CART = "form[data-cart-item-add], [data-button-type='add-cart'], #form-action-addToCart";

function pageFindings(p: PackPage, ctx: PackContext): FindingInput[] {
  if (!p.html || (p.status ?? 0) >= 400) return [];
  const $ = cheerio.load(p.html);
  const out: FindingInput[] = [];
  const add = (f: Omit<FindingInput, "category" | "url"> & { url?: string }) => out.push({ category: "platform", url: p.url, ...f });
  const siteHost = new URL(ctx.baseUrl).host;

  // Sample catalogue still live: BigCommerce's demo products are prefixed "[Sample]".
  const sampleNames = new Set<string>();
  $("h1, .card-title, .productView-title, [data-test='card-title'], title").each((_, el) => {
    const t = $(el).text().trim();
    if (SAMPLE.test(t)) sampleNames.add(t.slice(0, 120));
  });
  if (sampleNames.size)
    add({ rule: "bc.sample-products", severity: "high", title: `Sample catalogue visible (${sampleNames.size} "[Sample]" item${sampleNames.size > 1 ? "s" : ""})`, detail: "BigCommerce demo products are still live. Delete or hide them before launch.", evidence: { names: [...sampleNames].slice(0, 20) } });

  // Canonical / og:url / links pointing at the *.mybigcommerce.com store domain instead of the live domain.
  out.push(...tempDomainFindings($, p.url, siteHost, { domain: STORE_DOMAIN, domainLabel: "*.mybigcommerce.com", canonicalRule: "bc.store-domain-canonical", linksRule: "bc.store-domain-links", canonicalFix: "Set the primary domain in BigCommerce" }));

  // Maintenance / closed store page.
  const bodyText = $("body").text().replace(/\s+/g, " ");
  if (MAINTENANCE.test(bodyText) && bodyText.length < 5000)
    add({ rule: "bc.maintenance-mode", severity: p.template === "home" ? "critical" : "high", title: "Store appears to be in maintenance mode", detail: MAINTENANCE.exec(bodyText)?.[0] });

  if (p.template === "pdp") {
    const outOfStock = OUT_OF_STOCK.test(bodyText) || $("[data-product-stock] .alertBox, .alertBox--error").length > 0;
    if (!$(ADD_TO_CART).length && !outOfStock)
      add({ rule: "bc.pdp-no-add-to-cart", severity: "high", title: "Product page has no add-to-cart form", detail: "No [data-cart-item-add] form and no out-of-stock message. The product may be unpurchasable (purchasability set to 'call for pricing' or theme change)." });

    const prices = $(PRICE_SELECTORS)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (prices.length && prices.every((t) => ZERO_PRICE.test(t)))
      add({ rule: "bc.pdp-zero-price", severity: "high", title: `Product shows a zero price (${prices[0]})`, selector: PRICE_SELECTORS.split(",")[0], evidence: { prices } });

    if (!hasProductSchema($))
      add({ rule: "bc.pdp-schema-missing", severity: "medium", title: "Product page has no Product structured data", detail: "No JSON-LD or microdata of type Product. Stencil themes ship this by default; a theme edit likely removed it." });
  }

  // Facet / sort URLs that are crawlable and indexable create duplicate content.
  const u = new URL(p.url);
  if (["plp", "search"].includes(p.template) && [...u.searchParams.keys()].some((k) => /^(_bc_fsnf|sort|limit|mode|page)$/.test(k) || k.includes("["))) {
    const robots = robotsMeta($);
    const canonical = $('link[rel="canonical"]').attr("href");
    const canonicalClean = canonical ? !new URL(canonical, p.url).search : false;
    if (!robots.includes("noindex") && !canonicalClean)
      add({ rule: "bc.facet-url-indexable", severity: "low", title: "Faceted/sorted listing URL is indexable", detail: "No noindex and the canonical keeps the query string. Disallow facet params in robots.txt or canonicalise to the clean URL.", evidence: { canonical } });
  }
  return out;
}

/** Paths BigCommerce's default robots.txt keeps crawlers out of. */
const TRANSACTIONAL = /^\/(cart\.php|checkout|finishorder\.php|login\.php|account\.php|wishlist\.php|compare)/i;

function siteFindings(pages: PackPage[], ctx: PackContext): FindingInput[] {
  const out: FindingInput[] = [];
  const robotsUrl = new URL("/robots.txt", ctx.baseUrl).toString();

  if (ctx.robotsTxt === null)
    out.push({ category: "platform", rule: "bc.robots-missing", severity: "medium", title: "robots.txt missing", detail: "BigCommerce serves a default robots.txt; a missing one usually means a proxy or CDN rule is intercepting it.", url: robotsUrl });
  else {
    if (!/^\s*sitemap\s*:/im.test(ctx.robotsTxt))
      out.push({ category: "platform", rule: "bc.robots-no-sitemap", severity: "low", title: "robots.txt does not list a sitemap", detail: "BigCommerce's default lists /xmlsitemap.php. Add it back so crawlers find the catalogue.", url: robotsUrl });
    const missing = ["/cart.php", "/checkout"].filter((path) => !robotsDisallows(ctx.robotsTxt!, path));
    if (missing.length)
      out.push({ category: "platform", rule: "bc.robots-transactional-allowed", severity: "low", title: `robots.txt does not disallow ${missing.join(", ")}`, detail: "The BigCommerce default disallows cart and checkout. It looks customised.", url: robotsUrl, evidence: { missing } });
  }

  for (const p of pages) {
    const path = new URL(p.url).pathname;
    if (!TRANSACTIONAL.test(path) || !p.html || (p.status ?? 0) >= 400) continue;
    const robots = cheerio.load(p.html)('meta[name="robots"]').attr("content")?.toLowerCase() ?? "";
    if (!robots.includes("noindex"))
      out.push({ category: "platform", rule: "bc.transactional-indexable", severity: "low", title: `${path} is crawlable and indexable`, detail: "Cart, checkout and account pages should be disallowed in robots.txt or carry noindex.", url: p.url });
  }

  return out;
}

export const bigcommercePack: PlatformPack = {
  platform: "bigcommerce",
  templateOf: bigcommerceTemplate,
  pageFindings,
  siteFindings,
};
