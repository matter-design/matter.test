import { PNG } from "pngjs";

/** The parts of a visual capture the report needs (structurally a subset of @mattertest/checks VisualCapture). */
export interface ReportCapture {
  url: string;
  template: string;
  browser: string;
  viewport: string;
  status: "baseline-created" | "match" | "changed" | "blocked" | "error";
  diffRatio?: number;
  changedBox?: { x: number; y: number; width: number; height: number };
  baselineUri?: string;
  currentUri?: string;
  overflowPx: number;
  jsErrors: string[];
  brokenImages: string[];
  hasViewportMeta?: boolean;
}

export interface ReportVisual {
  browsers: string[];
  viewports: string[];
  captures: ReportCapture[];
  skippedBrowsers?: { browser: string; reason: string }[];
  /** Before/after crops of the biggest changes, as data: URIs. */
  changes?: VisualChange[];
}

export interface VisualChange {
  url: string;
  template: string;
  browser: string;
  viewport: string;
  diffRatio: number;
  before: string;
  after: string;
}

/** Crop a region (with padding) out of a PNG. */
export function cropRegion(png: Buffer, box: { x: number; y: number; width: number; height: number }, pad = 24, maxHeight = 700): Buffer {
  const src = PNG.sync.read(png);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(src.width - x, box.width + pad * 2);
  const h = Math.min(src.height - y, box.height + pad * 2, maxHeight);
  if (w <= 0 || h <= 0) return png;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return PNG.sync.write(out);
}

/**
 * Before/after crops for the largest changes, one per page (preferring desktop Chrome, which clients compare against).
 * readImage returns the PNG for a stored artefact URI, or null if it is gone.
 */
export async function visualChanges(captures: ReportCapture[], readImage: (uri: string) => Promise<Buffer | null>, limit = 6): Promise<VisualChange[]> {
  const pref = (c: ReportCapture) => (c.browser === "chromium" ? 0 : 1) + (c.viewport === "desktop" ? 0 : 2);
  const best = new Map<string, ReportCapture>();
  for (const c of captures.filter((x) => x.status === "changed" && x.changedBox && x.baselineUri && x.currentUri)) {
    const cur = best.get(c.url);
    if (!cur || pref(c) < pref(cur)) best.set(c.url, c);
  }
  const out: VisualChange[] = [];
  for (const c of [...best.values()].sort((a, b) => (b.diffRatio ?? 0) - (a.diffRatio ?? 0)).slice(0, limit)) {
    const [before, after] = await Promise.all([readImage(c.baselineUri!), readImage(c.currentUri!)]);
    if (!before || !after) continue;
    const uri = (b: Buffer) => `data:image/png;base64,${cropRegion(b, c.changedBox!).toString("base64")}`;
    out.push({ url: c.url, template: c.template, browser: c.browser, viewport: c.viewport, diffRatio: c.diffRatio ?? 0, before: uri(before), after: uri(after) });
  }
  return out;
}
