/**
 * Environments a project's website can be added as. Fixed for now; meant to become configurable in Settings.
 * `value` is what's stored in `environments.name`.
 */
export const ENVIRONMENT_OPTIONS = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
] as const;

export type EnvironmentName = (typeof ENVIRONMENT_OPTIONS)[number]["value"];
/** Default and range for a project's "Pages to crawl" setting. */
export const CRAWL_PAGES = { default: 200, min: 1, max: 5000 } as const;
/** Pages of each type that the accessibility, speed, SEO, security and visual checks test. Matches the checks package default. */
export const PAGES_PER_TYPE = 1;

export const ENVIRONMENT_NAMES = ENVIRONMENT_OPTIONS.map((e) => e.value) as [EnvironmentName, ...EnvironmentName[]];
