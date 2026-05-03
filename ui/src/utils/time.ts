/**
 * Timezone for all date/time display.
 * Change this constant to your local IANA timezone name (e.g. "America/Chicago").
 */
const TZ = "America/New_York";

/**
 * The API returns naive UTC timestamps without a 'Z' suffix (e.g. "2026-02-22T15:30:00").
 * JavaScript treats those as local time, not UTC. Appending 'Z' forces UTC interpretation
 * so the timezone conversion to TZ is correct.
 */
function toUtcDate(ts: string): Date {
  return new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
}

export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  return toUtcDate(ts).toLocaleString("en-US", { timeZone: TZ });
}

export function formatDate(ts: string | null | undefined): string {
  if (!ts) return "—";
  return toUtcDate(ts).toLocaleDateString("en-US", { timeZone: TZ });
}

export function formatTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  return toUtcDate(ts).toLocaleTimeString("en-US", { timeZone: TZ });
}

export { TZ };
