import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { RunStatus } from "@/components/badges";
import { agentRuns, currentPlan, liveRequirements, passages, projectQuestions, projectSources, sourceTitle, type AgentRun, type SourceRow } from "@/lib/assets";
import { latestSiteCheck, projectWithClient } from "@/lib/queries";
import { KIND_LABEL, REVIEW_LABEL, SOURCE_STATUS_LABEL, SOURCE_TYPE_LABEL, clock, duration, plural, timeAgo, usd } from "@/lib/format";
import { checkConfluence, regeneratePlan, retrySource, updateQuestion } from "./actions";
import { AddSource, AgentInstructions, AttachTranscript, AutoRefresh } from "./SourceForms";

export const dynamic = "force-dynamic";

const TABS = ["plan", "requirements", "stories", "scenarios", "cases", "coverage", "questions"] as const;
type Tab = (typeof TABS)[number];

function sourceDetail(s: SourceRow): string {
  const m = s.meta;
  return [
    SOURCE_TYPE_LABEL[s.type] ?? s.type,
    s.version > 1 ? `version ${s.version}` : null,
    m.confluence && m.confluence.pageId !== m.confluence.rootPageId ? "child page" : null,
    m.confluence?.includeChildren ? "with child pages" : null,
    m.pages ? plural(m.pages, "page") : null,
    m.durationSec ? clock(m.durationSec) : null,
    m.owner ? `by ${m.owner}` : null,
    m.chunks ? plural(m.chunks, "passage") : null,
    m.transcriptFrom === "upload" ? "transcript uploaded" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The last Confluence add or update check: what it found, or why it failed. */
function ConfluenceStatus({ run }: { run: AgentRun }) {
  const s = (run.summary ?? {}) as { added?: number; changed?: number; unchanged?: number; failed?: number; error?: string; problems?: string[] };
  if (run.status === "queued" || run.status === "running") return null;
  const when = timeAgo(run.finishedAt ?? run.createdAt);
  if (run.status === "failed") return <span className="small" style={{ color: "var(--crit)" }}>{run.title} failed {when}: {s.error ?? "unknown error"}</span>;
  const parts = [
    s.added ? `${plural(s.added, "new page")}` : null,
    s.changed ? `${plural(s.changed, "page")} changed` : null,
    s.unchanged ? `${s.unchanged} unchanged` : null,
    s.failed ? `${s.failed} couldn't be read` : null,
  ].filter(Boolean);
  return (
    <span className="small muted">
      Confluence checked {when}: {parts.length ? parts.join(", ") : "no pages found"}.
      {s.problems?.map((p, i) => <span key={i} style={{ display: "block", color: "var(--high)" }}>{p}</span>)}
    </span>
  );
}

export default async function TestAssets({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await projectWithClient(id);
  if (!row) notFound();
  const { project, client } = row;
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "plan";

  const [srcs, reqs, tree, questions, runsList, latest] = await Promise.all([projectSources(id), liveRequirements(id), currentPlan(id), projectQuestions(id), agentRuns(id, 20), latestSiteCheck(id)]);
  const cases = tree?.scenarios.flatMap((s) => s.cases.map((c) => ({ ...c, scenario: s }))) ?? [];
  const openQuestions = questions.filter((q) => q.status === "open");
  const busy = runsList.some((r) => r.status === "queued" || r.status === "running");
  const hasConfluence = srcs.some((s) => s.type === "confluence");
  const lastConfluence = runsList.find((r) => r.confluence);
  const lastPlanRun = runsList.find((r) => r.kind === "plan");
  const inFlight = runsList.filter((r) => r.status === "queued" || r.status === "running");
  const spent = runsList.reduce((n, r) => n + r.costUsd, 0);
  const liveReqs = reqs.filter((r) => r.reviewState !== "rejected");
  const critical = new Set(tree?.plan.body?.critical?.map((c) => c.key) ?? []);
  const criticalWhy = new Map(tree?.plan.body?.critical?.map((c) => [c.key, c.why]) ?? []);
  const kindsFor = (key: string) => {
    const n = { happy: 0, negative: 0, edge: 0 } as Record<string, number>;
    for (const s of tree?.scenarios ?? []) if (s.requirementIds.includes(key)) n[s.kind] = (n[s.kind] ?? 0) + 1;
    return n;
  };
  const reqTitle = new Map(liveReqs.map((r) => [r.key, r.title]));
  const storyKinds = (storyId: string) => {
    const n = { happy: 0, negative: 0, edge: 0 } as Record<string, number>;
    for (const x of tree?.scenarios ?? []) if (x.storyId === storyId) n[x.kind] = (n[x.kind] ?? 0) + 1;
    return n;
  };
  const withPositive = liveReqs.filter((r) => kindsFor(r.key).happy).length;
  const criticalLive = liveReqs.filter((r) => critical.has(r.key));
  const withNegative = criticalLive.filter((r) => kindsFor(r.key).negative).length;

  // Passage labels for the coverage and questions tabs.
  const chunkIds = tab === "coverage" ? liveReqs.flatMap((r) => r.sourceChunkIds.slice(0, 1)) : tab === "questions" ? questions.flatMap((q) => q.sourceChunkIds.slice(0, 2)) : [];
  const where = new Map((await passages(chunkIds)).map((p) => [p.id, p]));
  const citeLabel = (ids: string[]) =>
    ids
      .map((i) => where.get(i))
      .filter(Boolean)
      .map((p) => [p!.sourceName, p!.sectionPath].filter(Boolean).join(" · "))
      .join(" and ");

  const tabs: { id: Tab; label: string }[] = [
    { id: "plan", label: "Plan" },
    { id: "requirements", label: `Requirements · ${liveReqs.length}` },
    { id: "stories", label: `User stories · ${tree?.stories.length ?? 0}` },
    { id: "scenarios", label: `Scenarios · ${tree?.scenarios.length ?? 0}` },
    { id: "cases", label: `Test cases · ${cases.length}` },
    { id: "coverage", label: "Coverage" },
    { id: "questions", label: `Questions · ${openQuestions.length}` },
  ];
  const body = tree?.plan.body;

  return (
    <Shell active="assets" project={{ id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <AutoRefresh active={busy} />
      <div className="page-head">
        <div>
          <span className="crumbs"><Link href={`/projects/${id}`}>{client.name}</Link> / Test assets</span>
          <div className="title-row">
            <h1>{project.name}</h1>
            {tree && <span className={`pill status-${tree.plan.status}`}>Plan v{tree.plan.version} · {REVIEW_LABEL[tree.plan.status] ?? tree.plan.status}</span>}
          </div>
        </div>
        <div className="row">
          <Link className="btn" href={`/projects/${id}/review`}>Review and approve</Link>
        </div>
      </div>

      <div className="assets-layout">
        <aside className="assets-side">
          <section className="panel" aria-label="Instructions for the agent">
            <AgentInstructions projectId={id} value={project.agentInstructions ?? ""} hasPlan={!!tree} />
          </section>

          <section className="panel" aria-labelledby="sources-h">
            <h2 id="sources-h" style={{ fontSize: 15 }}>Sources</h2>
            {!srcs.length && <p className="muted small" style={{ margin: 0 }}>Nothing yet. Add the client&apos;s brief, requirements document, a Confluence page or a Loom walkthrough.</p>}
            {srcs.map((s) => (
              <div key={s.id} className="source-row">
                <div className="row">
                  {s.status === "ready" ? <Link className="source-name" href={`/sources/${s.id}`}>{sourceTitle(s)}</Link> : <span className="source-name">{sourceTitle(s)}</span>}
                  <span className={`pill status-${s.status}`}>{SOURCE_STATUS_LABEL[s.status] ?? s.status}</span>
                </div>
                <span className="small muted">{sourceDetail(s)}</span>
                {s.type === "loom" && s.uri && <a className="small" href={s.uri} target="_blank" rel="noreferrer">Open in Loom</a>}
                {s.type === "confluence" && s.uri && <a className="small" href={s.meta.confluence?.webUrl ?? s.uri} target="_blank" rel="noreferrer">Open in Confluence</a>}
                {s.meta.note && <span className="small source-note">Note for the agent: {s.meta.note}</span>}
                {s.error && <span className="small" style={{ color: s.status === "failed" ? "var(--crit)" : "var(--high)" }}>{s.error}</span>}
                {s.status === "needs-transcript" && <AttachTranscript sourceId={s.id} />}
                {s.status === "failed" && (
                  <form action={retrySource}>
                    <input type="hidden" name="sourceId" value={s.id} />
                    <button type="submit" className="btn btn-outline btn-sm">Try again</button>
                  </form>
                )}
                {s.status === "ready" && (s.fileUri || s.uri) && (
                  <form action={retrySource}>
                    <input type="hidden" name="sourceId" value={s.id} />
                    <button type="submit" className="link-btn small" disabled={busy} title="Read this source again with the current instructions. Its requirements and questions are replaced, so earlier approvals on them are lost.">
                      Read again
                    </button>
                  </form>
                )}
              </div>
            ))}
            {(hasConfluence || lastConfluence) && (
              <div className="stack" style={{ gap: 6, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                {lastConfluence && <ConfluenceStatus run={lastConfluence} />}
                {hasConfluence && (
                  <form action={checkConfluence}>
                    <input type="hidden" name="projectId" value={id} />
                    <button type="submit" className="btn btn-outline btn-sm" disabled={busy}>Check Confluence for updates</button>
                  </form>
                )}
              </div>
            )}
            <AddSource projectId={id} />
          </section>

          <section className="agent-card" aria-labelledby="gen-h">
            <div className="row" style={{ gap: 8 }}><span className="tag">AGENT</span><h2 id="gen-h" style={{ fontSize: 14 }}>Generation run</h2></div>
            {inFlight.map((r) => (
              <span key={r.id} className="row small" style={{ gap: 8 }}><RunStatus status={r.status} /> {r.title}</span>
            ))}
            {lastPlanRun && lastPlanRun.status === "done" && (
              <span className="facts-line">
                {[
                  plural(liveReqs.length, "requirement"),
                  plural(tree?.scenarios.length ?? 0, "scenario"),
                  plural(cases.length, "test case"),
                  plural(openQuestions.length, "question") + " for the client",
                  `${usd(spent)} so far`,
                  duration(lastPlanRun.startedAt, lastPlanRun.finishedAt) ? `last plan took ${duration(lastPlanRun.startedAt, lastPlanRun.finishedAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {lastPlanRun?.status === "failed" && <span className="small" style={{ color: "var(--crit)" }}>The last plan run failed: {String(lastPlanRun.summary?.error ?? "unknown error")}</span>}
            {!runsList.length && <span className="facts-line">Add a source and the agent reads it, extracts requirements and drafts a plan for you to review.</span>}
            {reqs.length > 0 && (
              <form action={regeneratePlan}>
                <input type="hidden" name="projectId" value={id} />
                <button type="submit" className="btn btn-outline btn-sm" disabled={busy}>Draft the plan again</button>
              </form>
            )}
            {runsList.length > 0 && (
              <details className="small">
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Agent runs</summary>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                  {runsList.map((r) => (
                    <span key={r.id} className="muted">
                      {r.title} · {timeAgo(r.createdAt)} · {RunStatusText(r.status)}{r.costUsd ? ` · ${usd(r.costUsd)} · ${(r.inputTokens / 1000).toFixed(0)}k in / ${(r.outputTokens / 1000).toFixed(0)}k out` : ""}
                    </span>
                  ))}
                </div>
              </details>
            )}
          </section>
        </aside>

        <section className="assets-main">
          <nav className="tabs" aria-label="Asset view">
            {tabs.map((t) => (
              <Link key={t.id} className="tab" href={`/projects/${id}/assets${t.id === "plan" ? "" : `?tab=${t.id}`}`} aria-current={t.id === tab ? "page" : undefined}>{t.label}</Link>
            ))}
          </nav>

          {tab === "plan" && (
            !tree ? (
              <div className="empty">{busy ? "The agent is working on it. The plan appears here when it's ready." : "No plan yet. Add a source to get a draft."}</div>
            ) : (
              <div className="panel" style={{ gap: 18 }}>
                <div className="stack" style={{ gap: 4 }}>
                  <h2 style={{ fontSize: 16 }}>{tree.plan.name}</h2>
                  {body?.summary && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{body.summary}</p>}
                </div>
                <div className="kv">
                  <div><h3>In scope</h3><ul className="ul">{body?.scope.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                  <div><h3>Out of scope</h3>{body?.outOfScope.length ? <ul className="ul">{body.outOfScope.map((s, i) => <li key={i}>{s}</li>)}</ul> : <span className="muted">Nothing stated</span>}</div>
                </div>
                {!!body?.gaps?.length && (
                  <p className="banner" role="note" style={{ margin: 0 }}>
                    Still missing after the agent&apos;s second pass: {body.gaps.map((g) => `${g.missing} scenario for ${g.key}`).join(", ")}. The sources may not say enough; add them while reviewing, or ask the client.
                  </p>
                )}
                <h3>Risk-ranked areas</h3>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table style={{ minWidth: 560 }}>
                    <thead><tr><th>Area</th><th>Risk</th><th>Why</th><th>Priority</th></tr></thead>
                    <tbody>
                      {body?.risks.map((r, i) => (
                        <tr key={i}><td style={{ fontWeight: 600 }}>{r.area}</td><td>{r.risk[0]!.toUpperCase() + r.risk.slice(1)}</td><td style={{ color: "var(--ink-2)" }}>{r.why}</td><td><span className="pill prio">{r.priority}</span></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!!body?.critical?.length && (
                  <>
                    <h3>Critical requirements</h3>
                    <p className="small muted" style={{ margin: 0 }}>Each gets a negative scenario as well as a positive one.</p>
                    <ul className="ul">{body.critical.map((c) => <li key={c.key}><strong>{c.key}</strong> {reqTitle.get(c.key) ?? ""}: {c.why}</li>)}</ul>
                  </>
                )}
              </div>
            )
          )}

          {tab === "requirements" && (
            liveReqs.length ? (
              <div className="table-wrap">
                <table style={{ minWidth: 640 }}>
                  <thead><tr><th>Key</th><th>Requirement</th><th>Area</th><th>State</th></tr></thead>
                  <tbody>
                    {reqs.map((r) => (
                      <tr key={r.id}>
                        <td className="muted">{r.key}</td>
                        <td><Link className="cell-link" href={`/projects/${id}/review?item=req:${r.id}`}>{r.title}</Link><div className="sub">{r.text}</div></td>
                        <td>{r.area}</td>
                        <td><span className={`pill status-${r.reviewState}`}>{REVIEW_LABEL[r.reviewState]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty">No requirements yet.</div>
          )}

          {tab === "stories" && (
            tree?.stories.length ? (
              <div className="stack" style={{ gap: 12 }}>
                {tree.stories.map((st) => {
                  const scen = tree.scenarios.filter((x) => x.storyId === st.id);
                  const k = storyKinds(st.id);
                  return (
                    <article key={st.id} className="panel story-card" aria-labelledby={`st-${st.id}`}>
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                          <span className="small muted">{st.key} · covers {st.requirementIds.join(", ")}</span>
                          <Link id={`st-${st.id}`} className="list-title" href={`/projects/${id}/review?item=story:${st.id}`} style={{ textDecoration: "none", fontSize: 16 }}>{st.title}</Link>
                        </span>
                        <span className="row" style={{ gap: 6 }}>
                          <span className="pill prio">{st.priority}</span>
                          {st.critical && <span className="pill gap-pill">Critical</span>}
                          <span className={`pill status-${st.reviewState}`}>{REVIEW_LABEL[st.reviewState]}</span>
                        </span>
                      </div>
                      <p className="story-text">
                        <strong>As a</strong> {st.actor}, <strong>I want to</strong> {st.want}
                        {st.soThat ? <>, <strong>so that</strong> {st.soThat}</> : null}.
                      </p>
                      {st.critical && st.criticalWhy && <span className="small" style={{ color: "var(--ink-2)" }}>Why it&apos;s critical: {st.criticalWhy}</span>}
                      {!!st.acceptanceCriteria.length && (
                        <div className="stack" style={{ gap: 4 }}>
                          <span className="kv-label">Acceptance criteria</span>
                          <ul className="ul">{st.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                        </div>
                      )}
                      <div className="stack" style={{ gap: 6 }}>
                        <span className="kv-label">Scenarios · {[k.happy && `${k.happy} positive`, k.negative && `${k.negative} negative`, k.edge && `${k.edge} edge`].filter(Boolean).join(", ") || "none"}</span>
                        {scen.map((x) => (
                          <span key={x.id} className="row small" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
                            <span className={`pill kind-${x.kind}`}>{KIND_LABEL[x.kind] ?? x.kind}</span>
                            <span>{x.title} · {x.priority} · {plural(x.cases.length, "case")}</span>
                          </span>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : <div className="empty">{tree ? "This plan was drafted before user stories. Press Draft the plan again to add them." : "No user stories yet."}</div>
          )}

          {tab === "scenarios" && (
            tree?.scenarios.length ? (
              <div className="stack" style={{ gap: 12 }}>
                {[...tree.stories.map((st) => ({ story: st as (typeof tree.stories)[number] | null, list: tree.scenarios.filter((x) => x.storyId === st.id) })), { story: null, list: tree.scenarios.filter((x) => !x.storyId || !tree.stories.some((st) => st.id === x.storyId)) }]
                  .filter((g) => g.list.length)
                  .map((g) => (
                    <section key={g.story?.id ?? "none"} className="panel" style={{ padding: 0, gap: 0 }} aria-label={g.story ? `${g.story.key} ${g.story.title}` : "Scenarios"}>
                      {tree.stories.length > 0 && (
                        <h3 className="group-head">{g.story ? <>{g.story.key} · {g.story.title}</> : "Not linked to a story"}</h3>
                      )}
                      {g.list.map((s) => (
                        <div key={s.id} className="row" style={{ justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--rule)" }}>
                          <span className="stack" style={{ gap: 2, flex: "1 1 320px", minWidth: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 600 }}>{s.title}</span>
                            {s.situation && (
                              <span className="small" style={{ color: "var(--ink-2)" }}>
                                {s.actor && <strong>{s.actor} </strong>}
                                {s.situation}
                                {s.outcome && <> → {s.outcome}</>}
                              </span>
                            )}
                            <span className="small muted">{s.requirementIds.map((k) => (critical.has(k) ? `${k} (critical)` : k)).join(", ")} · {plural(s.cases.length, "case")}</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}><span className="pill prio">{s.priority}</span><span className={`pill kind-${s.kind}`}>{KIND_LABEL[s.kind] ?? s.kind}</span></span>
                        </div>
                      ))}
                    </section>
                  ))}
              </div>
            ) : <div className="empty">No scenarios yet.</div>
          )}

          {tab === "cases" && (
            cases.length ? (
              <div className="table-wrap">
                <table style={{ minWidth: 720 }}>
                  <thead><tr><th>ID</th><th>Test case</th><th className="num">Steps</th><th>Type</th><th>State</th></tr></thead>
                  <tbody>
                    {cases.map((c) => (
                      <tr key={c.id}>
                        <td className="muted">{c.key}</td>
                        <td><Link className="cell-link" href={`/projects/${id}/review?item=tc:${c.id}`}>{c.title}</Link><div className="sub">{c.scenario.title} · {c.scenario.priority}</div></td>
                        <td className="num">{c.steps.length}</td>
                        <td>{c.automationCandidate ? "Automation candidate" : "Manual"}</td>
                        <td><span className={`pill status-${c.reviewState}`}>{REVIEW_LABEL[c.reviewState]}{c.edited ? " · edited" : ""}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty">No test cases yet.</div>
          )}

          {tab === "coverage" && (
            liveReqs.length ? (
              <div className="panel">
                {!!tree?.stories.length && (
                  <>
                    <h3 style={{ margin: 0 }}>By user story</h3>
                    {tree.stories.map((st) => {
                      const k = storyKinds(st.id);
                      return (
                        <div key={st.id} className="list-row">
                          <span>
                            <Link className="list-title" href={`/projects/${id}/review?item=story:${st.id}`} style={{ textDecoration: "none" }}>{st.key} {st.title}</Link>
                            <span className="list-sub">{st.critical ? "Critical · " : ""}covers {st.requirementIds.join(", ")}</span>
                          </span>
                          <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            {k.happy ? <span className="pill kind-happy">{k.happy} positive</span> : <span className="pill gap-pill">No positive</span>}
                            {k.negative ? <span className="pill kind-negative">{k.negative} negative</span> : st.critical ? <span className="pill gap-pill">No negative</span> : null}
                            {k.edge ? <span className="pill kind-edge">{k.edge} edge</span> : null}
                          </span>
                        </div>
                      );
                    })}
                    <h3 style={{ margin: "12px 0 0" }}>By requirement</h3>
                  </>
                )}
                <span className="muted">
                  {withPositive} of {plural(liveReqs.length, "requirement")} have a positive scenario
                  {criticalLive.length ? `; ${withNegative} of ${criticalLive.length} critical ones have a negative scenario` : ""}. Each links back to its source passage.
                </span>
                {liveReqs.map((r) => {
                  const k = kindsFor(r.key);
                  const isCritical = critical.has(r.key);
                  const first = where.get(r.sourceChunkIds[0] ?? "");
                  return (
                    <div key={r.id} className="list-row">
                      <span>
                        <Link className="list-title" href={`/projects/${id}/review?item=req:${r.id}`} style={{ textDecoration: "none" }}>{r.key} {r.title}</Link>
                        {isCritical && <span className="list-sub">Critical: {criticalWhy.get(r.key)}</span>}
                        {first && <Link className="list-sub" href={first.href}>{citeLabel([first.id])}</Link>}
                      </span>
                      <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {k.happy ? <span className="pill kind-happy">{k.happy} positive</span> : <span className="pill gap-pill">No positive</span>}
                        {k.negative ? <span className="pill kind-negative">{k.negative} negative</span> : isCritical ? <span className="pill gap-pill">No negative</span> : null}
                        {k.edge ? <span className="pill kind-edge">{k.edge} edge</span> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : <div className="empty">No requirements yet.</div>
          )}

          {tab === "questions" && (
            questions.length ? (
              <div className="panel">
                <span className="muted">The agent found these gaps in the sources instead of guessing. Send them to the client, then record the answers here.</span>
                {questions.map((q) => (
                  <div key={q.id} className="stack" style={{ gap: 6, padding: "12px 0", borderTop: "1px solid var(--rule)" }}>
                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{q.question}</span>
                      {q.status !== "open" && <span className="pill">{q.status === "answered" ? "Answered" : "Dismissed"}</span>}
                    </div>
                    <span className="small muted">{[q.why, citeLabel(q.sourceChunkIds.slice(0, 2))].filter(Boolean).join(" · ")}</span>
                    {q.answer && <span className="small">Answer: {q.answer}</span>}
                    {q.status === "open" && (
                      <form action={updateQuestion} className="row" style={{ gap: 8 }}>
                        <input type="hidden" name="id" value={q.id} />
                        <label className="sr-only" htmlFor={`ans-${q.id}`}>Client&apos;s answer</label>
                        <input id={`ans-${q.id}`} name="answer" className="input" placeholder="Client's answer" style={{ flex: "1 1 240px", minHeight: 40 }} />
                        <button type="submit" name="status" value="answered" className="btn btn-outline btn-sm">Save answer</button>
                        <button type="submit" name="status" value="dismissed" className="btn btn-outline btn-sm">Dismiss</button>
                      </form>
                    )}
                  </div>
                ))}
                {openQuestions.length > 0 && (
                  <details>
                    <summary className="btn btn-dark btn-sm" style={{ display: "inline-flex", listStyle: "none" }}>Show as a client email</summary>
                    <pre className="evidence-pre" style={{ marginTop: 10 }}>{`Hi ${client.name} team,\n\nWhile planning testing for ${project.name} we found a few things the documents don't settle. Could you let us know:\n\n${openQuestions.map((q, i) => `${i + 1}. ${q.question}`).join("\n")}\n\nThanks!`}</pre>
                  </details>
                )}
              </div>
            ) : <div className="empty">No questions for the client.</div>
          )}
        </section>
      </div>
    </Shell>
  );
}

function RunStatusText(status: string) {
  return { queued: "queued", running: "running", done: "done", failed: "failed", "needs-review": "needs input" }[status] ?? status;
}
