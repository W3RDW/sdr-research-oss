import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  getStats,
  getSdrHealth,
  getSpotStats,
  getSpotBands,
  browseFiles,
  listAprsStations,
  getActivityHeatmap,
  Recording,
  SdrHealth,
  SpotStats,
  BandActivity,
  ActivitySeries,
  StatsResponse,
  FrequencyCount,
  RecordingEvent,
  buildEventStreamUrl,
} from "../api/client";
import { formatTime } from "../utils/time";
import {
  FREQUENCY_GROUP_ORDER,
  getFrequencyGroupLabel,
  getFrequencyGroupTheme,
  parseFrequencyLabelToHz,
} from "../utils/frequencyGroups";

// ── Helpers ──────────────────────────────────────────────────────────

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function relativeTime(seconds: number | null): string {
  if (seconds == null) return "never";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const MODE_COLORS: Record<string, string> = {
  voice: "bg-blue-900 text-blue-200",
  cw: "bg-yellow-900 text-yellow-200",
  aprs: "bg-green-900 text-green-200",
  hfdl: "bg-cyan-900 text-cyan-200",
  acars: "bg-cyan-900 text-cyan-200",
  vdl2: "bg-cyan-900 text-cyan-200",
  pager: "bg-red-900 text-red-200",
  eas: "bg-red-900 text-red-200",
  sstv: "bg-purple-900 text-purple-200",
  ft8: "bg-orange-900 text-orange-200",
  wspr: "bg-amber-900 text-amber-200",
};

function ModeBadge({ mode }: { mode: string }) {
  const cls = MODE_COLORS[mode] ?? "bg-gray-700 text-gray-300";
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wide ${cls}`}>
      {mode}
    </span>
  );
}

function SignalBadge({ db }: { db: number | null }) {
  if (db == null) return null;
  const cls =
    db > -20
      ? "text-green-400"
      : db > -40
        ? "text-yellow-400"
        : "text-red-400";
  return <span className={`font-mono text-[10px] ${cls}`}>{db.toFixed(0)} dB</span>;
}

function FrequencyGroupBadge({
  group,
  label,
  compact = false,
}: {
  group?: string | null;
  label?: string | null;
  compact?: boolean;
}) {
  const theme = getFrequencyGroupTheme(group);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${theme.badgeClassName}`}
    >
      {compact ? theme.icon : getFrequencyGroupLabel(group, label)}
    </span>
  );
}

function getFrequencyTarget(entry: FrequencyCount): string | null {
  const hz = entry.frequency_hz ?? parseFrequencyLabelToHz(entry.label);
  if (hz) return `/frequency/${hz}`;
  // Named labels like "APRS 2m"
  if (entry.label?.toLowerCase().includes("aprs")) return "/aprs";
  // Grouped entries — link to browse filtered by frequency group
  if (entry.is_grouped && entry.frequency_group)
    return `/browse?group=${encodeURIComponent(entry.frequency_group)}`;
  return null;
}

// ── Band Status Card ─────────────────────────────────────────────────

function BandStatusCard({
  label,
  band,
  health,
  isLoading,
}: {
  label: string;
  band: string;
  health: SdrHealth | undefined;
  isLoading: boolean;
}) {
  const healthy = health?.healthy ?? false;
  const statusText = isLoading
    ? "Checking..."
    : health
      ? health.status
      : "Unavailable";
  const lastSeen = health?.last_seen_seconds;

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-200">{label}</h3>
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              isLoading
                ? "bg-gray-500 animate-pulse"
                : healthy
                  ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]"
                  : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]"
            }`}
          />
          <span className={`text-xs font-medium ${healthy ? "text-green-400" : "text-red-400"}`}>
            {healthy ? "ON AIR" : "OFFLINE"}
          </span>
        </div>
      </div>
      <div className="text-xs text-gray-500">{statusText}</div>
      {lastSeen != null && (
        <div className="text-xs text-gray-500 mt-1">
          Last signal: {relativeTime(lastSeen)}
        </div>
      )}
      <div className="text-[10px] text-gray-600 mt-1 uppercase tracking-wider">{band}</div>
    </div>
  );
}

function HfStatusCard({
  spotBands,
  isLoading,
}: {
  spotBands: BandActivity[] | undefined;
  isLoading: boolean;
}) {
  const activeBands = spotBands?.filter((b) => b.count > 0) ?? [];
  const totalSpots = activeBands.reduce((s, b) => s + b.count, 0);

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-200">HF Bands</h3>
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              isLoading
                ? "bg-gray-500 animate-pulse"
                : activeBands.length > 0
                  ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]"
                  : "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.6)]"
            }`}
          />
          <span className={`text-xs font-medium ${activeBands.length > 0 ? "text-green-400" : "text-yellow-400"}`}>
            {activeBands.length > 0 ? `${activeBands.length} OPEN` : "QUIET"}
          </span>
        </div>
      </div>
      <div className="text-xs text-gray-500">
        {isLoading
          ? "Checking propagation..."
          : `${totalSpots} spots in last hour`}
      </div>
      {activeBands.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {activeBands.slice(0, 8).map((b) => (
            <span
              key={`${b.band}-${b.mode}`}
              className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300 font-mono"
            >
              {b.band}
            </span>
          ))}
        </div>
      )}
      <div className="text-[10px] text-gray-600 mt-1 uppercase tracking-wider">
        FT8 / WSPR Propagation
      </div>
    </div>
  );
}

