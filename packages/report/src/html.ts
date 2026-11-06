import { rate, SEVERITIES, type PerfMetricName, type Severity } from "@mattertest/core";
import { CATEGORY_COPY } from "./copy";
import { pageLabel, templateLabel, type IssueGroup, type ReportModel, type ReportPerf } from "./model";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only allow a plain hex colour from client branding into the stylesheet. */
const safeColour = (c: string | undefined, fallback: string) => (c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback);
const safeUrl = (u: string | undefined) => (u && /^https:\/\//i.test(u) ? u : undefined);

const SEV_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
const sevPill = (s: Severity) => `<span class="sev sev-${s}">${SEV_LABEL[s]}</span>`;

function metricCell(metric: PerfMetricName, v: number | null | undefined): string {
  if (v === null || v === undefined) return `<td class="num muted">–</td>`;
  const r = rate(metric, v);
  const txt = metric === "cls" ? v.toFixed(2) : metric === "interaction" || metric === "tbt" || metric === "ttfb" ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
  return `<td class="num"><span class="rt rt-${r}">${txt}</span></td>`;
}

function scoreCell(score: number | null): string {
  if (score === null) return `<td class="num muted">–</td>`;
  const r = score >= 90 ? "good" : score >= 50 ? "needs-improvement" : "poor";
  return `<td class="num"><span class="rt score rt-${r}">${score}</span></td>`;
}

function issueCard(g: IssueGroup): string {
  const where = g.pages === 1 ? "1 page" : `${g.pages} pages`;
  const examples = g.examples.slice(0, 3).map((e) => `<li><span class="url">${esc(pageLabel(e.url))}</span>${e.selector && !e.selector.startsWith("http") && e.selector !== pageLabel(e.url) ? ` <span class="sel">${esc(e.selector.slice(0, 80))}</span>` : ""}${e.detail ? ` <span class="muted">${esc(e.detail.slice(0, 110))}</span>` : ""}</li>`).join("");
  return `<div class="issue">
    <div class="issue-head">${sevPill(g.severity)}<h4>${esc(g.label)}</h4><span class="muted where">${where}${g.count > g.pages ? ` · ${g.count} instances` : ""}${g.wcag ? ` · WCAG ${esc(g.wcag)}` : ""}${g.newCount ? ` · <b>${g.newCount} new</b>` : ""}</span></div>
    ${g.why ? `<p><b>Why it matters.</b> ${esc(g.why)}</p>` : ""}
    ${g.fix ? `<p><b>What to do.</b> ${esc(g.fix)}</p>` : ""}
    ${examples ? `<ul class="examples">${examples}</ul>${g.examples.length > 3 ? `<p class="muted small">All ${g.examples.length} listed in the appendix.</p>` : ""}` : ""}
  </div>`;
}

function issueTable(groups: IssueGroup[]): string {
  if (!groups.length) return `<p class="ok">No issues found in this area.</p>`;
  return `<table class="issues"><thead><tr><th style="width:84px">Priority</th><th>Issue</th><th class="num" style="width:70px">Pages</th></tr></thead><tbody>
    ${groups.map((g) => `<tr><td>${sevPill(g.severity)}</td><td><b>${esc(g.label)}</b>${g.fix ? `<div class="muted small">${esc(g.fix)}</div>` : ""}</td><td class="num">${g.pages}</td></tr>`).join("")}
  </tbody></table>`;
}

function perfSection(m: ReportModel): string {
  const rows = m.perfByTemplate;
  if (!rows.length) return "";
  const profile = m.input.perfProfile ?? "mobile";
  const anyInteraction = rows.some((r) => r.interaction);
  const anyLighthouse = rows.some((r) => r.engine !== "browser");
  const perfGroups = m.groups.filter((g) => g.category === "performance");
  const insights = rows
    .filter((r) => r.insights?.length)
    .map((r) => `<li><b>${esc(templateLabel(r.template))}</b>: ${r.insights!.slice(0, 3).map((i) => `${esc(i.title)}${i.displayValue ? ` <span class="muted">(${esc(i.displayValue)})</span>` : ""}`).join("; ")}</li>`)
    .join("");
  return `<section class="page-break">
    <h2>${esc(CATEGORY_COPY.performance!.label)}</h2>
    <p class="intro">${anyLighthouse ? `Measured with Google Lighthouse, the engine behind PageSpeed Insights, using its ${profile === "desktop" ? "desktop" : "mobile"} profile` : "Measured in a real browser"} on one representative page of each type. Scores are out of 100; colours follow Google's thresholds.</p>
    <table class="perf"><thead><tr><th>Page type</th><th class="num">Score</th><th class="num" title="Largest Contentful Paint">Main content<br><span class="muted small">LCP</span></th><th class="num">Layout shift<br><span class="muted small">CLS</span></th><th class="num">Busy time<br><span class="muted small">TBT</span></th>${anyInteraction ? `<th class="num">Tap response<br><span class="muted small">lab</span></th>` : ""}</tr></thead><tbody>
    ${rows.map((r: ReportPerf & { pageLabel: string }) => `<tr><td><b>${esc(templateLabel(r.template))}</b><div class="muted small url">${esc(r.pageLabel)}</div></td>${scoreCell(r.score)}${metricCell("lcp", r.lcp)}${metricCell("cls", r.cls)}${metricCell("tbt", r.tbt)}${anyInteraction ? metricCell("interaction", r.interaction?.latency) : ""}</tr>`).join("")}
    </tbody></table>
    <p class="legend"><span class="rt rt-good">Good</span> <span class="rt rt-needs-improvement">Needs improvement</span> <span class="rt rt-poor">Poor</span></p>
    ${insights ? `<h3>Biggest opportunities</h3><ul class="insights">${insights}</ul>` : ""}
    ${perfGroups.length ? `<h3>Speed issues</h3>${issueTable(perfGroups)}` : ""}
    <p class="note">These are lab results from a single load on a simulated device. Google's ranking uses data from real Chrome visitors (the Chrome UX Report), which can differ. Use these numbers to compare pages and track changes over time.${anyInteraction ? " The tap-response figure times one scripted click (such as opening a menu) and indicates, but is not, Google's Interaction to Next Paint (INP) measure." : ""}</p>
  </section>`;
}

function a11ySection(m: ReportModel): string {
  if (!m.input.categoriesRun.includes("accessibility")) return "";
  const groups = m.groups.filter((g) => g.category === "accessibility");
  return `<section class="page-break">
    <h2>${esc(CATEGORY_COPY.accessibility!.label)}</h2>
    <p class="intro">${esc(CATEGORY_COPY.accessibility!.intro)} Automated tools find only part of the accessibility problems on a site, so a clean result here does not mean the site is fully accessible. Manual testing with a keyboard and screen reader is still needed.</p>
    ${groups.length ? `<table class="issues"><thead><tr><th style="width:90px">WCAG</th><th>Issue</th><th style="width:84px">Priority</th><th class="num" style="width:70px">Pages</th></tr></thead><tbody>
      ${m.wcag.flatMap((w) => w.groups.map((g, i) => `<tr>${i === 0 ? `<td rowspan="${w.groups.length}"><b>${esc(w.criterion)}</b></td>` : ""}<td><b>${esc(g.label)}</b><div class="muted small">${esc(g.fix)}</div></td><td>${sevPill(g.severity)}</td><td class="num">${g.pages}</td></tr>`)).join("")}
    </tbody></table>` : `<p class="ok">No automated accessibility issues found on the sampled pages.</p>`}
  </section>`;
}

const BROWSER_NAME: Record<string, string> = { chromium: "Chrome", firefox: "Firefox", webkit: "Safari" };
const VIEWPORT_NAME: Record<string, string> = { mobile: "Phone", tablet: "Tablet", desktop: "Desktop" };

/** One cell of the browser x device grid: the most important thing about that capture. */
function matrixCell(c: import("./visual").ReportCapture | undefined): string {
  if (!c) return `<td class="mx muted">–</td>`;
  if (c.status === "error") return `<td class="mx"><span class="mxb bad">Failed</span></td>`;
  const issues: [string, string][] = [];
  if (c.jsErrors.length) issues.push(["bad", "JS error"]);
  if (c.overflowPx > 1) issues.push(["bad", "Scrolls sideways"]);
  if (c.status === "changed") issues.push(["warn", `Changed ${((c.diffRatio ?? 0) * 100).toFixed(1)}%`]);
  if (!issues.length) return `<td class="mx">${c.status === "baseline-created" ? `<span class="mxb new">Baseline</span>` : `<span class="mxb ok">OK</span>`}</td>`;
  return `<td class="mx">${issues.map(([k, t]) => `<span class="mxb ${k}">${t}</span>`).join("")}</td>`;
}

function visualSection(m: ReportModel): string {
  const v = m.input.visual;
  if (!v || !m.input.categoriesRun.includes("visual")) return "";
  const pages = [...new Map(v.captures.map((c) => [c.url, c.template])).entries()];
  const cols = v.browsers.flatMap((b) => v.viewports.map((vp) => [b, vp] as const));
  const find = (url: string, b: string, vp: string) => v.captures.find((c) => c.url === url && c.browser === b && c.viewport === vp);
  const firstRun = v.captures.length > 0 && v.captures.every((c) => c.status === "baseline-created" || c.status === "error");
  const groups = m.groups.filter((g) => g.category === "visual");
  const changes = v.changes ?? [];
  return `<section class="page-break">
    <h2>${esc(CATEGORY_COPY.visual!.label)}</h2>
    <p class="intro">${esc(CATEGORY_COPY.visual!.intro)}</p>
    <table class="matrix"><thead>
      <tr><th rowspan="2">Page type</th>${v.browsers.map((b) => `<th colspan="${v.viewports.length}" class="grp">${esc(BROWSER_NAME[b] ?? b)}</th>`).join("")}</tr>
      <tr>${cols.map(([, vp]) => `<th class="mx">${esc(VIEWPORT_NAME[vp] ?? vp)}</th>`).join("")}</tr>
    </thead><tbody>
      ${pages.map(([url, t]) => `<tr><td><b>${esc(templateLabel(t))}</b><div class="muted small url">${esc(pageLabel(url))}</div></td>${cols.map(([b, vp]) => matrixCell(find(url, b, vp))).join("")}</tr>`).join("")}
    </tbody></table>
    ${firstRun ? `<p class="note">This was the first check, so these screenshots are now the approved baseline. Future checks will compare against them and show what changed.</p>` : ""}
    ${v.skippedBrowsers?.length ? `<p class="muted small">Not tested: ${v.skippedBrowsers.map((s) => esc(BROWSER_NAME[s.browser] ?? s.browser)).join(", ")} (browser unavailable on the test machine).</p>` : ""}
    ${changes.length ? `<h3>What changed</h3>${changes.map((c) => `<div class="change"><p><b>${esc(templateLabel(c.template))}</b> <span class="muted small">${esc(pageLabel(c.url))} · ${esc(BROWSER_NAME[c.browser] ?? c.browser)} ${esc((VIEWPORT_NAME[c.viewport] ?? c.viewport).toLowerCase())} · ${(c.diffRatio * 100).toFixed(1)}% of the page</span></p>
      <div class="ba"><figure><img src="${c.before}" alt="Approved version"><figcaption>Approved</figcaption></figure><figure><img src="${c.after}" alt="This check"><figcaption>Now</figcaption></figure></div></div>`).join("")}` : ""}
    ${groups.length ? `<h3>Issues</h3>${issueTable(groups)}` : ""}
  </section>`;
}

function categorySection(m: ReportModel, cat: "seo" | "links" | "crawl" | "security" | "platform"): string {
  if (!m.input.categoriesRun.includes(cat)) return "";
  const copy = CATEGORY_COPY[cat]!;
  const label = cat === "platform" ? `${platformName(m.input.platform)} checks` : copy.label;
  return `<section class="keep">
    <h2>${esc(label)}</h2>
    <p class="intro">${esc(copy.intro)}</p>
    ${issueTable(m.groups.filter((g) => g.category === cat))}
  </section>`;
}

function otherAreas(m: ReportModel): string {
  const html = (["platform", "seo", "links", "crawl", "security"] as const).map((c) => categorySection(m, c)).join("");
  return html ? `<div class="page-break">${html}</div>` : "";
}

const platformName = (p: string) => ({ bigcommerce: "BigCommerce", shopify: "Shopify", wordpress: "WordPress", laravel: "Laravel", nextjs: "Next.js" })[p] ?? "Platform";

function appendix(m: ReportModel): string {
  if (!m.groups.length) return "";
  return `<section class="page-break appendix">
    <h2>Appendix: every issue and where it was found</h2>
    <p class="intro">Grouped by issue. Up to 40 pages are listed per issue; your Matter Design team has the full list.</p>
    ${m.groups.map((g) => `<div class="app-group"><h4>${sevPill(g.severity)} ${esc(g.label)} <span class="muted small">${esc(g.rule)}${g.wcag ? ` · WCAG ${esc(g.wcag)}` : ""}</span></h4>
      <ul>${g.examples.slice(0, 40).map((e) => `<li><span class="url">${esc(e.url)}</span>${e.selector && e.selector !== pageLabel(e.url) ? ` <span class="sel">${esc(e.selector.slice(0, 120))}</span>` : ""}</li>`).join("")}${g.examples.length > 40 ? `<li class="muted">and ${g.examples.length - 40} more</li>` : ""}</ul></div>`).join("")}
  </section>`;
}

export function renderReportHtml(m: ReportModel): string {
  const i = m.input;
  const primary = safeColour(i.client.branding?.primary, "#1d2939");
  const accent = safeColour(i.client.branding?.accent, "#2e5bd8");
  const logo = safeUrl(i.client.branding?.logoUrl);
  const date = i.run.finishedAt.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const templates = Object.entries(i.templates).sort((a, b) => b[1] - a[1]);
  const preparedBy = i.preparedBy ?? "Matter Design";

  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>${esc(i.client.name)} · Website health check · ${esc(date)}</title>
<style>
  :root { --ink: #1d2939; --muted: #667085; --line: #e4e7ec; --soft: #f7f8fa; --primary: ${primary}; --accent: ${accent};
    --critical: #b42318; --high: #c4320a; --medium: #b54708; --low: #475467; --info: #667085;
    --good: #067647; --good-bg: #ecfdf3; --ni: #b54708; --ni-bg: #fffaeb; --poor: #b42318; --poor-bg: #fef3f2; }
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: var(--ink); font: 10pt/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1, h2, h3, h4 { line-height: 1.2; margin: 0; }
  h2 { font-size: 16pt; margin: 0 0 6px; color: var(--primary); }
  h3 { font-size: 11.5pt; margin: 18px 0 8px; }
  h4 { font-size: 10.5pt; }
  p { margin: 6px 0; }
  section { margin-top: 26px; }
  .page-break { break-before: page; margin-top: 0; }
  .page-break > section:first-child { margin-top: 0; }
  .keep { break-inside: avoid; }
  .intro { color: var(--muted); max-width: 150mm; margin-bottom: 12px; }
  .muted { color: var(--muted); } .small { font-size: 8.5pt; }
  .url { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8.5pt; word-break: break-all; }
  .sel { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 8pt; color: var(--muted); background: var(--soft); padding: 0 4px; border-radius: 3px; word-break: break-all; }

  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
  .cover .brand { display: flex; align-items: center; gap: 12px; }
  .cover .brand img { max-height: 44px; max-width: 180px; }
  .cover .brand .name { font-size: 13pt; font-weight: 600; }
  .cover .title { border-left: 6px solid var(--accent); padding-left: 18px; }
  .cover .eyebrow { text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-size: 9pt; font-weight: 600; }
  .cover h1 { font-size: 30pt; margin: 6px 0 10px; color: var(--primary); }
  .cover .site { font-size: 12pt; }
  .cover dl { display: grid; grid-template-columns: 38mm 1fr; gap: 4px 12px; margin: 0; font-size: 9.5pt; }
  .cover dt { color: var(--muted); } .cover dd { margin: 0; }

  .headline { font-size: 12.5pt; font-weight: 600; margin: 4px 0 16px; max-width: 160mm; }
  .tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 18px; }
  .tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .tile .n { font-size: 20pt; font-weight: 700; line-height: 1.1; }
  .tile .l { font-size: 8.5pt; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
  .tile.critical .n { color: var(--critical); } .tile.high .n { color: var(--high); } .tile.medium .n { color: var(--medium); }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); font-size: 9pt; margin-bottom: 14px; }
  .facts b { color: var(--ink); font-weight: 600; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; border-bottom: 1.5px solid var(--ink); padding: 6px 8px; vertical-align: bottom; }
  td { border-bottom: 1px solid var(--line); padding: 7px 8px; vertical-align: top; }
  tr { break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  table.counts td.num { font-variant-numeric: tabular-nums; }
  table.counts td.zero { color: #c0c5cc; }

  .sev { display: inline-block; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 2px 7px; border-radius: 99px; color: #fff; white-space: nowrap; }
  .sev-critical { background: var(--critical); } .sev-high { background: var(--high); } .sev-medium { background: var(--medium); }
  .sev-low { background: #eaecf0; color: var(--low); } .sev-info { background: #f2f4f7; color: var(--info); }

  .rt { display: inline-block; padding: 1px 7px; border-radius: 4px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .rt-good { color: var(--good); background: var(--good-bg); } .rt-needs-improvement { color: var(--ni); background: var(--ni-bg); } .rt-poor { color: var(--poor); background: var(--poor-bg); }
  .score { min-width: 32px; text-align: center; border-radius: 99px; }
  .legend { font-size: 8.5pt; margin-top: 8px; } .legend .rt { margin-right: 6px; font-weight: 500; }

  .issue { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; break-inside: avoid; }
  .issue-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .issue-head .where { font-size: 8.5pt; margin-left: auto; }
  .issue p { font-size: 9.5pt; }
  .examples { margin: 6px 0 0; padding-left: 16px; } .examples li { margin: 1px 0; }
  .ok { color: var(--good); font-weight: 600; }
  .note { margin-top: 14px; padding: 10px 12px; background: var(--soft); border-radius: 6px; font-size: 8.5pt; color: var(--muted); }
  .insights { padding-left: 16px; } .insights li { margin: 3px 0; }

  table.matrix { font-size: 8pt; }
  table.matrix th.grp { text-align: center; border-bottom: 1px solid var(--line); }
  table.matrix th.mx, table.matrix td.mx { text-align: center; padding: 6px 3px; }
  .mxb { display: block; font-size: 7pt; font-weight: 600; border-radius: 4px; padding: 1px 3px; margin: 1px 0; white-space: nowrap; }
  .mxb.ok { color: var(--good); background: var(--good-bg); } .mxb.warn { color: var(--ni); background: var(--ni-bg); }
  .mxb.bad { color: var(--poor); background: var(--poor-bg); } .mxb.new { color: var(--muted); background: var(--soft); }
  .change { break-inside: avoid; margin-bottom: 14px; }
  .ba { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .ba figure { margin: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .ba img { display: block; width: 100%; max-height: 90mm; object-fit: contain; object-position: top left; background: var(--soft); }
  .ba figcaption { font-size: 8pt; color: var(--muted); padding: 3px 8px; border-top: 1px solid var(--line); }
  .appendix .app-group { margin-bottom: 12px; break-inside: avoid-page; }
  .appendix h4 { margin-bottom: 4px; }
  .appendix ul { margin: 0; padding-left: 16px; columns: 1; }
  .appendix li { font-size: 8.5pt; margin: 1px 0; }
</style></head><body>

<div class="cover">
  <div class="brand">${logo ? `<img src="${esc(logo)}" alt="${esc(i.client.name)} logo">` : `<span class="name">${esc(i.client.name)}</span>`}</div>
  <div class="title">
    <div class="eyebrow">Website health check</div>
    <h1>${esc(i.project.name)}</h1>
    <div class="site url" style="font-size:11pt">${esc(i.environment.baseUrl)}</div>
  </div>
  <dl>
    <dt>Prepared for</dt><dd>${esc(i.client.name)}</dd>
    <dt>Prepared by</dt><dd>${esc(preparedBy)}</dd>
    <dt>Date</dt><dd>${esc(date)}</dd>
    ${i.environment.name ? `<dt>Environment</dt><dd>${esc(i.environment.name)}</dd>` : ""}
    <dt>Pages checked</dt><dd>${i.pagesChecked}</dd>
    ${i.run.id ? `<dt>Reference</dt><dd class="muted">${esc(i.run.id.slice(0, 8))}</dd>` : ""}
  </dl>
</div>

<section style="margin-top:0">
  <h2>Summary</h2>
  <p class="headline">${esc(m.headline)}</p>
  <div class="tiles">${SEVERITIES.map((s) => `<div class="tile ${s}"><div class="n">${m.bySeverity[s]}</div><div class="l">${SEV_LABEL[s]}</div></div>`).join("")}</div>
  <div class="facts">
    <span>Platform <b>${esc(i.platform === "custom" ? "Custom" : platformName(i.platform))}</b></span>
    <span>Pages checked <b>${i.pagesChecked}</b></span>
    <span>Page types <b>${templates.map(([t, n]) => `${esc(templateLabel(t))} (${n})`).join(", ") || "–"}</b></span>
    ${m.groups.some((g) => g.newCount) ? `<span>New since last check <b>${m.groups.reduce((a, g) => a + g.newCount, 0)}</b></span>` : ""}
    ${i.possiblyFixed ? `<span>Possibly fixed since last check <b>${i.possiblyFixed}</b></span>` : ""}
  </div>
  <table class="counts"><thead><tr><th>Area</th>${SEVERITIES.map((s) => `<th class="num">${SEV_LABEL[s]}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>
    ${m.byCategory.map((c) => `<tr><td><b>${esc(c.category === "platform" ? `${platformName(i.platform)} checks` : CATEGORY_COPY[c.category]?.label ?? c.category)}</b></td>${SEVERITIES.map((s) => `<td class="num ${c.counts[s] ? "" : "zero"}">${c.counts[s]}</td>`).join("")}<td class="num"><b>${c.total}</b></td></tr>`).join("")}
  </tbody></table>
  <p class="muted small" style="margin-top:8px">Critical and High items affect visitors, sales or search visibility now. Medium items are worth scheduling. Low and Info items are polish.</p>
</section>

${m.priorities.length ? `<section class="page-break"><h2>Fix these first</h2><p class="intro">The most important issues, worst first. Each one is grouped across every page it appears on.</p>${m.priorities.map(issueCard).join("")}</section>` : ""}

${perfSection(m)}
${a11ySection(m)}
${visualSection(m)}
${otherAreas(m)}
${appendix(m)}
</body></html>`;
}
