"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { saveTestCase, type FormState } from "../assets/actions";

type Step = { action: string; expected: string };

/** Edit a drafted test case in place: title, preconditions, test data and steps (add, remove, reorder). */
export function StepsEditor({ id, title, preconditions, testData, steps, doneHref }: { id: string; title: string; preconditions: string; testData: string; steps: Step[]; doneHref: string }) {
  const [rows, setRows] = useState<(Step & { k: number })[]>(() => steps.map((s, i) => ({ ...s, k: i })));
  const [next, setNext] = useState(steps.length);
  // Controlled, so a validation error (React resets uncontrolled fields after a form action) doesn't lose edits.
  const [fields, setFields] = useState({ title, preconditions, testData });
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const [state, action, pending] = useActionState<FormState, FormData>(saveTestCase, {});
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.push(doneHref);
  }, [state, doneHref, router]);

  const update = (k: number, field: keyof Step, value: string) => setRows((r) => r.map((x) => (x.k === k ? { ...x, [field]: value } : x)));
  const remove = (k: number) => setRows((r) => r.filter((x) => x.k !== k));
  const move = (i: number, by: number) =>
    setRows((r) => {
      const j = i + by;
      if (j < 0 || j >= r.length) return r;
      const copy = [...r];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
  const add = () => {
    setRows((r) => [...r, { action: "", expected: "", k: next }]);
    setNext((n) => n + 1);
  };

  return (
    <form action={action} className="stack" style={{ gap: 16 }}>
      <input type="hidden" name="id" value={id} />
      <div className="field">
        <label htmlFor="tc-title">Title</label>
        <input id="tc-title" name="title" className="input" value={fields.title} onChange={set("title")} required />
      </div>
      <div className="fields">
        <div className="field">
          <label htmlFor="tc-pre">Preconditions</label>
          <textarea id="tc-pre" name="preconditions" className="input" value={fields.preconditions} onChange={set("preconditions")} />
        </div>
        <div className="field">
          <label htmlFor="tc-data">Test data</label>
          <textarea id="tc-data" name="testData" className="input" value={fields.testData} onChange={set("testData")} />
        </div>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
        <legend className="kv-label" style={{ marginBottom: 8 }}>Steps</legend>
        {rows.map((r, i) => (
          <div key={r.k} className="step-row">
            <span className="num-cell">{i + 1}</span>
            <div className="field">
              <label className="sr-only" htmlFor={`a-${r.k}`}>Step {i + 1} action</label>
              <textarea id={`a-${r.k}`} name="action" className="input" placeholder="Action" value={r.action} onChange={(e) => update(r.k, "action", e.target.value)} style={{ minHeight: 60 }} />
            </div>
            <div className="field">
              <label className="sr-only" htmlFor={`e-${r.k}`}>Step {i + 1} expected result</label>
              <textarea id={`e-${r.k}`} name="expected" className="input" placeholder="Expected result" value={r.expected} onChange={(e) => update(r.k, "expected", e.target.value)} style={{ minHeight: 60 }} />
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
              <button type="button" className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => remove(r.k)}>×</button>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-outline btn-sm" onClick={add} style={{ alignSelf: "flex-start" }}>Add a step</button>
      </fieldset>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <div className="actions">
        <Link className="btn btn-outline" href={doneHref}>Cancel</Link>
        <button type="submit" className="btn btn-outline" disabled={pending}>Save</button>
        <button type="submit" name="approve" value="1" className="btn" disabled={pending}>Save and approve</button>
      </div>
    </form>
  );
}