// ── Live Activity Feed ───────────────────────────────────────────────

function useLiveRecordings(initialRecordings: Recording[] | undefined) {
  const [liveItems, setLiveItems] = useState<Recording[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef(new Set<number>());

  useEffect(() => {
    if (initialRecordings) {
      initialRecordings.forEach((r) => seenIds.current.add(r.id));
    }
  }, [initialRecordings]);

  useEffect(() => {
    const url = buildEventStreamUrl({ mode: "voice" });
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const evt: RecordingEvent = JSON.parse(e.data);
        if (!evt.has_transcript) return;
        if (seenIds.current.has(evt.id)) return;
        seenIds.current.add(evt.id);
        // Convert event to a minimal Recording for display
        const rec: Recording = {
          id: evt.id,
          mode: evt.mode,
          frequency_hz: evt.frequency_hz,
          frequency_label: evt.frequency_label,
          timestamp: evt.timestamp,
          duration_seconds: evt.duration_seconds,
          signal_db: evt.signal_db,
          callsign_tags: evt.callsign_tags,
          ai_tags: evt.ai_tags,
          has_transcript: evt.has_transcript,
        } as Recording;
        setLiveItems((prev) => [rec, ...prev].slice(0, 20));
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, []);

  // Merge: live items first, then initial (deduped)
  const merged = [...liveItems];
  if (initialRecordings) {
    for (const r of initialRecordings) {
      if (!liveItems.some((l) => l.id === r.id)) merged.push(r);
    }
  }
  return { recordings: merged.slice(0, 15), connected };
}

function LiveActivityFeed({ recordings, isLoading, connected }: { recordings: Recording[]; isLoading: boolean; connected: boolean }) {
  if (isLoading && recordings.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 bg-gray-700/50 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (recordings.length === 0) {
    return <div className="text-gray-500 text-sm py-4">No recent recordings</div>;
  }

  return (
    <div className="space-y-1">
      {recordings.map((rec, i) => (
        <Link
          key={rec.id}
          to={`/player/${rec.id}`}
          className={`flex items-center gap-3 px-3 py-2 rounded-md hover:bg-gray-700/60 transition-all group ${
            i === 0 && connected ? "animate-[fadeIn_0.5s_ease-out]" : ""
          }`}
        >
          <div className="shrink-0">
            <ModeBadge mode={rec.mode} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FrequencyGroupBadge
                group={rec.frequency_group}
                label={rec.frequency_group_label}
                compact
              />
              <span className="text-sm text-gray-200 truncate font-mono">
                {rec.frequency_label ?? formatFrequency(rec.frequency_hz)}
              </span>
              <SignalBadge db={rec.signal_db ?? null} />
            </div>
            <div className="text-[11px] text-gray-500 truncate">
              {rec.callsign_tags && rec.callsign_tags.length > 0
                ? rec.callsign_tags.join(", ")
                : rec.transcript
                  ? rec.transcript.slice(0, 60) + (rec.transcript.length > 60 ? "..." : "")
                  : ""}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[11px] text-gray-400 font-mono">
              {formatTime(rec.timestamp)}
            </div>
            <div className="text-[10px] text-gray-600">
              {formatDuration(rec.duration_seconds)}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

// ── HF Band Conditions Panel ─────────────────────────────────────────

interface BandConditionRow {
  band: string;
  count: number;
  farthest_km: number;
}

function HfBandConditions({
  spotStats,
  isLoading,
}: {
  spotStats: SpotStats | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 bg-gray-700/50 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (!spotStats || spotStats.total_spots === 0) {
    return (
      <div className="text-gray-500 text-sm py-4">
        No FT8/WSPR spots in the last hour. HF decoder may be offline.
      </div>
    );
  }

  // Build band rows, merging modes and finding farthest distance per band
  const bandMap = new Map<string, BandConditionRow>();
  for (const entry of spotStats.by_band) {
    const existing = bandMap.get(entry.band);
    if (existing) {
      existing.count += entry.count;
    } else {
      bandMap.set(entry.band, { band: entry.band, count: entry.count, farthest_km: 0 });
    }
  }

  // Try to find farthest distance per band from the farthest spots
  for (const spot of spotStats.farthest ?? []) {
    if (spot.band && spot.distance_km) {
      const row = bandMap.get(spot.band);
      if (row && spot.distance_km > row.farthest_km) {
        row.farthest_km = spot.distance_km;
      }
    }
  }

  const bands = Array.from(bandMap.values()).sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...bands.map((b) => b.count), 1);

  // Also build data for Recharts bar chart
  const chartData = bands.map((b) => ({
    band: b.band,
    spots: b.count,
    fill:
      b.count > 5
        ? "#22c55e"
        : b.count > 0
          ? "#eab308"
          : "#4b5563",
  }));

  return (
    <div>
      {/* Mini bar chart */}
      <div className="h-32 mb-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <XAxis
              dataKey="band"
              tick={{ fill: "#9ca3af", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#6b7280", fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "6px",
                fontSize: "12px",
              }}
              labelStyle={{ color: "#e5e7eb" }}
            />
            <Bar dataKey="spots" radius={[3, 3, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Band table */}
      <div className="space-y-1">
        {bands.map((b) => {
          const pct = Math.round((b.count / maxCount) * 100);
          const statusColor =
            b.count > 5
              ? "text-green-400"
              : b.count > 0
                ? "text-yellow-400"
                : "text-gray-600";
          const barColor =
            b.count > 5
              ? "bg-green-600"
              : b.count > 0
                ? "bg-yellow-600"
                : "bg-gray-700";
          return (
            <div key={b.band} className="flex items-center gap-2 text-xs">
              <span className={`w-12 font-mono font-semibold ${statusColor}`}>
                {b.band}
              </span>
              <div className="flex-1 bg-gray-700/50 rounded h-2">
                <div
                  className={`${barColor} h-2 rounded transition-all duration-500`}
                  style={{ width: `${Math.max(pct, 2)}%` }}
                />
              </div>
              <span className="w-10 text-right text-gray-400 font-mono">{b.count}</span>
              <span className="w-16 text-right text-gray-500 font-mono text-[10px]">
                {b.farthest_km > 0 ? `${Math.round(b.farthest_km)} km` : ""}
              </span>
            </div>
          );
        })}
      </div>

      {/* Summary line */}
      <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-500 flex justify-between">
        <span>{spotStats.unique_callsigns} unique callsigns</span>
        <span>
          {Object.entries(spotStats.by_mode)
            .map(([m, c]) => `${c} ${m.toUpperCase()}`)
            .join(" / ")}
        </span>
      </div>
    </div>
  );
}

// ── Quick Stats Row ──────────────────────────────────────────────────

function QuickStatCard({
  label,
  value,
  sub,
  icon,
  linkTo,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: string;
  linkTo?: string;
}) {
  const inner = (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition-colors">
      <div className="flex items-center gap-3">
        <div className="text-2xl">{icon}</div>
        <div>
          <div className="text-2xl font-bold text-gray-100">{value}</div>
          <div className="text-xs text-gray-400">{label}</div>
          {sub && <div className="text-[10px] text-gray-600 mt-0.5">{sub}</div>}
        </div>
      </div>
    </div>
  );
  if (linkTo) {
    return <Link to={linkTo}>{inner}</Link>;
  }
  return inner;
}

function FrequencyMixPanel({
  stats,
}: {
  stats: StatsResponse | undefined;
}) {
  if (!stats) {
    return <div className="text-gray-500 text-sm">Loading...</div>;
  }

  const groupCounts = FREQUENCY_GROUP_ORDER.map((group) => {
    const apiGroup = stats.top_frequency_groups?.find(
      (entry) => (entry.frequency_group ?? "other") === group,
    );
    return {
      group,
      count: apiGroup?.count ?? 0,
      label: getFrequencyGroupLabel(group, apiGroup?.frequency_group_label),
      entries: stats.top_frequencies.filter(
        (entry) => (entry.frequency_group ?? "other") === group,
      ),
    };
  }).filter((entry) => entry.count > 0 || entry.entries.length > 0);

  if (groupCounts.length === 0) {
    return <div className="text-gray-500 text-sm">No frequency activity yet</div>;
  }

  const total = groupCounts.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="space-y-4">
      <div className="flex overflow-hidden rounded-full bg-gray-900 h-2.5">
        {groupCounts.map((entry) => {
          const theme = getFrequencyGroupTheme(entry.group);
          const widthPct = total > 0 ? (entry.count / total) * 100 : 0;
          return (
            <div
              key={entry.group}
              className={theme.barClassName}
              style={{ width: `${Math.max(widthPct, 2)}%` }}
              title={`${entry.label}: ${entry.count.toLocaleString()}`}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {groupCounts.map((entry) => {
          const theme = getFrequencyGroupTheme(entry.group);
          const pct = total > 0 ? Math.round((entry.count / total) * 100) : 0;
          return (
            <div
              key={entry.group}
              className={`rounded-xl p-3 ${theme.panelClassName}`}
            >
              <div className="flex items-center justify-between gap-3">
                <FrequencyGroupBadge
                  group={entry.group}
                  label={entry.label}
                />
                <span className="text-xs text-gray-500">{pct}%</span>
              </div>
              <div className="mt-3 text-2xl font-semibold text-gray-100">
                {entry.count.toLocaleString()}
              </div>
              <div className="mt-1 text-[11px] text-gray-500">
                {entry.group === "emergency"
                  ? "Collapsed into one safety bucket so ham stays visible."
                  : entry.group === "ham"
                    ? "Ham frequencies stay expanded for easier scanning."
                    : "Everything that does not fit ham or safety."}
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-3">
        {groupCounts.map((entry) => {
          const theme = getFrequencyGroupTheme(entry.group);
          const max = Math.max(entry.entries[0]?.count ?? 0, 1);
          const rows = entry.entries.slice(
            0,
            entry.group === "emergency" ? 1 : 4,
          );
          return (
            <div
              key={entry.group}
              className={`rounded-xl p-3 ${theme.panelClassName}`}
            >
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <FrequencyGroupBadge
                    group={entry.group}
                    label={entry.label}
                    compact
                  />
                  <h3 className="text-sm font-semibold text-gray-100">
                    {entry.label}
                  </h3>
                </div>
                <span className="text-xs text-gray-500">
                  {entry.count.toLocaleString()} hits
                </span>
              </div>
              <div className="space-y-2">
                {rows.map((frequency, idx) => {
                  const href = getFrequencyTarget(frequency);
                  const pct = Math.round((frequency.count / max) * 100);
                  const collapsedCount = frequency.collapsed_labels?.length ?? 0;
                  const content = (
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-mono text-sm text-gray-100">
                          {frequency.label ?? formatFrequency(frequency.frequency_hz)}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {frequency.is_grouped && collapsedCount > 0
                            ? `${collapsedCount.toLocaleString()} collapsed channels`
                            : entry.group === "ham"
                              ? "Expanded individually to keep ham easy to spot."
                              : "Top observed frequency in this group."}
                        </div>
                      </div>
                      <div className="w-24 hidden sm:block">
                        <div className="h-2 rounded-full bg-gray-900 overflow-hidden">
                          <div
                            className={`${theme.barClassName} h-2 rounded-full`}
                            style={{ width: `${Math.max(pct, 6)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-12 text-right font-mono text-xs text-gray-300">
                        {frequency.count}
                      </span>
                    </div>
                  );
                  return href ? (
                    <Link
                      key={`${entry.group}-${idx}`}
                      to={href}
                      className="block rounded-lg px-2 py-2 hover:bg-black/20 transition-colors cursor-pointer group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-mono text-sm text-blue-400 group-hover:underline">
                            {frequency.label ?? formatFrequency(frequency.frequency_hz)}
                          </div>
                          <div className="text-[11px] text-gray-500">
                            {frequency.is_grouped && collapsedCount > 0
                              ? `${collapsedCount.toLocaleString()} collapsed channels`
                              : entry.group === "ham"
                                ? "Expanded individually to keep ham easy to spot."
                                : "Top observed frequency in this group."}
                          </div>
                        </div>
                        <div className="w-24 hidden sm:block">
                          <div className="h-2 rounded-full bg-gray-900 overflow-hidden">
                            <div
                              className={`${theme.barClassName} h-2 rounded-full`}
                              style={{ width: `${Math.max(pct, 6)}%` }}
                            />
                          </div>
                        </div>
                        <span className="w-12 text-right font-mono text-xs text-gray-300">
                          {frequency.count}
                        </span>
                      </div>
                    </Link>
                  ) : (
                    <div
                      key={`${entry.group}-${idx}`}
                      className="rounded-lg px-2 py-2"
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Activity Heatmap ─────────────────────────────────────────────────

function ActivityHeatmap({
  days,
  onChangeDays,
}: {
  days: number;
  onChangeDays: (d: number) => void;
}) {
  const { data: heatmapData, isLoading } = useQuery({
    queryKey: ["activity-heatmap", days],
    queryFn: () => getActivityHeatmap(days),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-200">
          Frequency Activity Heatmap
        </h2>
        <div className="flex gap-1">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => onChangeDays(d)}
              className={`px-2 py-1 text-[10px] rounded ${
                days === d
                  ? "bg-green-700 text-green-100"
                  : "bg-gray-700 text-gray-400 hover:bg-gray-600"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-40 flex items-center justify-center text-gray-500 text-sm">
          Loading heatmap...
        </div>
      ) : !heatmapData || heatmapData.series.length === 0 ? (
        <div className="text-gray-500 text-sm py-4">No frequency activity data</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            {/* Hour labels row */}
            <div className="flex items-center mb-1">
              <div className="w-52 shrink-0" />
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="flex-1 text-center text-[9px] text-gray-500 min-w-[18px]"
                >
                  {h % 6 === 0 ? h.toString().padStart(2, "0") : ""}
                </div>
              ))}
            </div>
            {heatmapData.series.slice(0, 15).map((series: ActivitySeries) => {
              const rowMax = Math.max(...series.data, 1);
              const theme = getFrequencyGroupTheme(series.frequency_group);
              return (
                <div key={series.label} className="flex items-center mt-0.5">
                  <div
                    className="w-52 shrink-0 pr-2 text-right"
                    title={series.label}
                  >
                    <div className="flex items-center justify-end gap-2">
                      <FrequencyGroupBadge
                        group={series.frequency_group}
                        label={series.frequency_group_label}
                        compact
                      />
                      <span className="truncate text-xs text-gray-300 font-mono">
                        {series.label}
                      </span>
                    </div>
                    {series.is_grouped && (series.collapsed_labels?.length ?? 0) > 0 && (
                      <div className="text-[10px] text-gray-500">
                        {series.collapsed_labels?.length?.toLocaleString()} labels collapsed
                      </div>
                    )}
                  </div>
                  {series.data.map((val, h) => {
                    const intensity =
                      val > 0 ? 0.15 + (val / rowMax) * 0.75 : 0;
                    return (
                      <div
                        key={h}
                        className="flex-1 h-4 min-w-[18px] mx-px rounded-sm"
                        style={{
                          backgroundColor: `rgba(${theme.heatmapRgb}, ${intensity})`,
                        }}
                        title={`${series.label} @ ${h.toString().padStart(2, "0")}:00 -- ${val}`}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap items-center gap-2 mt-3 text-xs text-gray-500">
            <span>Low</span>
            {[0.15, 0.35, 0.55, 0.75, 0.9].map((op) => (
              <div
                key={op}
                className="w-4 h-3 rounded-sm bg-emerald-500"
                style={{ opacity: op }}
              />
            ))}
            <span>High</span>
            <span className="text-gray-600">|</span>
            {FREQUENCY_GROUP_ORDER.map((group) => (
              <FrequencyGroupBadge key={group} group={group} compact />
            ))}
            <span className="text-gray-600">row color</span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────

function DashboardPage() {
  const [heatmapDays, setHeatmapDays] = useState(7);

  // Overall stats
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    refetchInterval: 60_000,
  });

  // Band health
  const { data: health2m, isLoading: health2mLoading } = useQuery({
    queryKey: ["sdr-health", "2m"],
    queryFn: () => getSdrHealth("2m"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: health70cm, isLoading: health70cmLoading } = useQuery({
    queryKey: ["sdr-health", "70cm"],
    queryFn: () => getSdrHealth("70cm"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // HF spot bands (1 hour)
  const { data: spotBandsData, isLoading: spotBandsLoading } = useQuery({
    queryKey: ["spot-bands-1h"],
    queryFn: () => getSpotBands(1),
    refetchInterval: 60_000,
  });

  // HF spot stats (1 hour for band conditions panel)
  const { data: spotStats1h, isLoading: spotStats1hLoading } = useQuery({
    queryKey: ["spot-stats-1h"],
    queryFn: () => getSpotStats(1),
    refetchInterval: 60_000,
  });

  // HF spot stats (24h for today count)
  const { data: spotStats24h } = useQuery({
    queryKey: ["spot-stats-24h"],
    queryFn: () => getSpotStats(24),
    staleTime: 60_000,
  });

  // Recent recordings (last 15, initial load only — SSE handles live updates)
  const { data: recentData, isLoading: recentLoading } = useQuery({
    queryKey: ["recent-recordings"],
    queryFn: () => browseFiles({ limit: 15, page: 1, mode: "voice", has_transcript: true }),
    staleTime: 60_000,
  });

  const { recordings: liveRecordings, connected: sseConnected } = useLiveRecordings(recentData?.items);

  // APRS stations (1 hour)
  const { data: aprsData } = useQuery({
    queryKey: ["aprs-stations-1h"],
    queryFn: () => listAprsStations(1),
    staleTime: 30_000,
  });

  // Today's recording count from daily_last_30
  const todayStr = new Date().toISOString().slice(0, 10);
  const recordingsToday =
    stats?.daily_last_30.find((d) => d.date === todayStr)?.count ?? 0;

  // Matched repeaters today -- use matched_to_repeater from stats as a proxy
  const matchedRepeaters = stats?.matched_to_repeater ?? 0;
  const totalRepeaters = stats?.total_repeaters_known ?? 0;

  // APRS station count
  const aprsStationCount = aprsData?.stations?.length ?? 0;

  // Spot count today
  const spotsToday = spotStats24h?.total_spots ?? 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Station Dashboard</h1>
          <p className="text-xs text-gray-500 mt-1">
            SDR monitoring station -- live overview
          </p>
        </div>
        <div className="text-xs text-gray-600 font-mono">
          {new Date().toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </div>
      </div>

      {/* ── Section 1: Band Status ──────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <BandStatusCard
          label="2m VHF"
          band="144 - 148 MHz"
          health={health2m}
          isLoading={health2mLoading}
        />
        <BandStatusCard
          label="70cm UHF"
          band="420 - 450 MHz"
          health={health70cm}
          isLoading={health70cmLoading}
        />
        <HfStatusCard
          spotBands={spotBandsData?.bands}
          isLoading={spotBandsLoading}
        />
      </div>

      {/* ── Section 2: Live Feed + HF Conditions ────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-6">
        {/* Live Activity Feed -- 3 cols */}
        <div className="lg:col-span-3 bg-gray-800 rounded-lg border border-gray-700">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-200">
                Live Voice Activity
              </h2>
              <p className="text-[10px] text-gray-500">Voice with transcription · CW, emergency &amp; digital in <Link to="/browse" className="text-green-500 hover:text-green-400">Browse</Link></p>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${sseConnected ? "bg-green-500 animate-pulse" : "bg-yellow-500"}`} />
              <span className="text-[10px] text-gray-500">{sseConnected ? "Live" : "Connecting..."}</span>
            </div>
          </div>
          <div className="px-2 pb-3 max-h-[480px] overflow-y-auto">
            <LiveActivityFeed
              recordings={liveRecordings}
              isLoading={recentLoading}
              connected={sseConnected}
            />
          </div>
          <div className="border-t border-gray-700 px-4 py-2">
            <Link
              to="/browse"
              className="text-xs text-green-400 hover:text-green-300"
            >
              View all recordings &rarr;
            </Link>
          </div>
        </div>

        {/* HF Band Conditions -- 2 cols */}
        <div className="lg:col-span-2 bg-gray-800 rounded-lg border border-gray-700 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200">
              HF Band Conditions
            </h2>
            <span className="text-[10px] text-gray-500">Last hour</span>
          </div>
          <HfBandConditions
            spotStats={spotStats1h}
            isLoading={spotStats1hLoading}
          />
          <div className="mt-3 pt-2 border-t border-gray-700">
            <Link
              to="/spots"
              className="text-xs text-green-400 hover:text-green-300"
            >
              View spot log &rarr;
            </Link>
          </div>
        </div>
      </div>

      {/* ── Section 3: Quick Stats Row ──────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <QuickStatCard
          icon={statsLoading ? "..." : "\u{1F4FB}"}
          label="Recordings Today"
          value={recordingsToday.toLocaleString()}
          sub={stats ? `${stats.total_recordings.toLocaleString()} total` : undefined}
          linkTo="/browse"
        />
        <QuickStatCard
          icon={statsLoading ? "..." : "\u{1F4E1}"}
          label="APRS Stations"
          value={aprsStationCount}
          sub="Active in last hour"
          linkTo="/aprs"
        />
        <QuickStatCard
          icon={statsLoading ? "..." : "\u{26A1}"}
          label="FT8/WSPR Spots Today"
          value={spotsToday.toLocaleString()}
          sub={
            spotStats24h
              ? `${spotStats24h.unique_callsigns} callsigns`
              : undefined
          }
          linkTo="/spots"
        />
        <QuickStatCard
          icon={statsLoading ? "..." : "\u{1F4F6}"}
          label="Known Repeaters"
          value={matchedRepeaters.toLocaleString()}
          sub={`of ${totalRepeaters.toLocaleString()} matched to recordings`}
          linkTo="/repeaters"
        />
      </div>

      {/* ── Section 4: Mode Breakdown + Top Frequencies ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Mode breakdown */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-200 mb-3">
            Recordings by Mode
          </h2>
          {stats ? (
            <div className="space-y-2">
              {Object.entries(stats.by_mode)
                .sort(([, a], [, b]) => b - a)
                .map(([mode, count]) => {
                  const pct =
                    stats.total_recordings > 0
                      ? Math.round((count / stats.total_recordings) * 100)
                      : 0;
                  const barColor =
                    ({
                      voice: "bg-blue-600",
                      cw: "bg-yellow-600",
                      aprs: "bg-green-600",
                      hfdl: "bg-cyan-600",
                      acars: "bg-cyan-500",
                      vdl2: "bg-cyan-700",
                      pager: "bg-red-600",
                      eas: "bg-red-500",
                      sstv: "bg-purple-600",
                    } as Record<string, string>)[mode] ?? "bg-gray-600";
                  return (
                    <div key={mode} className="flex items-center gap-2 text-xs">
                      <span className="w-14 uppercase font-semibold text-gray-300">
                        {mode}
                      </span>
                      <div className="flex-1 bg-gray-700/50 rounded h-2.5">
                        <div
                          className={`${barColor} h-2.5 rounded transition-all`}
                          style={{
                            width: `${Math.max(pct, 1)}%`,
                          }}
                        />
                      </div>
                      <span className="w-14 text-right text-gray-400 font-mono">
                        {count.toLocaleString()}
                      </span>
                      <span className="w-10 text-right text-gray-600 text-[10px]">
                        {pct}%
                      </span>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="text-gray-500 text-sm">Loading...</div>
          )}
        </div>

        {/* Top frequencies */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-200 mb-3">
            Frequency Mix
          </h2>
          <FrequencyMixPanel stats={stats} />
        </div>
      </div>

      {/* ── Section 5: Activity Heatmap ─────────────────────────────── */}
      <ActivityHeatmap days={heatmapDays} onChangeDays={setHeatmapDays} />
    </div>
  );
}

export default DashboardPage;
