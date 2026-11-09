"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { Platform } from "@mattertest/core";
import { createProject, detectSitePlatform, type DetectResult, type NewProjectState } from "@/app/actions";
import { PLATFORM_LABEL } from "@/lib/format";
import { CRAWL_PAGES, ENVIRONMENT_OPTIONS, PAGES_PER_TYPE } from "@/lib/environments";

const PACKS: Partial<Record<Platform, string>> = { bigcommerce: "BigCommerce", shopify: "Shopify", wordpress: "WordPress" };

/** "New project" button plus the "Set up a project" dialog. */
export function NewProjectButton() {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" aria-haspopup="dialog" onClick={() => { setOpen(true); ref.current?.showModal(); }}>
        New project
      </button>
      <dialog
        ref={ref}
        className="dialog"
        aria-labelledby="np-title"
        onClose={() => setOpen(false)}
        onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}
      >
        {open && <NewProjectForm onCancel={() => ref.current?.close()} />}
      </dialog>
    </>
  );
}

type Detect = { state: "idle" } | { state: "checking" } | ({ state: "done" } & DetectResult);

function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const [state, action, pending] = useActionState<NewProjectState, FormData>(createProject, {});
  const [url, setUrl] = useState("");
  const [detect, setDetect] = useState<Detect>({ state: "idle" });
  const [runFirst, setRunFirst] = useState(true);
  const [pages, setPages] = useState<string>(String(CRAWL_PAGES.default));

  // Detect the platform shortly after the website address stops changing.
  useEffect(() => {
    if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(url.trim())) {
      setDetect({ state: "idle" });
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setDetect({ state: "checking" });
      const r = await detectSitePlatform(url.trim()).catch(() => ({ ok: false as const, reason: "Could not reach the site" }));
      if (live) setDetect({ state: "done", ...r });
    }, 700);
    return () => { live = false; clearTimeout(t); };
  }, [url]);

  const platform = detect.state === "done" && detect.ok ? detect.platform : undefined;
  const err = (k: keyof NonNullable<NewProjectState["fields"]>) => state.fields?.[k];
  const fieldProps = (k: keyof NonNullable<NewProjectState["fields"]>) =>
    err(k) ? { "aria-invalid": true as const, "aria-describedby": `np-${k}-err` } : {};
  const errorText = (k: keyof NonNullable<NewProjectState["fields"]>) =>
    err(k) ? <span id={`np-${k}-err`} className="small bad">{err(k)}</span> : null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        // Submit through a transition rather than <form action>, so a validation error keeps what was typed.
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <div className="dialog-head">
        <div>
          <h2 id="np-title">Set up a project</h2>
          <span className="muted">Add the client&apos;s website. Nothing is filed or posted anywhere until you approve it.</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onCancel}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="#14171F" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div className="dialog-body">
        {state.error && <p className="error" role="alert">{state.error}</p>}
        <section>
          <h3>Website</h3>
          <div className="fields">
            <div className="field">
              <label htmlFor="np-name">Project name</label>
              <input id="np-name" name="name" className="input" required placeholder="e.g. Debras website" {...fieldProps("name")} />
              {errorText("name")}
            </div>
            <div className="field">
              <label htmlFor="np-url">Website URL</label>
              <input id="np-url" name="url" type="url" className="input" required placeholder="https://www.example.com.au" value={url} onChange={(e) => setUrl(e.target.value)} {...fieldProps("url")} />
              {errorText("url")}
            </div>
            <div className="field">
              <label htmlFor="np-env">Environment</label>
              <select id="np-env" name="environment" className="input" defaultValue={ENVIRONMENT_OPTIONS[0].value} aria-describedby="np-env-hint" {...fieldProps("environment")}>
                {ENVIRONMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span id="np-env-hint" className="small muted">More environments can be added in Settings later.</span>
              {errorText("environment")}
            </div>
          </div>
          <PlatformBanner detect={detect} />
          <input type="hidden" name="platform" value={platform ?? ""} />
        </section>

        <section>
          <h3>Site check</h3>
          <div className="fields">
            <div className="field">
              <label htmlFor="np-pages">Pages to crawl</label>
              <input id="np-pages" name="crawlMaxPages" type="number" inputMode="numeric" className="input" min={CRAWL_PAGES.min} max={CRAWL_PAGES.max} step={1} required value={pages} onChange={(e) => setPages(e.target.value)} aria-describedby="np-pages-hint" {...fieldProps("crawlMaxPages")} />
              <span id="np-pages-hint" className="small muted">Every crawled page gets link checks. Accessibility, speed, SEO, security and screenshots test {PAGES_PER_TYPE === 1 ? "one page" : `${PAGES_PER_TYPE} pages`} of each page type.</span>
              {errorText("crawlMaxPages")}
            </div>
          </div>
        </section>

        <section>
          <h3>Connections <span className="hint muted small">(optional)</span></h3>
          <div className="fields">
            <div className="field">
              <label htmlFor="np-jira">Jira project key</label>
              <input id="np-jira" name="jiraKey" className="input" placeholder="e.g. NW" autoCapitalize="characters" {...fieldProps("jiraKey")} />
              {errorText("jiraKey")}
            </div>
            <div className="field">
              <label htmlFor="np-slack">Slack channel</label>
              <input id="np-slack" name="slackChannel" className="input" placeholder="#qa-client" {...fieldProps("slackChannel")} />
              {errorText("slackChannel")}
            </div>
          </div>
        </section>

        <section className="note">
          <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input type="checkbox" name="runFirstCheck" checked={runFirst} onChange={(e) => setRunFirst(e.target.checked)} style={{ width: 18, height: 18, margin: "2px 0 0" }} />
            <span className="stack" style={{ gap: 2 }}>
              <strong>Run the first site check now</strong>
              <span className="small">Leave this off for sites that block automated visitors until they allowlist MatterTest.</span>
            </span>
          </label>
          {runFirst && (
            <ol className="next-steps">
              <li>Crawl the site, up to {Number(pages) > 0 ? Number(pages) : CRAWL_PAGES.default} pages, group them by page type and check every link</li>
              <li>Check SEO, accessibility (WCAG 2.2 AA), speed and security basics on {PAGES_PER_TYPE === 1 ? "one page" : `${PAGES_PER_TYPE} pages`} of each type</li>
              <li>{platform && PACKS[platform] ? `Run the ${PACKS[platform]} check pack` : "Run the platform check pack if the platform has one"}</li>
              <li>Take the first screenshots in Chrome, Firefox and Safari as the visual baseline</li>
            </ol>
          )}
        </section>
      </div>

      <div className="dialog-foot">
        <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Creating…" : runFirst ? "Create and run first check" : "Create project"}
        </button>
      </div>
    </form>
  );
}

function PlatformBanner({ detect }: { detect: Detect }) {
  if (detect.state === "idle") return <div className="banner">The platform is detected from the website address.</div>;
  if (detect.state === "checking") return <div className="banner" role="status">Checking the website…</div>;
  if (!detect.ok) return <div className="banner" role="status">{detect.reason}. The platform will be detected on the first check.</div>;
  const pack = PACKS[detect.platform];
  if (detect.platform === "custom") return <div className="banner" role="status">No known platform detected. The general checks still run.</div>;
  return (
    <div className="banner banner-good" role="status">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: "none" }}><path d="M3 8.5l3 3 7-7" fill="none" stroke="#17703F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span>
        <strong>Platform detected:</strong> {PLATFORM_LABEL[detect.platform]}.{" "}
        {pack ? `The ${pack} check pack will be on.` : "There's no check pack for it yet; the general checks run."}
      </span>
    </div>
  );
}
