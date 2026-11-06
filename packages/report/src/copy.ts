import type { CheckCategory } from "@mattertest/core";

/**
 * Client-facing wording. Reports go to clients who are not developers, so every rule
 * gets a plain label, why it matters, and what to do. Rules without an entry fall back
 * to the finding's own title and detail.
 */
export interface RuleCopy {
  label: string;
  why: string;
  fix: string;
}

export const CATEGORY_COPY: Partial<Record<CheckCategory, { label: string; intro: string }>> = {
  crawl: { label: "Pages that failed", intro: "Pages we tried to open that errored or returned an error status." },
  links: { label: "Broken links and images", intro: "Links and images on the site that lead nowhere, or bounce through several redirects first." },
  seo: { label: "Search (SEO)", intro: "The page details search engines read: titles, descriptions, canonical tags, indexing rules and structured data." },
  performance: { label: "Speed", intro: "How quickly key pages load and respond, measured with Google Lighthouse on a simulated mid-range phone." },
  accessibility: { label: "Accessibility", intro: "Automated checks against WCAG 2.2 Level AA, the standard Australian and most international accessibility law points to." },
  security: { label: "Security basics", intro: "Passive checks of the protections a browser receives from the site. We did not attempt to break in." },
  platform: { label: "Platform", intro: "Checks specific to the store platform: catalogue, domain and setup mistakes we commonly see at launch." },
};

