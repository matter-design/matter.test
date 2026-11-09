"use client";

import { useActionState, useState } from "react";
import { saveCrawlSettings, type CrawlSettingsState } from "@/app/actions";
import { CRAWL_PAGES, PAGES_PER_TYPE } from "@/lib/environments";

/** The project's site-check settings. For now just "Pages to crawl". */
export function CrawlSettings({ projectId, crawlMaxPages }: { projectId: string; crawlMaxPages: number }) {
  const [state, action, pending] = useActionState<CrawlSettingsState, FormData>(saveCrawlSettings, {});
  const [value, setValue] = useState(String(crawlMaxPages));
  const dirty = value !== String(crawlMaxPages);

  return (
    <section className="panel">
      <div className="section-head"><h2 style={{ fontSize: 16 }}>Site check settings</h2></div>
      <form action={action} className="stack" style={{ gap: 6 }}>
        <input type="hidden" name="projectId" value={projectId} />
        <label htmlFor="cs-pages" style={{ fontWeight: 600 }}>Pages to crawl</label>
        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <input
            id="cs-pages"
            name="crawlMaxPages"
            type="number"
            inputMode="numeric"
            className="input"
            style={{ width: 120 }}
            min={CRAWL_PAGES.min}
            max={CRAWL_PAGES.max}
            step={1}
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={state.error ? "cs-pages-err cs-pages-hint" : "cs-pages-hint"}
            aria-invalid={state.error ? true : undefined}
          />
          <button type="submit" className="btn btn-secondary" disabled={pending || !dirty}>{pending ? "Saving…" : "Save"}</button>
          <span role="status" className="small muted">{state.saved && !dirty ? "Saved" : ""}</span>
        </div>
        {state.error && <span id="cs-pages-err" className="small bad">{state.error}</span>}
        <span id="cs-pages-hint" className="small muted">
          Every crawled page gets link checks. Accessibility, speed, SEO, security and screenshots test {PAGES_PER_TYPE === 1 ? "one page" : `${PAGES_PER_TYPE} pages`} of each page type. Applies from the next check.
        </span>
      </form>
    </section>
  );
}
