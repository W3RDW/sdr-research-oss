export type FrequencyGroup = "ham" | "emergency" | "other" | string;

interface FrequencyGroupTheme {
  label: string;
  icon: string;
  badgeClassName: string;
  panelClassName: string;
  rowClassName: string;
  barClassName: string;
  heatmapRgb: string;
}

const GROUP_THEMES: Record<string, FrequencyGroupTheme> = {
  ham: {
    label: "Ham",
    icon: "HAM",
    badgeClassName:
      "border border-emerald-700/80 bg-emerald-950/70 text-emerald-200",
    panelClassName:
      "border border-emerald-800/60 bg-emerald-950/25",
    rowClassName:
      "bg-emerald-950/12",
    barClassName: "bg-emerald-500",
    heatmapRgb: "16, 185, 129",
  },
  emergency: {
    label: "Emergency / Safety",
    icon: "911",
    badgeClassName:
      "border border-amber-700/80 bg-amber-950/70 text-amber-100",
    panelClassName:
      "border border-amber-800/60 bg-amber-950/25",
    rowClassName:
      "bg-amber-950/12",
    barClassName: "bg-amber-500",
    heatmapRgb: "245, 158, 11",
  },
  other: {
    label: "Other",
    icon: "ETC",
    badgeClassName:
      "border border-slate-700/80 bg-slate-900/80 text-slate-200",
    panelClassName:
      "border border-slate-700/70 bg-slate-900/40",
    rowClassName:
      "bg-slate-950/10",
    barClassName: "bg-slate-500",
    heatmapRgb: "148, 163, 184",
  },
};

export const FREQUENCY_GROUP_ORDER: FrequencyGroup[] = [
  "ham",
  "emergency",
  "other",
];

export function getFrequencyGroupTheme(
  group?: string | null,
): FrequencyGroupTheme {
  const normalized = (group ?? "other").toLowerCase();
  return GROUP_THEMES[normalized] ?? GROUP_THEMES.other;
}

export function getFrequencyGroupLabel(
  group?: string | null,
  fallback?: string | null,
): string {
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }
  return getFrequencyGroupTheme(group).label;
}

export function parseFrequencyLabelToHz(label?: string | null): number | null {
  if (!label) return null;
  const match = label.trim().match(/^(\d+(?:\.\d+)?)\s*MHz$/i);
  if (!match) return null;
  const mhz = Number.parseFloat(match[1]);
  if (!Number.isFinite(mhz) || mhz <= 0) return null;
  return Math.round(mhz * 1_000_000);
}
