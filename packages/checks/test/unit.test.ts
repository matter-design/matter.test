import { describe, expect, it } from "vitest";
import { findingFingerprint } from "@mattertest/core";
import { cookieFindings, detectPlatform, extractSeoFacts, guessTemplate, normaliseUrl, parseRobots, securityHeaderFindings, seoPageFindings, seoSiteFindings } from "../src/index";

describe("detectPlatform", () => {
  it("spots BigCommerce Stencil", () => {
    const html = `<script src="https://cdn11.bigcommerce.com/s-abc/stencil/app.js"></script><script>var jsContext = {};</script>`;
    expect(detectPlatform(html).platform).toBe("bigcommerce");
  });
  it("spots Shopify", () => {
    expect(detectPlatform(`<link href="//cdn.shopify.com/s/files/x.css"><script>Shopify.theme = {}</script>`).platform).toBe("shopify");
  });
  it("spots WordPress from generator meta", () => {
    expect(detectPlatform(`<meta name="generator" content="WordPress 6.6">`).platform).toBe("wordpress");
  });
  it("spots Laravel from headers and cookies", () => {
    expect(detectPlatform("<html></html>", { "X-Inertia": "true", "Set-Cookie": "laravel_session=abc" }).platform).toBe("laravel");
  });
  it("falls back to custom", () => {
    expect(detectPlatform("<html><body>hi</body></html>")).toEqual({ platform: "custom", evidence: [] });
  });
});

describe("SEO rules", () => {
  const good = `<html><head><title>Tents | Northwind</title><meta name="description" content="Tents for every trip">
    <link rel="canonical" href="https://x.test/tents"><meta property="og:title" content="Tents"></head><body><h1>Tents</h1></body></html>`;
  it("passes a well-formed page", () => {
    expect(seoPageFindings(extractSeoFacts("https://x.test/tents", good))).toEqual([]);
  });
  it("flags missing title, noindex, two h1s and broken JSON-LD", () => {
    const html = `<html><head><meta name="robots" content="NOINDEX,follow"><script type="application/ld+json">{bad json</script></head><body><h1>a</h1><h1>b</h1></body></html>`;
    const rules = seoPageFindings(extractSeoFacts("https://x.test/a", html)).map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["seo.title-missing", "seo.noindex", "seo.h1-multiple", "seo.jsonld-invalid", "seo.description-missing", "seo.canonical-missing"]));
  });
  it("flags duplicate titles across pages", () => {
    const a = extractSeoFacts("https://x.test/a", "<title>Same</title>");
    const b = extractSeoFacts("https://x.test/b", "<title>Same</title>");
    const c = extractSeoFacts("https://x.test/c", "<title>Different</title>");
    expect(seoSiteFindings([a, b, c]).map((f) => f.url)).toEqual(["https://x.test/a", "https://x.test/b"]);
  });
});

describe("security hygiene", () => {
  it("flags missing headers on https", () => {
    const rules = securityHeaderFindings("https://x.test/", {}).map((f) => f.rule);
    expect(rules).toEqual(["security.hsts-missing", "security.csp-missing", "security.nosniff-missing", "security.framing-unprotected"]);
  });
  it("accepts a hardened response", () => {
    const h = {
      "Strict-Transport-Security": "max-age=31536000",
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    };
    expect(securityHeaderFindings("https://x.test/", h)).toEqual([]);
  });
  it("flags a session cookie without HttpOnly and Secure", () => {
    const rules = cookieFindings("https://x.test/", [{ name: "SHOP_SESSION_TOKEN", secure: false, httpOnly: false, sameSite: "Lax" }]).map((f) => f.rule);
    expect(rules).toEqual(["security.cookie-not-secure", "security.cookie-not-httponly"]);
  });
});

describe("robots.txt", () => {
  const r = parseRobots(`User-agent: *\nDisallow: /cart\nDisallow: /*?sort=\nAllow: /cart/help\nSitemap: https://x.test/sitemap.xml`);
  it("applies longest match", () => {
    expect(r.isAllowed("/cart")).toBe(false);
    expect(r.isAllowed("/cart/help")).toBe(true);
    expect(r.isAllowed("/tents?sort=price")).toBe(false);
    expect(r.isAllowed("/tents")).toBe(true);
  });
  it("reads sitemaps", () => expect(r.sitemaps).toEqual(["https://x.test/sitemap.xml"]));
});

describe("url helpers", () => {
  it("normalises tracking params and hashes", () => {
    expect(normaliseUrl("/a?utm_source=x&b=2&a=1#top", "https://x.test/")).toBe("https://x.test/a?a=1&b=2");
    expect(normaliseUrl("mailto:hi@x.test", "https://x.test/")).toBeNull();
  });
  it("guesses templates", () => {
    expect(guessTemplate("https://x.test/", "bigcommerce")).toBe("home");
    expect(guessTemplate("https://x.test/products/tent", "shopify")).toBe("pdp");
    expect(guessTemplate("https://x.test/collections/tents", "shopify")).toBe("plp");
    expect(guessTemplate("https://x.test/cart.php", "bigcommerce")).toBe("cart");
  });
  it("fingerprints ignore trailing slash and wording", () => {
    const a = findingFingerprint({ rule: "seo.h1-missing", url: "https://x.test/a/" });
    const b = findingFingerprint({ rule: "seo.h1-missing", url: "https://x.test/a" });
    expect(a).toBe(b);
  });
});
