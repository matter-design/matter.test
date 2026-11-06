import { mkdir, readFile, writeFile } from "node:fs/promises";
import { newContext } from "./browser-shim";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium, firefox, webkit, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { artefactPath, type FindingInput } from "@mattertest/core";
import { isBotChallenge } from "./crawl";

/**
 * Visual regression and cross-browser checks.
 *
 * Screenshot diffs need an approved baseline per (page, browser, viewport). The first run stores
 * baselines; later runs compare against them. Separate from baselines, every capture also checks
 * things that are wrong in any single run: horizontal scrolling, uncaught JS errors, and images
 * that load in some browsers but not others.
 */

export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type BrowserName = (typeof BROWSERS)[number];

export const VIEWPORTS = {
  mobile: { width: 390, height: 844, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export const BROWSER_LABEL: Record<BrowserName, string> = { chromium: "Chrome", firefox: "Firefox", webkit: "Safari" };

export interface BaselineKey {
  url: string;
  browser: BrowserName;
  viewport: ViewportName;
}

/** Where baselines live and where this run's screenshots go. URIs are relative to artefactDir(). */
export interface BaselineStore {
  /** The approved baseline image, or null if there is none yet. */
  get(key: BaselineKey): Promise<{ uri: string; png: Buffer } | null>;
  /** Store a first baseline and return its URI. */
  create(key: BaselineKey, png: Buffer): Promise<string>;
  /** Store this run's screenshot or diff image and return its URI. */
  saveRunImage(key: BaselineKey, kind: "current" | "diff", png: Buffer): Promise<string>;
}

export function keySlug(k: BaselineKey): string {
  const u = new URL(k.url);
  const path = (u.pathname + u.search).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "home";
  const hash = createHash("sha1").update(k.url).digest("hex").slice(0, 8);
  return `${path}-${hash}__${k.browser}__${k.viewport}`;
}

async function writeArtefact(uri: string, png: Buffer): Promise<string> {
  const full = artefactPath(uri);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, png);
  return uri;
}

/**
 * File-based store for the CLI: baselines under visual/<host>/baselines, run images under visual/<host>/runs/<stamp>.
 * With updateBaselines, every capture becomes the new baseline (the CLI's "accept all").
 */
export function fileBaselineStore(host: string, runStamp: string, opts: { updateBaselines?: boolean } = {}): BaselineStore {
  const safeHost = host.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const baseUri = (k: BaselineKey) => `visual/${safeHost}/baselines/${keySlug(k)}.png`;
  return {
    async get(k) {
      if (opts.updateBaselines) return null;
      const uri = baseUri(k);
      try {
        return { uri, png: await readFile(artefactPath(uri)) };
      } catch {
        return null;
      }
    },
    create: (k, png) => writeArtefact(baseUri(k), png),
    saveRunImage: (k, kind, png) => writeArtefact(`visual/${safeHost}/runs/${runStamp}/${keySlug(k)}.${kind}.png`, png),
  };
}

export interface VisualCapture extends BaselineKey {
  template: string;
  /** "blocked": the site served a bot-protection challenge; nothing was compared or stored. */
  status: "baseline-created" | "match" | "changed" | "blocked" | "error";
  /** Share of compared pixels that differ, 0-1. */
  diffRatio?: number;
  /** Bounding box of the changed pixels, in screenshot pixels. */
  changedBox?: { x: number; y: number; width: number; height: number };
  heightBefore?: number;
  heightAfter?: number;
  baselineUri?: string;
  currentUri?: string;
  diffUri?: string;
  /** Pixels the page is wider than the viewport. */
  overflowPx: number;
  overflowElement?: string;
  jsErrors: string[];
  brokenImages: string[];
  /** <meta name="viewport" content="width=..."> present. Without it phones render a shrunk desktop page. */
  hasViewportMeta?: boolean;
  error?: string;
}

export interface VisualOptions {
  browsers?: BrowserName[];
  viewports?: ViewportName[];
  /** Screenshot height cap, px. Long pages are compared down to this depth. */
  maxHeight?: number;
  /** pixelmatch per-pixel colour threshold (0-1). */
  threshold?: number;
  /** Changed-pixel share above which a page counts as changed. Default 0.2%. */
  failRatio?: number;
  /** Extra selectors to hide before capture (carousels, live chat, timestamps). */
  mask?: string[];
  userAgent?: string;
  store?: BaselineStore;
  /** The already-launched Chromium; Firefox and WebKit are launched here. */
  chromium?: Browser;
  onProgress?: (msg: string) => void;
}

/** Browser warnings surfaced as errors that do not affect visitors. */
export const BENIGN_ERRORS = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)|^Script error\.?$/i;

