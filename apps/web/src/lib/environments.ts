/**
 * Environments a project's website can be added as. Fixed for now; meant to become configurable in Settings.
 * `value` is what's stored in `environments.name`.
 */
export const ENVIRONMENT_OPTIONS = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
] as const;

export type EnvironmentName = (typeof ENVIRONMENT_OPTIONS)[number]["value"];
export const ENVIRONMENT_NAMES = ENVIRONMENT_OPTIONS.map((e) => e.value) as [EnvironmentName, ...EnvironmentName[]];