const RULES: Record<string, RuleCopy> = {
  // crawl
  "crawl.page-error": { label: "Pages that failed to load", why: "Visitors and search engines hit an error instead of content.", fix: "Check the server logs for these URLs and fix or redirect them." },
  // links
  "links.link-4xx": { label: "Broken links", why: "Visitors who click these links land on a 'page not found'. Search engines treat many broken links as a sign of a neglected site.", fix: "Update each link to the right page, or add a redirect from the old address." },
  "links.link-5xx": { label: "Links to pages that error", why: "The linked pages crash with a server error.", fix: "Investigate the server error on the target pages." },
  "links.link-unreachable": { label: "Links that could not be reached", why: "The target did not respond at all.", fix: "Check whether the target page or host still exists." },
  "links.image-4xx": { label: "Broken images", why: "Images are missing on the page, which looks broken and can hide product information.", fix: "Re-upload the images or update the image addresses." },
  "links.image-5xx": { label: "Images that error", why: "The image server returned an error.", fix: "Check the image host or CDN." },
  "links.image-unreachable": { label: "Images that could not be reached", why: "The image did not load at all.", fix: "Check the image address and host." },
  "links.redirect-loop": { label: "Redirect loops", why: "These addresses redirect in a circle, so the page never loads.", fix: "Remove the conflicting redirect rules." },
  "links.redirect-chain": { label: "Long redirect chains", why: "Each extra hop slows the visitor down and dilutes search ranking signals.", fix: "Point links and redirects straight at the final address." },
  // seo
  "seo.title-missing": { label: "Pages without a title", why: "The title is the headline shown in Google results and browser tabs.", fix: "Add a unique, descriptive title to each page." },
  "seo.title-long": { label: "Titles that are too long", why: "Google cuts titles off at around 60 characters.", fix: "Shorten titles, putting the important words first." },
  "seo.title-duplicate": { label: "Pages sharing the same title", why: "Search engines struggle to tell the pages apart and may show the wrong one.", fix: "Give each page its own title." },
  "seo.description-missing": { label: "Missing meta descriptions", why: "Google writes its own snippet, which is often less persuasive.", fix: "Add a short summary (up to about 155 characters) to each page." },
  "seo.description-long": { label: "Meta descriptions that are too long", why: "Google cuts them off in results.", fix: "Keep descriptions under about 155 characters." },
  "seo.canonical-missing": { label: "Missing canonical tags", why: "Without one, search engines may index duplicate versions of the page (with tracking or sort parameters).", fix: "Add a canonical tag pointing at the preferred address." },
  "seo.noindex": { label: "Pages hidden from search", why: "These pages tell Google not to list them. That is right for some pages, but costly if it is a product or category.", fix: "Confirm each one is meant to be hidden; remove noindex where it is not." },
  "seo.h1-missing": { label: "Pages without a main heading", why: "The main heading tells visitors and search engines what the page is about.", fix: "Add one H1 heading per page." },
  "seo.h1-multiple": { label: "Pages with several main headings", why: "Multiple H1s blur what the page is about.", fix: "Keep one H1 and make the others sub-headings." },
  "seo.og-missing": { label: "Missing social sharing tags", why: "Links shared on Facebook, LinkedIn or messaging apps show without a proper title or image.", fix: "Add Open Graph tags (title, description, image)." },
  "seo.jsonld-invalid": { label: "Broken structured data", why: "Search engines ignore structured data they cannot read, so rich results (prices, ratings) do not show.", fix: "Fix the JSON-LD so it is valid." },
  // performance
  "perf.lighthouse-score-poor": { label: "Low speed score", why: "Pages scoring under 50 feel slow on phones, and Google uses page experience as a ranking signal.", fix: "Work through the top Lighthouse suggestions listed for each page." },
  "perf.lighthouse-score-needs-improvement": { label: "Speed score below 90", why: "There is room to make these pages noticeably faster.", fix: "Work through the top Lighthouse suggestions listed for each page." },
  "perf.lcp-poor": { label: "Main content appears slowly (LCP)", why: "Visitors wait more than 4 seconds to see the main image or heading. Many leave before then.", fix: "Optimise and preload the hero image, and reduce render-blocking scripts and styles." },
  "perf.lcp-needs-improvement": { label: "Main content could appear faster (LCP)", why: "The main content takes longer than Google's 2.5 second target.", fix: "Optimise and preload the hero image; trim render-blocking resources." },
  "perf.cls-poor": { label: "Layout jumps while loading (CLS)", why: "Content shifts as the page loads, causing mis-taps and frustration.", fix: "Reserve space for images, banners and embeds before they load." },
  "perf.cls-needs-improvement": { label: "Some layout movement while loading (CLS)", why: "Content shifts a little as the page loads.", fix: "Set width and height on images and reserve space for late content." },
  "perf.tbt-poor": { label: "Page is busy and slow to respond (TBT)", why: "Heavy JavaScript blocks the page, so taps and scrolls lag.", fix: "Remove unused scripts and apps, and defer non-essential ones." },
  "perf.tbt-needs-improvement": { label: "Page is sometimes slow to respond (TBT)", why: "JavaScript keeps the page busy during loading.", fix: "Defer or remove non-essential scripts." },
  "perf.fcp-poor": { label: "Slow first paint", why: "Visitors stare at a blank screen for too long.", fix: "Reduce render-blocking CSS and scripts; check server speed." },
  "perf.fcp-needs-improvement": { label: "First paint could be faster", why: "The first content takes a while to show.", fix: "Reduce render-blocking CSS and scripts." },
  "perf.ttfb-poor": { label: "Slow server response", why: "The server takes a long time to start sending the page, delaying everything else.", fix: "Check hosting, caching and CDN configuration." },
  "perf.ttfb-needs-improvement": { label: "Server response could be faster", why: "The server is slower than ideal to respond.", fix: "Review caching and CDN configuration." },
  "perf.interaction-poor": { label: "Slow response to a click", why: "In our test, the page took more than half a second to react to a tap.", fix: "Break up long JavaScript tasks and remove heavy third-party scripts." },
  "perf.interaction-needs-improvement": { label: "Noticeable delay after a click", why: "In our test, the page took more than 200 ms to react to a tap.", fix: "Reduce JavaScript work that runs on interaction." },
  "perf.page-weight": { label: "Heavy pages", why: "Large pages are slow on mobile data and cost visitors data.", fix: "Compress images, remove unused scripts and fonts." },
  "perf.js-weight": { label: "Too much JavaScript", why: "Scripts must be downloaded and run before the page responds.", fix: "Remove unused apps and scripts; load the rest later." },
  "perf.request-count": { label: "Too many files per page", why: "Each file adds overhead, especially on mobile.", fix: "Combine or remove unnecessary scripts, fonts and tracking tags." },
  "perf.heavy-image": { label: "Oversized images", why: "Large images are the most common cause of slow pages.", fix: "Resize and compress images, and serve WebP or AVIF." },
  "perf.render-blocking": { label: "Files that block the page from showing", why: "The browser waits for these before showing anything.", fix: "Defer scripts and inline critical CSS." },
  // security
  "security.not-https": { label: "Page not secured with HTTPS", why: "Browsers mark the site 'Not secure' and data can be intercepted.", fix: "Serve the whole site over HTTPS and redirect HTTP to it." },
  "security.hsts-missing": { label: "HTTPS not enforced (HSTS)", why: "Visitors can be downgraded to an insecure connection on first visit.", fix: "Add the Strict-Transport-Security header." },
  "security.csp-missing": { label: "No Content Security Policy", why: "A CSP limits the damage if a malicious script ever gets onto the page.", fix: "Add a Content-Security-Policy header, starting in report-only mode." },
  "security.nosniff-missing": { label: "Missing nosniff header", why: "Browsers may guess file types, which can be abused.", fix: "Add X-Content-Type-Options: nosniff." },
  "security.framing-unprotected": { label: "Site can be embedded by other sites", why: "Another site could frame your pages to trick visitors into clicking (clickjacking).", fix: "Add X-Frame-Options or CSP frame-ancestors." },
  "security.x-powered-by": { label: "Server software is advertised", why: "It tells attackers what software to target.", fix: "Remove the X-Powered-By header." },
  "security.cookie-not-secure": { label: "Cookies not marked Secure", why: "These cookies could be sent over an insecure connection.", fix: "Set the Secure flag on cookies." },
  "security.cookie-not-httponly": { label: "Session cookies readable by scripts", why: "A malicious script could steal a visitor's session.", fix: "Set the HttpOnly flag on session cookies." },
  "security.cookie-samesite-none-insecure": { label: "Cross-site cookies without Secure", why: "Browsers reject or mishandle these cookies.", fix: "Add Secure to cookies that use SameSite=None." },
  "security.exposed-file": { label: "Private files publicly readable", why: "These files can contain passwords or source code.", fix: "Block or remove them from the web server immediately and rotate any secrets they contain." },
  // BigCommerce
  "bc.sample-products": { label: "BigCommerce sample products still live", why: "Demo '[Sample]' products are visible to shoppers and search engines.", fix: "Delete or hide the sample products and categories in the BigCommerce control panel." },
  "bc.store-domain-canonical": { label: "Canonical points at the temporary store address", why: "Google may index the *.mybigcommerce.com address instead of your domain.", fix: "Set your domain as the primary domain under Settings › Domain." },
  "bc.store-domain-links": { label: "Links to the temporary store address", why: "Shoppers are sent to the *.mybigcommerce.com address.", fix: "Update menus, banners and content to use your domain." },
  "bc.maintenance-mode": { label: "Store in maintenance mode", why: "Shoppers cannot browse or buy.", fix: "Turn off maintenance mode under Settings › Store profile when ready." },
  "bc.pdp-no-add-to-cart": { label: "Products that cannot be added to cart", why: "The page has no add-to-cart and no out-of-stock message, so the sale is lost.", fix: "Check the product's purchasability setting and the theme's product template." },
  "bc.pdp-zero-price": { label: "Products showing $0.00", why: "Shoppers see a zero price, or may be able to order for free.", fix: "Set the correct price, or hide the price for 'call for pricing' items." },
  "bc.pdp-schema-missing": { label: "Products missing structured data", why: "Without Product data, Google cannot show price and stock in results.", fix: "Restore the theme's Product schema markup." },
  "bc.facet-url-indexable": { label: "Filtered category pages can be indexed", why: "Every filter combination becomes a near-duplicate page in Google.", fix: "Canonicalise filtered pages to the main category, or block filter parameters in robots.txt." },
  "bc.transactional-indexable": { label: "Cart or checkout pages can be indexed", why: "These pages have no search value and waste crawl budget.", fix: "Restore BigCommerce's default robots.txt rules for cart and checkout." },
  "bc.robots-missing": { label: "robots.txt missing", why: "Search engines get no crawl guidance or sitemap location.", fix: "Check for a CDN or proxy rule intercepting /robots.txt." },
  "bc.robots-no-sitemap": { label: "Sitemap not listed in robots.txt", why: "Search engines may miss parts of the catalogue.", fix: "Add Sitemap: https://<your-domain>/xmlsitemap.php to robots.txt." },
  "bc.robots-transactional-allowed": { label: "robots.txt allows cart and checkout", why: "Search engines may crawl pages with no search value.", fix: "Restore BigCommerce's default Disallow rules." },
};