/** Content that changes on every load and would make diffs noisy. */
export const DEFAULT_MASKS = [
  "iframe",
  "video",
  "[data-mt-mask]",
  ".heroCarousel",
  ".slick-slider",
  ".swiper",
  ".carousel",
  "slideshow-component",
  ".flickity-viewport",
  "[data-flickity]",
  ".splide",
  ".glide",
  ".owl-carousel",
  ".keen-slider",
  "marquee-component",
  ".marquee",
  "[aria-live]",
  "#launcher",
  // Email/SMS pop-ups that appear on a timer.
  ".klaviyo-form",
  "[class*='kl-private-reset-css']",
  "[aria-modal='true']",
  "#hubspot-messages-iframe-container",
  ".intercom-lightweight-app",
];

function contextOptions(browser: BrowserName, viewport: ViewportName, ua?: string): BrowserContextOptions {
  const v = VIEWPORTS[viewport];
  return {
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: 1,
    // Firefox has no mobile emulation; it gets the viewport size only.
    isMobile: browser !== "firefox" && v.mobile,
    hasTouch: browser !== "firefox" && v.mobile,
    reducedMotion: "reduce",
    userAgent: browser === "chromium" ? ua : undefined,
  };
}

/** Load, settle and measure one page. Lazy content is triggered by scrolling to the cap and back. */
async function preparePage(page: Page, url: string, maxHeight: number) {
  const jsErrors: string[] = [];
  page.on("pageerror", (e) => {
    const msg = e.message.split("\n")[0]!.slice(0, 200);
    if (!BENIGN_ERRORS.test(msg)) jsErrors.push(msg);
  });
  await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(async (cap) => {
    const step = Math.max(200, window.innerHeight - 100);
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, cap); y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await document.fonts?.ready;
  }, maxHeight);
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(500); // let scroll-driven header states settle back to "top of page"
  // Freeze fixed and sticky elements. In a full-page capture they otherwise land wherever the last
  // scroll left them (sticky headers mid-page, off-screen drawers sliding in), so identical pages "change".
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed") el.style.setProperty("position", "absolute", "important");
      else if (pos === "sticky") el.style.setProperty("position", "static", "important");
    }
  });
  await page.waitForTimeout(200);

  const facts = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const overflowPx = Math.max(0, document.documentElement.scrollWidth - vw);
    let overflowElement: string | undefined;
    if (overflowPx > 1) {
      let worst = 0;
      for (const el of Array.from(document.body.querySelectorAll("*")).slice(0, 5000)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || getComputedStyle(el).position === "fixed") continue;
        if (r.right - vw > worst) {
          worst = r.right - vw;
          const cls = el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "";
          overflowElement = el.tagName.toLowerCase() + (el.id ? "#" + el.id : cls);
        }
      }
    }
    const brokenImages = Array.from(document.images)
      .filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src))
      .map((i) => i.currentSrc || i.src)
      .slice(0, 20);
    const hasViewportMeta = !!document.querySelector('meta[name="viewport" i][content*="width" i]');
    return { overflowPx, overflowElement, brokenImages, hasViewportMeta, height: document.documentElement.scrollHeight };
  });
  return { ...facts, jsErrors };
}

/** Copy the top-left w x h of a PNG into a new PNG. */
function crop(png: PNG, w: number, h: number): PNG {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, 0, 0, w, h, 0, 0);
  return out;
}

export interface DiffResult {
  ratio: number;
  changed: number;
  box?: { x: number; y: number; width: number; height: number };
  diffPng: Buffer;
  heightBefore: number;
  heightAfter: number;
}

/** Compare two screenshots over their shared area. Height differences are reported separately. */
export function diffImages(baseline: Buffer, current: Buffer, threshold = 0.1): DiffResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const diff = new PNG({ width: w, height: h });
  const changed = pixelmatch(crop(a, w, h).data, crop(b, w, h).data, diff.data, w, h, { threshold, alpha: 0.3 });
  let box: DiffResult["box"];
  if (changed) {
    // Bounding box of the red diff pixels (pixelmatch's default diffColor).
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    if (x1 >= 0) box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }
  return { ratio: changed / (w * h), changed, box, diffPng: PNG.sync.write(diff), heightBefore: a.height, heightAfter: b.height };
}

const LAUNCHERS = { chromium, firefox, webkit };

