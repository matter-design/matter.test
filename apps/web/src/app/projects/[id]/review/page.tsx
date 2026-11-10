import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { currentPlan, liveRequirements, passageLabel, passages, projectSources, sourceTitle, type Passage, type RequirementRow } from "@/lib/assets";
import { latestSiteCheck, projectWithClient } from "@/lib/queries";
import { KIND_LABEL, REVIEW_LABEL, clock, plural } from "@/lib/format";
import { reviewItem } from "../assets/actions";
import { StepsEditor } from "./StepsEditor";

export const dynamic = "force-dynamic";

type Kind = "tc" | "req" | "plan" | "story";
type Item = { kind: Kind; id: string; label: string; title: string; meta: string; state: string };

function Trace({ items, empty }: { items: Passage[]; empty: string }) {
  return (
    <div className="trace">
      <span className="trace-label">Traced to source</span>
      {!items.length && <span className="small muted">{empty}</span>}
      {items.map((p) => (
        <div key={p.id} className="stack" style={{ gap: 6 }}>
          <blockquote className="quote">{p.text.length > 700 ? `${p.text.slice(0, 700)}…` : p.text}</blockquote>
          <span className="quote-cite">
            <Link href={p.href}>{passageLabel(p)}</Link>
            {p.videoHref && <a href={p.videoHref} target="_blank" rel="noreferrer">Watch at {clock(p.locator.startSec ?? 0)}</a>}
            {p.pageHref && <a href={p.pageHref} target="_blank" rel="noreferrer">Open in Confluence</a>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Decide({ kind, id, state, editHref }: { kind: Kind; id: string; state: string; editHref?: string }) {
  const decided = state !== "needs-review" && state !== "draft";
  return (
    <form action={reviewItem} className="actions">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      {decided ? (
        <button type="submit" name="decision" value="needs-review" className="btn btn-outline">Reopen</button>
      ) : (
        <>
          <button type="submit" name="decision" value="rejected" className="btn btn-danger">Reject</button>
          {editHref && <Link className="btn btn-outline" href={editHref}>Edit steps</Link>}
          <button type="submit" name="decision" value="approved" className="btn">Approve</button>
        </>
      )}
    </form>
  );
}

export default async function ReviewInbox({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ item?: string; edit?: string; show?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await projectWithClient(id);
  if (!row) notFound();
  const { project, client } = row;
  const showAll = sp.show === "all";

  const [tree, reqs, srcs, latest] = await Promise.all([currentPlan(id), liveRequirements(id), projectSources(id), latestSiteCheck(id)]);
  const reqByKey = new Map(reqs.map((r) => [r.key, r]));
  const cases = tree?.scenarios.flatMap((s) => s.cases.map((c) => ({ ...c, scenario: s }))) ?? [];
  const pending = (state: string) => showAll || state === "needs-review" || state === "draft";

  const items: Item[] = [];
  if (tree && pending(tree.plan.status)) {
    items.push({ kind: "plan", id: tree.plan.id, label: "Test plan", title: `${tree.plan.name}, version ${tree.plan.version}`, meta: `${plural(tree.plan.body?.risks.length ?? 0, "risk area")} · ${plural(tree.scenarios.length, "scenario")}`, state: tree.plan.status });
  }
  for (const st of tree?.stories ?? []) {
    if (pending(st.reviewState))
      items.push({ kind: "story", id: st.id, label: `User story · ${st.key}`, title: st.title, meta: `${st.priority}${st.critical ? " · critical" : ""} · ${plural(tree!.scenarios.filter((x) => x.storyId === st.id).length, "scenario")}`, state: st.reviewState });
  }
  for (const c of cases) {
    if (pending(c.reviewState)) items.push({ kind: "tc", id: c.id, label: `Test case · ${c.key}`, title: c.title, meta: `${plural(c.steps.length, "step")} · ${c.scenario.priority} ${KIND_LABEL[c.scenario.kind] ?? ""}${c.automationCandidate ? " · automation candidate" : ""}`, state: c.reviewState });
  }
  for (const r of reqs) {
    if (pending(r.reviewState)) items.push({ kind: "req", id: r.id, label: `Requirement · ${r.key}`, title: r.title, meta: [r.area, plural(r.acceptanceCriteria.length, "acceptance criterion", "acceptance criteria")].filter(Boolean).join(" · "), state: r.reviewState });
  }

  const [selKind, selId] = (sp.item ?? "").split(":") as [Kind | undefined, string | undefined];
  const sel = items.find((i) => i.kind === selKind && i.id === selId) ?? (selKind && selId ? findAny(selKind, selId) : undefined) ?? items[0];
  function findAny(kind: Kind, itemId: string): Item | undefined {
    if (kind === "tc") {
      const c = cases.find((x) => x.id === itemId);
      return c && { kind, id: c.id, label: `Test case · ${c.key}`, title: c.title, meta: "", state: c.reviewState };
    }
    if (kind === "story") {
      const st = tree?.stories.find((x) => x.id === itemId);
      return st && { kind, id: st.id, label: `User story · ${st.key}`, title: st.title, meta: "", state: st.reviewState };
    }
    if (kind === "req") {
      const r = reqs.find((x) => x.id === itemId);
      return r && { kind, id: r.id, label: `Requirement · ${r.key}`, title: r.title, meta: "", state: r.reviewState };
    }
    return tree && tree.plan.id === itemId ? { kind, id: itemId, label: "Test plan", title: tree.plan.name, meta: "", state: tree.plan.status } : undefined;
  }
  const base = `/projects/${id}/review${showAll ? "?show=all&" : "?"}`;
  const hrefOf = (i: Pick<Item, "kind" | "id">) => `${base}item=${i.kind}:${i.id}`;

  // Detail data for the selected item.
  const selCase = sel?.kind === "tc" ? cases.find((c) => c.id === sel.id) : undefined;
  const selReq = sel?.kind === "req" ? reqs.find((r) => r.id === sel.id) : undefined;
  const selStory = sel?.kind === "story" ? tree?.stories.find((x) => x.id === sel.id) : undefined;
  const storyReqs: RequirementRow[] = selStory ? selStory.requirementIds.map((k) => reqByKey.get(k)).filter((r): r is RequirementRow => !!r) : [];
  const storyScenarios = selStory ? (tree?.scenarios.filter((x) => x.storyId === selStory.id) ?? []) : [];
  const storyOfCase = selCase?.scenario.storyId ? tree?.stories.find((x) => x.id === selCase.scenario.storyId) : undefined;
  const caseReqs: RequirementRow[] = selCase ? selCase.scenario.requirementIds.map((k) => reqByKey.get(k)).filter((r): r is RequirementRow => !!r) : [];
  const traceIds = selCase
    ? selCase.sourceChunkIds.length
      ? selCase.sourceChunkIds
      : caseReqs.flatMap((r) => r.sourceChunkIds)
    : selReq
      ? selReq.sourceChunkIds
      : storyReqs.flatMap((r) => r.sourceChunkIds.slice(0, 1));
  const trace = await passages(traceIds.slice(0, 4));
  const editing = sp.edit === "1" && !!selCase;

  return (
    <Shell active="review" project={{ id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <div className="page-head">
        <div>
          <span className="crumbs"><Link href={`/projects/${id}`}>{client.name}</Link> / Review inbox</span>
          <h1>Review inbox</h1>
          <span className="muted">Everything the agent drafted that needs a human yes or no. Each item links back to the passage it came from.</span>
        </div>
        <nav className="tabs" aria-label="Show">
          <Link className="tab" href={`/projects/${id}/review`} aria-current={!showAll ? "page" : undefined}>To review</Link>
          <Link className="tab" href={`/projects/${id}/review?show=all`} aria-current={showAll ? "page" : undefined}>Everything</Link>
        </nav>
      </div>

      {!sel ? (
        <div className="empty">
          {tree || reqs.length ? "Nothing waiting for review." : <>Nothing to review yet. <Link href={`/projects/${id}/assets`}>Add a source</Link> and the agent will draft requirements and test cases.</>}
        </div>
      ) : (
        <div className="review-layout">
          <section className="review-list" aria-label="Items to review">
            <span className="small muted">{plural(items.length, showAll ? "item" : "item to review", showAll ? "items" : "items to review")}</span>
            {items.map((i) => (
              <Link key={`${i.kind}:${i.id}`} className="review-item" href={hrefOf(i)} aria-current={i.kind === sel.kind && i.id === sel.id ? "true" : undefined}>
                <span className="row"><span className="review-kind">{i.label}</span><span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>{REVIEW_LABEL[i.state] ?? i.state}</span></span>
                <span className="review-title">{i.title}</span>
                <span className="review-meta">{i.meta}</span>
              </Link>
            ))}
          </section>

          <section className="review-detail panel" style={{ gap: 16, padding: 24 }}>
            {selCase && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">
                      {selCase.key}
                      {storyOfCase ? <> · <Link href={hrefOf({ kind: "story", id: storyOfCase.id })}>{storyOfCase.key} {storyOfCase.title}</Link></> : null} · {selCase.scenario.title} ({selCase.scenario.priority}, {KIND_LABEL[selCase.scenario.kind]})
                    </span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selCase.title}</h2>
                    {selCase.scenario.situation && (
                      <span className="small" style={{ color: "var(--ink-2)" }}>
                        {selCase.scenario.actor ? <strong>{selCase.scenario.actor}</strong> : null}{selCase.scenario.actor ? " " : ""}{selCase.scenario.situation}
                        {selCase.scenario.outcome ? <> → {selCase.scenario.outcome}</> : null}
                      </span>
                    )}
                  </div>
                  <span className={`pill status-${selCase.reviewState}`}>{REVIEW_LABEL[selCase.reviewState]}{selCase.edited ? " · edited" : ""}</span>
                </div>
                {editing ? (
                  <StepsEditor id={selCase.id} title={selCase.title} preconditions={selCase.preconditions} testData={selCase.testData} steps={selCase.steps} doneHref={hrefOf({ kind: "tc", id: selCase.id })} />
                ) : (
                  <>
                    <div className="kv">
                      <div><span className="kv-label">Preconditions</span><span>{selCase.preconditions || "None"}</span></div>
                      <div><span className="kv-label">Test data</span><span>{selCase.testData || "None"}</span></div>
                    </div>
                    <div className="table-wrap" style={{ border: 0 }}>
                      <table style={{ minWidth: 560 }}>
                        <thead><tr><th style={{ width: 32 }}>#</th><th>Action</th><th>Expected result</th></tr></thead>
                        <tbody>
                          {selCase.steps.map((s, i) => <tr key={i}><td className="muted">{i + 1}</td><td>{s.action}</td><td>{s.expected}</td></tr>)}
                        </tbody>
                      </table>
                    </div>
                    {caseReqs.length > 0 && (
                      <div className="stack" style={{ gap: 4 }}>
                        <span className="kv-label">Covers</span>
                        {caseReqs.map((r) => <Link key={r.id} className="small" href={hrefOf({ kind: "req", id: r.id })}>{r.key} {r.title}</Link>)}
                      </div>
                    )}
                    <Trace items={trace} empty="No passage recorded for this case." />
                    <Decide kind="tc" id={selCase.id} state={selCase.reviewState} editHref={`${hrefOf({ kind: "tc", id: selCase.id })}&edit=1`} />
                  </>
                )}
              </>
            )}

            {selStory && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">User story · {selStory.key} · {selStory.priority}{selStory.critical ? " · critical" : ""}</span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selStory.title}</h2>
                  </div>
                  <span className={`pill status-${selStory.reviewState}`}>{REVIEW_LABEL[selStory.reviewState]}</span>
                </div>
                <p className="story-text">
                  <strong>As a</strong> {selStory.actor}, <strong>I want to</strong> {selStory.want}
                  {selStory.soThat ? <>, <strong>so that</strong> {selStory.soThat}</> : null}.
                </p>
                {selStory.critical && selStory.criticalWhy && <span className="small" style={{ color: "var(--ink-2)" }}>Why it&apos;s critical: {selStory.criticalWhy}</span>}
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Acceptance criteria</span>
                  {selStory.acceptanceCriteria.length ? <ul className="ul">{selStory.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul> : <span className="small muted">None stated.</span>}
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Covers</span>
                  {storyReqs.map((r) => (
                    <Link key={r.id} className="small" href={hrefOf({ kind: "req", id: r.id })}>{r.key} {r.title}</Link>
                  ))}
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <span className="kv-label">Scenarios</span>
                  {storyScenarios.map((x) => (
                    <span key={x.id} className="row small" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
                      <span className={`pill kind-${x.kind}`}>{KIND_LABEL[x.kind] ?? x.kind}</span>
                      <span>{x.title} · {x.priority} · {plural(x.cases.length, "case")}</span>
                    </span>
                  ))}
                  {!storyScenarios.length && <span className="small muted">None yet.</span>}
                </div>
                <Trace items={trace} empty="No passage recorded." />
                <Decide kind="story" id={selStory.id} state={selStory.reviewState} />
              </>
            )}

            {selReq && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">{[selReq.key, selReq.area].filter(Boolean).join(" · ")}</span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selReq.title}</h2>
                  </div>
                  <span className={`pill status-${selReq.reviewState}`}>{REVIEW_LABEL[selReq.reviewState]}</span>
                </div>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{selReq.text}</p>
                {selReq.acceptanceCriteria.length > 0 && (
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="kv-label">Acceptance criteria</span>
                    <ul className="ul">{selReq.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </div>
                )}
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Scenarios in the current plan</span>
                  {tree?.scenarios.filter((s) => s.requirementIds.includes(selReq.key)).map((s) => (
                    <span key={s.id} className="small">{s.title} · {KIND_LABEL[s.kind] ?? s.kind} · {plural(s.cases.length, "case")}</span>
                  ))}
                  {!tree?.scenarios.some((s) => s.requirementIds.includes(selReq.key)) && <span className="small muted">None yet.</span>}
                </div>
                <Trace items={trace} empty="No passage recorded." />
                <p className="small muted" style={{ margin: 0 }}>Rejecting a requirement leaves it out of the next plan draft (Test assets › Draft the plan again).</p>
                <Decide kind="req" id={selReq.id} state={selReq.reviewState} />
              </>
            )}

            {sel.kind === "plan" && tree && (
              <>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small muted">Test plan · version {tree.plan.version}</span>
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>{tree.plan.name}</h2>
                  </div>
                  <span className={`pill status-${tree.plan.status}`}>{REVIEW_LABEL[tree.plan.status] ?? tree.plan.status}</span>
                </div>
                {tree.plan.body?.summary && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{tree.plan.body.summary}</p>}
                <div className="kv">
                  <div><span className="kv-label">In scope</span><ul className="ul">{tree.plan.body?.scope.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                  <div><span className="kv-label">Out of scope</span><ul className="ul">{tree.plan.body?.outOfScope.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <span className="kv-label">Risk ranking</span>
                  {tree.plan.body?.risks.map((r, i) => <span key={i} className="small"><b>{r.priority}</b> {r.area}: {r.why}</span>)}
                </div>
                <div className="trace">
                  <span className="trace-label">Built from</span>
                  {srcs.filter((s) => tree.plan.sourceIds.includes(s.id)).map((s) => <Link key={s.id} className="small" href={`/sources/${s.id}`}>{sourceTitle(s)}</Link>)}
                  <span className="small muted">{plural(reqs.filter((r) => r.reviewState !== "rejected").length, "requirement")} · <Link href={`/projects/${id}/assets`}>See the full plan</Link></span>
                </div>
                <Decide kind="plan" id={tree.plan.id} state={tree.plan.status} />
              </>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}