const AXE_WHY = "People using screen readers, keyboards or magnification may not be able to use this part of the site.";

/** Plain wording for the axe rules we see most on storefronts. Others fall back to axe's own help text. */
const AXE: Record<string, { label: string; fix: string; why?: string }> = {
  "button-name": { label: "Buttons without a name", fix: "Give icon-only buttons (search, menu, close) an accessible label such as aria-label=\"Search\"." },
  "link-name": { label: "Links without a name", fix: "Give icon-only links (social icons, logos) an accessible label or visible text." },
  "image-alt": { label: "Images without a text alternative", fix: "Add alt text describing each meaningful image; use empty alt=\"\" for decorative ones." },
  "input-image-alt": { label: "Image buttons without a text alternative", fix: "Add alt text to image buttons describing what they do." },
  "color-contrast": { label: "Text with too little contrast", why: "Low-contrast text is hard to read for people with low vision, and for everyone on a phone in sunlight.", fix: "Darken the text or lighten the background to reach a 4.5:1 contrast ratio (3:1 for large text)." },
  label: { label: "Form fields without a label", fix: "Connect a visible <label> to each field, or add aria-label where a visible label is not possible." },
  "select-name": { label: "Dropdowns without a label", fix: "Give each dropdown a visible label or aria-label." },
  "html-has-lang": { label: "Page language not set", fix: "Add lang=\"en-AU\" (or the right language) to the <html> element." },
  "document-title": { label: "Pages without a title", fix: "Add a descriptive <title> to every page." },
  "frame-title": { label: "Embedded frames without a title", fix: "Add a title attribute to each iframe (videos, maps, widgets)." },
  "aria-allowed-attr": { label: "Invalid ARIA attributes", fix: "Remove ARIA attributes that are not allowed on the element's role." },
  "aria-required-attr": { label: "ARIA roles missing required attributes", fix: "Add the attributes each ARIA role requires, or use a native HTML element instead." },
  "aria-valid-attr-value": { label: "ARIA attributes with invalid values", fix: "Correct the ARIA attribute values (for example aria-controls must point at an existing id)." },
  "aria-hidden-focus": { label: "Hidden content that can still be focused", fix: "Remove focusable elements from aria-hidden regions, or make them unfocusable." },
  "nested-interactive": { label: "Controls nested inside other controls", fix: "Do not put buttons or links inside other buttons or links." },
  list: { label: "Lists built incorrectly", fix: "Only put <li> elements directly inside <ul> and <ol>." },
  listitem: { label: "List items outside a list", fix: "Wrap <li> elements in a <ul> or <ol>." },
  "duplicate-id-aria": { label: "Duplicate ids used by ARIA", fix: "Give every element referenced by ARIA a unique id." },
  "meta-viewport": { label: "Zoom is disabled", fix: "Remove user-scalable=no and maximum-scale from the viewport meta tag." },
  "target-size": { label: "Tap targets too small", fix: "Make tap targets at least 24×24 px, or space them apart." },
  "link-in-text-block": { label: "Links only distinguished by colour", fix: "Underline links in body text, or add another non-colour cue." },
  "scrollable-region-focusable": { label: "Scrolling areas not reachable by keyboard", fix: "Make scrollable areas focusable (tabindex=\"0\") or contain focusable content." },
  "svg-img-alt": { label: "SVG images without a text alternative", fix: "Add role=\"img\" and an aria-label or <title> to meaningful SVGs." },
  "autocomplete-valid": { label: "Invalid autocomplete values", fix: "Use the standard autocomplete tokens (name, email, street-address…) on form fields." },
};

export function ruleCopy(rule: string, fallbackTitle: string, fallbackDetail?: string): RuleCopy {
  const exact = RULES[rule];
  if (exact) return exact;
  if (rule.startsWith("crawl.status-")) {
    const code = rule.slice("crawl.status-".length);
    return { label: `Pages returning ${code}`, why: code.startsWith("5") ? "These pages crash with a server error." : "These pages are linked from the site but do not exist.", fix: code.startsWith("5") ? "Investigate the server error." : "Restore the pages or redirect them, and update links pointing here." };
  }
  if (rule.startsWith("axe.")) {
    const known = AXE[rule.slice(4)];
    if (known) return { label: known.label, why: known.why ?? AXE_WHY, fix: known.fix };
    return { label: fallbackTitle, why: AXE_WHY, fix: "See the affected elements listed in the appendix, and the WCAG criterion noted." };
  }
  return { label: fallbackTitle, why: fallbackDetail ?? "", fix: "" };
}