/** Capture every page in every browser and viewport, compare to baselines, and collect cross-browser problems. */
export async function runVisualChecks(pages: { url: string; template: string }[], o: VisualOptions = {}): Promise<{ captures: VisualCapture[]; skippedBrowsers: { browser: BrowserName; reason: string }[] }> {
  const browsers = o.browsers ?? [...BROWSERS];
  const viewports = o.viewports ?? (Object.keys(VIEWPORTS) as ViewportName[]);
  const maxHeight = o.maxHeight ?? 5000;
  const failRatio = o.failRatio ?? 0.002;
  const log = o.onProgress ?? (() => undefined);
  const captures: VisualCapture[] = [];
  const skippedBrowsers: { browser: BrowserName; reason: string }[] = [];

  for (const name of browsers) {
    let browser: Browser;
    let owned = false;
    try {
      if (name === "chromium" && o.chromium) browser = o.chromium;
      else {
        browser = await LAUNCHERS[name].launch();
        owned = true;
      }
    } catch (e) {
      const reason = (e as Error).message.split("\n")[0]!;
      log(`${name} unavailable, skipping: ${reason}`);
      skippedBrowsers.push({ browser: name, reason });
      continue;
    }
    try {
      for (const viewport of viewports) {
        const context = await newContext(browser, contextOptions(name, viewport, o.userAgent));
        try {
          for (const { url, template } of pages) {
            const key: BaselineKey = { url, browser: name, viewport };
            const cap: VisualCapture = { ...key, template, status: "error", overflowPx: 0, jsErrors: [], brokenImages: [] };
            const page = await context.newPage();
            try {
              const facts = await preparePage(page, url, maxHeight);
              if (isBotChallenge(await page.content())) {
                cap.status = "blocked";
                captures.push(cap);
                continue;
              }
              Object.assign(cap, { overflowPx: facts.overflowPx, overflowElement: facts.overflowElement, jsErrors: facts.jsErrors, brokenImages: facts.brokenImages, hasViewportMeta: facts.hasViewportMeta });
              const width = VIEWPORTS[viewport].width;
              const png = await page.screenshot({
                fullPage: true,
                clip: { x: 0, y: 0, width, height: Math.min(facts.height, maxHeight) },
                animations: "disabled",
                caret: "hide",
                mask: [...DEFAULT_MASKS, ...(o.mask ?? [])].map((s) => page.locator(s)),
                maskColor: "#ff00ff",
              });
              if (o.store) {
                const base = await o.store.get(key);
                if (!base) {
                  cap.baselineUri = await o.store.create(key, png);
                  cap.status = "baseline-created";
                } else {
                  const d = diffImages(base.png, png, o.threshold ?? 0.1);
                  cap.baselineUri = base.uri;
                  cap.diffRatio = Math.round(d.ratio * 100_000) / 100_000;
                  cap.heightBefore = d.heightBefore;
                  cap.heightAfter = d.heightAfter;
                  const heightChanged = Math.abs(d.heightAfter - d.heightBefore) > Math.max(50, d.heightBefore * 0.03);
                  if (d.ratio > failRatio || heightChanged) {
                    cap.status = "changed";
                    cap.changedBox = d.box;
                    cap.currentUri = await o.store.saveRunImage(key, "current", png);
                    cap.diffUri = await o.store.saveRunImage(key, "diff", d.diffPng);
                  } else cap.status = "match";
                }
              } else cap.status = "match";
            } catch (e) {
              cap.error = (e as Error).message.split("\n")[0];
              log(`visual failed: ${name} ${viewport} ${url}: ${cap.error}`);
            } finally {
              await page.close();
            }
            captures.push(cap);
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      if (owned) await browser.close();
    }
  }
  return { captures, skippedBrowsers };
}

const list = (bs: BrowserName[]) => bs.map((b) => BROWSER_LABEL[b]).join(", ");

/** Findings from captures. Cross-browser problems are merged across browsers so each shows once. */
export function visualFindings(captures: VisualCapture[], allBrowsers: BrowserName[]): FindingInput[] {
  const out: FindingInput[] = [];
  const ok = captures.filter((c) => c.status !== "error" && c.status !== "blocked");
  const blockedCaps = captures.filter((c) => c.status === "blocked");
  if (blockedCaps.length)
    out.push({ category: "visual", rule: "visual.blocked", severity: "info", title: `${blockedCaps.length} screenshot${blockedCaps.length === 1 ? "" : "s"} skipped: blocked by bot protection`, url: blockedCaps[0]!.url, detail: "The site showed a \"verify you are human\" challenge, so these pages were not compared. Ask the site owner to allowlist the MatterTest crawler.", evidence: { captures: blockedCaps.map((c) => `${c.url} ${c.browser}/${c.viewport}`).slice(0, 30) } });

  for (const c of captures.filter((x) => x.status === "changed")) {
    const pct = ((c.diffRatio ?? 0) * 100).toFixed(1);
    const heightNote = c.heightBefore !== undefined && c.heightAfter !== c.heightBefore ? ` Page height ${c.heightBefore} → ${c.heightAfter} px.` : "";
    out.push({
      category: "visual",
      rule: "visual.changed",
      severity: (c.diffRatio ?? 0) >= 0.05 ? "medium" : "low",
      title: `Page looks different from the approved version (${pct}% changed, ${BROWSER_LABEL[c.browser]} ${c.viewport})`,
      url: c.url,
      selector: `${c.browser}/${c.viewport}`,
      detail: `Compared with the approved baseline.${heightNote} Accept it as the new baseline if the change was intended.`,
      evidence: { browser: c.browser, viewport: c.viewport, template: c.template, diffRatio: c.diffRatio, changedBox: c.changedBox, heightBefore: c.heightBefore, heightAfter: c.heightAfter, baselineUri: c.baselineUri, currentUri: c.currentUri, diffUri: c.diffUri },
    });
  }

  // Horizontal scroll: one finding per page and viewport, listing the browsers it happens in.
  const overflow = new Map<string, VisualCapture[]>();
  for (const c of ok.filter((x) => x.overflowPx > 1)) overflow.set(`${c.url}|${c.viewport}`, [...(overflow.get(`${c.url}|${c.viewport}`) ?? []), c]);
  for (const cs of overflow.values()) {
    const c = cs[0]!;
    const bs = cs.map((x) => x.browser);
    out.push({
      category: "visual",
      rule: "visual.horizontal-overflow",
      severity: c.viewport === "mobile" ? "medium" : "low",
      title: `Page scrolls sideways on ${c.viewport} (${Math.max(...cs.map((x) => x.overflowPx))} px too wide)`,
      url: c.url,
      selector: c.viewport,
      detail: `${bs.length === allBrowsers.length ? "In every browser" : `In ${list(bs)}`}.${c.overflowElement ? ` Widest element: ${c.overflowElement}.` : ""}`,
      evidence: { viewport: c.viewport, browsers: bs, overflowPx: cs.map((x) => x.overflowPx), element: c.overflowElement },
    });
  }

  // JS errors: one finding per page and message, listing the browsers.
  const errs = new Map<string, Set<BrowserName>>();
  for (const c of ok) for (const m of c.jsErrors) errs.set(`${c.url}|${m}`, (errs.get(`${c.url}|${m}`) ?? new Set()).add(c.browser));
  for (const [k, set] of errs) {
    const [url, message] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const bs = [...set];
    const onlySome = bs.length < allBrowsers.length;
    out.push({
      category: "visual",
      rule: onlySome ? "visual.js-error-browser-specific" : "visual.js-error",
      severity: onlySome ? "high" : "medium",
      title: onlySome ? `JavaScript error only in ${list(bs)}` : "JavaScript error on page load",
      url,
      selector: message.slice(0, 120),
      detail: message,
      evidence: { browsers: bs, message },
    });
  }

  // Images broken in some browsers but fine in others: usually an unsupported format (AVIF/WebP) or srcset issue.
  const byUrl = new Map<string, VisualCapture[]>();
  for (const c of ok) byUrl.set(c.url, [...(byUrl.get(c.url) ?? []), c]);
  for (const [url, cs] of byUrl) {
    const brokenIn = new Map<string, Set<BrowserName>>();
    for (const c of cs) for (const img of c.brokenImages) brokenIn.set(img, (brokenIn.get(img) ?? new Set()).add(c.browser));
    const tested = new Set(cs.map((c) => c.browser));
    for (const [img, set] of brokenIn) {
      if (set.size === tested.size) continue; // broken everywhere: the link checks report it
      out.push({ category: "visual", rule: "visual.image-browser-specific", severity: "high", title: `Image fails to load only in ${list([...set])}`, url, selector: img, detail: "Often an image format or srcset entry the browser does not support.", evidence: { image: img, brokenIn: [...set], workingIn: [...tested].filter((b) => !set.has(b)) } });
    }
  }

  // Missing viewport meta: one finding per page (seen on any mobile capture).
  const noMeta = new Set(ok.filter((c) => c.viewport !== "desktop" && c.hasViewportMeta === false).map((c) => c.url));
  for (const url of noMeta)
    out.push({ category: "visual", rule: "visual.no-viewport-meta", severity: "high", title: "Page is not set up for phones (no viewport meta tag)", url, detail: 'Phones show a shrunken desktop page. Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });

  for (const c of captures.filter((x) => x.status === "error"))
    out.push({ category: "visual", rule: "visual.capture-failed", severity: "low", title: `Could not capture page in ${BROWSER_LABEL[c.browser]} (${c.viewport})`, url: c.url, selector: `${c.browser}/${c.viewport}`, detail: c.error });
  return out;
}
