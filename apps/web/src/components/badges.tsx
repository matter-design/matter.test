import type { Severity } from "@mattertest/core";
import { RUN_STATUS_LABEL, SEVERITY_LABEL, STATE_LABEL } from "@/lib/format";

export function SeverityPill({ severity }: { severity: Severity }) {
  return <span className={`pill sev sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function RunStatus({ status }: { status: string }) {
  return <span className={`pill status-${status}`}>{RUN_STATUS_LABEL[status] ?? status}</span>;
}

export function StatePill({ state }: { state: string }) {
  return <span className={`pill status-${state}`}>{STATE_LABEL[state] ?? state}</span>;
}
