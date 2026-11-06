import * as cheerio from "cheerio";
import type { FindingInput } from "@mattertest/core";
import type { PackContext, PackGet, PackPage, PlatformPack } from "./types";
import { hasProductSchema, robotsDisallows, robotsMeta, tempDomainFindings } from "./util";

/**
 * WordPress pack (with WooCommerce product checks when WooCommerce is present).
 *
 * Launch mistakes: search engines discouraged in Settings › Reading, default content
 * ("Hello world!", "Sample Page", "Just another WordPress site"), links and canonicals left on the
 * staging host, PHP warnings printed into pages, robots.txt blocking theme files, and plugin bloat.
 * Probes a short fixed list of public paths: the REST user list, XML-RPC, wp-content/debug.log,
 * an uploads folder listing and readme.html.
 */

/** Body classes WordPress adds (most specific first) -> MatterTest template. */
const BODY_CLASS_TEMPLATES: [RegExp, string][] = [
  [/\bsingle-product\b/, "pdp"],
  [/\b(tax-product_cat|tax-product_tag|post-type-archive-product)\b/, "plp"],
  [/\bwoocommerce-cart\b/, "cart"],
  [/\bwoocommerce-checkout\b/, "checkout"],
  [/\bwoocommerce-account\b/, "account"],
  [/\bhome\b/, "home"],
  [/\bsearch(-results|-no-results)?\b/, "search"],
  [/\berror404\b/, "not-found"],
  [/\battachment\b/, "attachment"],
  [/\b(single-post|single)\b/, "blog"],
  [/\bblog\b/, "blog"],
  [/\b(category|tag|archive|author|date)\b/, "archive"],
  [/\bpage\b/, "landing"],
];

export function wordpressTemplate(html: string): string | undefined {
  const cls = /<body[^>]*class=["']([^"']*)["']/i.exec(html)?.[1];
  if (!cls) return undefined;
  for (const [re, t] of BODY_CLASS_TEMPLATES) if (re.test(cls)) return t;
  return undefined;
}

/** Hosting providers' temporary/staging hostnames and local dev hosts. */
const STAGING_HOST = /(^|\.)(wpengine\.com|wpenginepowered\.com|kinsta\.cloud|kinstacdn\.com|flywheelsites\.com|flywheelstaging\.com|pantheonsite\.io|cloudwaysapps\.com|wpcomstaging\.com|instawp\.xyz|localhost|[a-z0-9-]+\.local|[a-z0-9-]+\.test)(:\d+)?$|^staging\.|^stage\.|^dev\./i;
const DEFAULT_TAGLINE = /Just another WordPress site/i;
const PHP_ERROR = /<b>(Warning|Notice|Deprecated|Fatal error|Parse error)<\/b>:\s+([^<]{0,200})/i;

function isWoo($: cheerio.CheerioAPI, html: string): boolean {
  return /\/wp-content\/plugins\/woocommerce\//i.test(html) || $("body").is(".woocommerce, .woocommerce-page");
}

