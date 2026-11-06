import type { FindingInput, Platform } from "@mattertest/core";

/** What a platform pack sees for each crawled page. */
export interface PackPage {
  url: string;
  status: number | null;
  headers: Record<string, string>;
  html: string;
  template: string;
}

export interface PackContext {
  baseUrl: string;
  /** robots.txt body, or null when the site has none. */
  robotsTxt: string | null;
}

/**
 * A platform pack adds checks that only make sense on one platform.
 * Packs are passive: they read pages the crawler already fetched plus robots.txt.
 */
export interface PlatformPack {
  platform: Platform;
  /** Template from the page markup. Return undefined to fall back to the URL heuristic. */
  templateOf?(html: string): string | undefined;
  pageFindings(page: PackPage, ctx: PackContext): FindingInput[];
  siteFindings(pages: PackPage[], ctx: PackContext): FindingInput[];
}