function pageFindings(p: PackPage, ctx: PackContext): FindingInput[] {
  if (!p.html || (p.status ?? 0) >= 400) return [];
  const $ = cheerio.load(p.html);
  const out: FindingInput[] = [];
  const add = (f: Omit<FindingInput, "category" | "url">) => out.push({ category: "platform", url: p.url, ...f });
  const siteHost = new URL(ctx.baseUrl).host;
  const path = new URL(p.url).pathname;

  // Default content left from the WordPress install.
  const title = $("title").text();
  const h1 = $("h1").first().text().trim();
  if (/^\/(hello-world|sample-page)\/?$/.test(path) || /^(Hello world!|Sample Page)$/i.test(h1))
    add({ rule: "wp.default-content", severity: "high", title: `Default WordPress content is published (${h1 || path})`, detail: "The install's sample post or page is still live. Delete it, or set it to draft.", evidence: { path, heading: h1 } });
  if (DEFAULT_TAGLINE.test(title) || DEFAULT_TAGLINE.test($('meta[name="description"]').attr("content") ?? "") || DEFAULT_TAGLINE.test($(".site-description").text()))
    add({ rule: "wp.default-tagline", severity: "medium", title: 'Default tagline "Just another WordPress site" is showing', detail: "Change it under Settings › General (or clear it). It appears in titles and search results." });

  // Links and canonicals left on the staging or hosting provider's temporary domain.
  out.push(...tempDomainFindings($, p.url, siteHost, { domain: STAGING_HOST, domainLabel: "staging", canonicalRule: "wp.staging-domain-canonical", linksRule: "wp.staging-domain-links", canonicalFix: "Run a search-replace from the staging URL to the live URL (WP-CLI `wp search-replace`)" }));

  // PHP warnings printed into the page (WP_DEBUG_DISPLAY on): broken layout and server paths exposed.
  const php = PHP_ERROR.exec(p.html);
  if (php)
    add({ rule: "wp.php-errors-visible", severity: "high", title: `PHP ${php[1]!.toLowerCase()} printed on the page`, detail: "Debug output is shown to visitors and exposes server file paths. Set WP_DEBUG_DISPLAY to false in wp-config.php and fix the underlying error.", evidence: { message: php[2]!.trim().replace(/\s+/g, " ").slice(0, 160) } });

  // Attachment pages: thin, duplicate pages for every uploaded image.
  if (p.template === "attachment" && !robotsMeta($).includes("noindex"))
    add({ rule: "wp.attachment-page-indexable", severity: "low", title: "Image attachment page is indexable", detail: "WordPress creates a page for every upload. Redirect attachment pages to the file or parent post (most SEO plugins have a setting)." });

  // WooCommerce product pages.
  if (p.template === "pdp" && isWoo($, p.html)) {
    const outOfStock = $(".stock.out-of-stock, .out-of-stock").length > 0 || /out of stock/i.test($(".summary, .entry-summary").text());
    if (!$("form.cart, .single_add_to_cart_button, [name='add-to-cart']").length && !outOfStock)
      add({ rule: "wp.woo-pdp-no-add-to-cart", severity: "high", title: "Product page has no add-to-cart form", detail: "No WooCommerce cart form and no out-of-stock notice. The product may have no price, or the theme template is broken." });
    const prices = $(".summary .price .amount, .entry-summary .price .amount, .product .price .amount").map((_, el) => $(el).text().trim()).get().filter(Boolean);
    if (prices.length && prices.every((t) => /^[^\d]*0+(?:[.,]0+)?[^\d]*$/.test(t)))
      add({ rule: "wp.woo-pdp-zero-price", severity: "high", title: `Product shows a zero price (${prices[0]})`, evidence: { prices } });
    if (!hasProductSchema($))
      add({ rule: "wp.woo-pdp-schema-missing", severity: "medium", title: "Product page has no Product structured data", detail: "WooCommerce outputs Product schema by default; an SEO plugin or theme change may have removed it." });
  }
  return out;
}

function siteFindings(pages: PackPage[], ctx: PackContext): FindingInput[] {
  const out: FindingInput[] = [];
  const robotsUrl = new URL("/robots.txt", ctx.baseUrl).toString();
  const live = pages.filter((p) => p.html && (p.status ?? 0) < 400);

  // "Discourage search engines" (Settings › Reading) puts noindex on every page.
  const home = live.find((p) => p.template === "home") ?? live[0];
  const noindexed = live.filter((p) => robotsMeta(cheerio.load(p.html)).includes("noindex"));
  if (home && live.length && noindexed.includes(home) && noindexed.length / live.length >= 0.8)
    out.push({ category: "platform", rule: "wp.search-engines-discouraged", severity: "critical", title: `Search engines are blocked site-wide (${noindexed.length} of ${live.length} pages noindex)`, detail: 'Untick "Discourage search engines from indexing this site" under Settings › Reading, or check the SEO plugin\'s settings.', url: home.url });

  if (ctx.robotsTxt !== null) {
    const blocked = ["/wp-content/", "/wp-includes/"].filter((path) => robotsDisallows(ctx.robotsTxt!, path));
    if (blocked.length)
      out.push({ category: "platform", rule: "wp.robots-blocks-assets", severity: "medium", title: `robots.txt blocks ${blocked.join(" and ")}`, detail: "Google needs the theme's CSS and JavaScript to render pages. Remove these Disallow lines.", url: robotsUrl, evidence: { blocked } });
    if (!/^\s*sitemap\s*:/im.test(ctx.robotsTxt))
      out.push({ category: "platform", rule: "wp.robots-no-sitemap", severity: "low", title: "robots.txt does not list a sitemap", detail: "WordPress (or the SEO plugin) publishes one; list it in robots.txt so crawlers find every page.", url: robotsUrl });
  }

  // Version disclosure and plugin count, from the home page.
  if (home) {
    const $ = cheerio.load(home.html);
    const gen = $('meta[name="generator"]').map((_, el) => $(el).attr("content") ?? "").get().find((c) => /^WordPress \d/i.test(c));
    if (gen)
      out.push({ category: "platform", rule: "wp.version-exposed", severity: "low", title: `WordPress version is advertised (${gen})`, detail: "The generator tag tells attackers which version to target. Most security plugins can remove it.", url: home.url, evidence: { generator: gen } });

    const plugins = new Set([...home.html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\//gi)].map((m) => m[1]!.toLowerCase()));
    if (plugins.size > 20)
      out.push({ category: "platform", rule: "wp.many-plugins", severity: "medium", title: `${plugins.size} plugins load files on the home page`, detail: "Every plugin that loads CSS or JavaScript on every page slows the site down. Remove unused plugins and load the rest only where needed.", url: home.url, evidence: { plugins: [...plugins].sort() } });
  }
  return out;
}

/** Fixed GETs of public paths. Usernames from the REST API are counted, never stored. */
async function probe(ctx: PackContext, get: PackGet): Promise<FindingInput[]> {
  const out: FindingInput[] = [];
  const url = (p: string) => new URL(p, ctx.baseUrl).toString();
  const [users, xmlrpc, debugLog, uploads, readme] = await Promise.all([
    get("/wp-json/wp/v2/users"),
    get("/xmlrpc.php"),
    get("/wp-content/debug.log"),
    get("/wp-content/uploads/"),
    get("/readme.html"),
  ]);

  if (users?.status === 200) {
    try {
      const list = JSON.parse(users.body) as unknown;
      if (Array.isArray(list) && list.some((u) => u && typeof u === "object" && "slug" in u))
        out.push({ category: "platform", rule: "wp.users-listed", severity: "medium", title: `Usernames are public via the REST API (${list.length} user${list.length === 1 ? "" : "s"})`, detail: "Anyone can list login names at /wp-json/wp/v2/users, which helps password-guessing attacks. Restrict the users endpoint with a security plugin or a small filter.", url: url("/wp-json/wp/v2/users"), evidence: { count: list.length } });
    } catch {
      /* not JSON: endpoint disabled or replaced */
    }
  }
  if (xmlrpc && (xmlrpc.status === 200 || xmlrpc.status === 405) && /XML-RPC server accepts POST requests only/i.test(xmlrpc.body))
    out.push({ category: "platform", rule: "wp.xmlrpc-enabled", severity: "low", title: "XML-RPC is enabled", detail: "xmlrpc.php is a common target for password-guessing and pingback abuse. Disable it unless the Jetpack or WordPress mobile apps need it.", url: url("/xmlrpc.php") });
  if (debugLog?.status === 200 && /PHP (Warning|Notice|Fatal|Deprecated|Parse error)|\[\d{2}-[A-Za-z]{3}-\d{4}/.test(debugLog.body.slice(0, 5000)))
    out.push({ category: "platform", rule: "wp.debug-log-public", severity: "high", title: "Debug log is publicly readable", detail: "wp-content/debug.log exposes server paths and errors, sometimes data. Delete it, set WP_DEBUG_LOG to false or a private path, and block access.", url: url("/wp-content/debug.log") });
  if (uploads?.status === 200 && /<title>Index of \//i.test(uploads.body))
    out.push({ category: "platform", rule: "wp.uploads-listing", severity: "medium", title: "Uploads folder can be browsed", detail: "Anyone can list every uploaded file, including ones not linked from the site. Turn off directory listing on the server.", url: url("/wp-content/uploads/") });
  if (readme?.status === 200 && /WordPress/i.test(readme.body) && /Version\s+\d/i.test(readme.body))
    out.push({ category: "platform", rule: "wp.readme-exposed", severity: "low", title: "readme.html reveals the WordPress version", detail: "Delete readme.html from the site root (it comes back on updates; a security plugin can block it).", url: url("/readme.html") });
  return out;
}

export const wordpressPack: PlatformPack = {
  platform: "wordpress",
  templateOf: wordpressTemplate,
  pageFindings,
  siteFindings,
  probe,
};
