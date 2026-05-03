import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getFrequencyStats } from "../api/client";
import { formatDateTime } from "../utils/time";
import {
  getBandSegment,
  getBandName,
  getBandRange,
  getAllSegmentsForBand,
  getNotableFrequency,
} from "../utils/bandplan";
import {
  BarChart,
  Bar,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatDuration(s: number | null): string {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function SignalBadge({ db }: { db: number | null }) {
  if (db == null) return null;
  const cls =
    db > -20
      ? "bg-green-900 text-green-300"
      : db > -40
        ? "bg-yellow-900 text-yellow-300"
        : "bg-red-900 text-red-300";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${cls}`}>
      {db.toFixed(0)} dB
    </span>
  );
}

/**
 * Convert dBFS to approximate S-meter units.
 * Calibration: S9 ~ -73 dBm. For a typical SDR with ~60 dB dynamic range,
 * S9 maps to roughly -13 dBFS. Each S-unit is 6 dB.
 */
function dbfsToSmeter(dbfs: number): string {
  // S9 reference point in dBFS (approximate for typical SDR)
  const s9Dbfs = -13;
  const dbAboveS9 = dbfs - s9Dbfs;

  if (dbAboveS9 >= 0) {
    // Above S9: report as S9+N
    const overDb = Math.round(dbAboveS9);
    return overDb > 0 ? `S9+${overDb}` : "S9";
  }
  // Below S9: each S-unit is 6 dB
  const sUnits = Math.max(0, Math.round(9 + dbAboveS9 / 6));
  return `S${sUnits}`;
}

function smeterColor(dbfs: number): string {
  if (dbfs > -13) return "text-red-400";    // S9+
  if (dbfs > -25) return "text-yellow-300"; // S6-S9
  if (dbfs > -37) return "text-green-400";  // S3-S6
  return "text-blue-400";                    // S0-S3
}

interface HourlySignalBucket {
  hour: string;       // ISO date+hour label, e.g. "03/10 14h"
  sortKey: number;     // for sorting
  avg: number;
  min: number;
  max: number;
  count: number;
}

/** Signal strength custom tooltip for the trend chart */
function SignalTrendTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  // payload has avg, min, max
  const avg = payload.find(p => p.name === "avg")?.value;
  const min = payload.find(p => p.name === "min")?.value;
  const max = payload.find(p => p.name === "max")?.value;
  return (
    <div className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-gray-300 font-medium mb-1">{label}</div>
      {max != null && <div className="text-green-400">Peak: {max.toFixed(1)} dBFS</div>}
      {avg != null && <div className="text-yellow-300">Avg: {avg.toFixed(1)} dBFS</div>}
      {min != null && <div className="text-red-400">Floor: {min.toFixed(1)} dBFS</div>}
    </div>
  );
}

function formatFrequencyCompact(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(2)}`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(0)}k`;
  return `${hz}`;
}

/** Badge showing the band plan segment for a frequency */
function BandPlanBadge({ freq_hz }: { freq_hz: number }) {
  const segment = getBandSegment(freq_hz);
  const bandName = getBandName(freq_hz);
  const notable = getNotableFrequency(freq_hz);

  if (!segment && !bandName) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {segment && (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium"
          style={{
            backgroundColor: segment.color + "20",
            color: segment.color,
            border: `1px solid ${segment.color}40`,
          }}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: segment.color }}
          />
          {segment.band} {segment.label}
        </span>
      )}
      {!segment && bandName && (
        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-gray-700 text-gray-300 border border-gray-600">
          {bandName} Band
        </span>
      )}
      {notable && (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-900/50 text-amber-300 border border-amber-700/40">
          {notable.label}
        </span>
      )}
    </div>
  );
}

/** Visual bar showing where a frequency sits within its band plan segments */
function BandPlanBar({ freq_hz }: { freq_hz: number }) {
  const bandName = getBandName(freq_hz);
  if (!bandName) return null;

  const range = getBandRange(bandName);
  if (!range) return null;

  const segments = getAllSegmentsForBand(bandName);
  if (segments.length === 0) return null;

  const bandWidth = range.end_hz - range.start_hz;
  if (bandWidth <= 0) return null;

  // Position of the current frequency as a percentage across the band
  const freqPct = ((freq_hz - range.start_hz) / bandWidth) * 100;

  return (
    <div className="bg-gray-800 rounded-lg p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-300">
          {bandName} Band Plan
        </h2>
        <span className="text-xs text-gray-500 font-mono">
          {formatFrequency(range.start_hz)} &ndash; {formatFrequency(range.end_hz)}
        </span>
      </div>

      {/* Band plan bar */}
      <div className="relative">
        {/* Segment bar */}
        <div className="flex h-6 rounded-md overflow-hidden border border-gray-700">
          {segments
            .filter((seg) => (seg.end_hz - seg.start_hz) > 1)
            .map((seg, i) => {
              const segStart = Math.max(seg.start_hz, range.start_hz);
              const segEnd = Math.min(seg.end_hz, range.end_hz);
              const widthPct = ((segEnd - segStart) / bandWidth) * 100;
              const leftPct = ((segStart - range.start_hz) / bandWidth) * 100;

              return (
                <div
                  key={`${seg.label}-${i}`}
                  className="relative group"
                  style={{
                    position: "absolute",
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    height: "100%",
                    backgroundColor: seg.color + "35",
                    borderRight: "1px solid rgba(0,0,0,0.3)",
                  }}
                >
                  {/* Label inside segment if wide enough */}
                  {widthPct > 8 && (
                    <span
                      className="absolute inset-0 flex items-center justify-center text-[9px] font-medium truncate px-0.5"
                      style={{ color: seg.color }}
                    >
                      {seg.label}
                    </span>
                  )}
                  {/* Tooltip on hover */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 pointer-events-none">
                    <div className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs whitespace-nowrap shadow-lg">
                      <span style={{ color: seg.color }}>{seg.label}</span>
                      <div className="text-gray-500 text-[10px]">
                        {formatFrequencyCompact(seg.start_hz)} &ndash;{" "}
                        {formatFrequencyCompact(seg.end_hz)} MHz
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        {/* Current frequency marker */}
        <div
          className="absolute top-0 h-6 w-0.5 bg-white z-10"
          style={{ left: `${Math.min(Math.max(freqPct, 0), 100)}%` }}
        >
          <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-mono text-white bg-gray-900/90 px-1.5 py-0.5 rounded whitespace-nowrap border border-gray-600">
            {formatFrequency(freq_hz)}
          </div>
          {/* Arrow below the marker */}
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent border-t-white" />
        </div>

        {/* Edge labels */}
        <div className="flex justify-between mt-1 text-[10px] text-gray-600 font-mono">
          <span>{formatFrequencyCompact(range.start_hz)}</span>
          <span>{formatFrequencyCompact(range.end_hz)} MHz</span>
        </div>
      </div>
    </div>
  );
}

function FrequencyPage() {
  const { hz } = useParams<{ hz: string }>();
  const frequencyHz = parseFloat(hz ?? "0");

  const { data, isLoading, error } = useQuery({
    queryKey: ["freq-stats", frequencyHz],
    queryFn: () => getFrequencyStats(frequencyHz),
    enabled: !!frequencyHz && !isNaN(frequencyHz),
    staleTime: 60_000,
  });

  if (!frequencyHz || isNaN(frequencyHz)) {
    return <div className="text-red-400">Invalid frequency.</div>;
  }

  if (isLoading) {
    return <div className="text-center py-8">Loading…</div>;
  }

  if (error || !data) {
    return (
      <div className="text-red-400">Failed to load frequency stats: {String(error)}</div>
    );
  }

  const totalByMode = Object.values(data.by_mode).reduce((a, b) => a + b, 0);

  // ── Signal strength analysis ──────────────────────────────────────
  const signalAnalysis = useMemo(() => {
    const withSignal = data.recent_recordings.filter(
      (r) => r.signal_db != null && isFinite(r.signal_db!)
    );
    if (withSignal.length === 0) return null;

    const values = withSignal.map((r) => r.signal_db!);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const peak = Math.max(...values);
    const floor = Math.min(...values);
    const dynamicRange = peak - floor;

    // Bucket by hour for the trend chart
    const buckets = new Map<string, { sum: number; min: number; max: number; count: number; sortKey: number }>();
    for (const r of withSignal) {
      if (!r.timestamp) continue;
      const d = new Date(r.timestamp);
      const key = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}h`;
      const sortKey = d.getTime();
      const existing = buckets.get(key);
      if (existing) {
        existing.sum += r.signal_db!;
        existing.min = Math.min(existing.min, r.signal_db!);
        existing.max = Math.max(existing.max, r.signal_db!);
        existing.count += 1;
        existing.sortKey = Math.min(existing.sortKey, sortKey);
      } else {
        buckets.set(key, {
          sum: r.signal_db!,
          min: r.signal_db!,
          max: r.signal_db!,
          count: 1,
          sortKey,
        });
      }
    }

    const hourlyData: HourlySignalBucket[] = Array.from(buckets.entries())
      .map(([hour, b]) => ({
        hour,
        sortKey: b.sortKey,
        avg: b.sum / b.count,
        min: b.min,
        max: b.max,
        count: b.count,
      }))
      .sort((a, b) => a.sortKey - b.sortKey);

    return { avg, peak, floor, dynamicRange, hourlyData, sampleCount: withSignal.length };
  }, [data.recent_recordings]);

  return (
    <div>
      <div className="mb-6">
        <Link to="/" className="text-gray-400 hover:text-white text-sm">
          &larr; Back to recordings
        </Link>
        <h1 className="text-2xl font-bold mt-2">
          {formatFrequency(frequencyHz)}
          {data.label && (
            <span className="ml-3 text-lg font-normal text-cyan-400">{data.label}</span>
          )}
        </h1>
        <p className="text-sm text-gray-400 mt-1">±10 kHz tolerance</p>
        <div className="mt-2">
          <BandPlanBadge freq_hz={frequencyHz} />
        </div>
      </div>

      {/* Band plan position bar */}
      <BandPlanBar freq_hz={frequencyHz} />

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-1">Total Recordings</div>
          <div className="text-2xl font-bold">{data.recordings_total.toLocaleString()}</div>
        </div>
        {Object.entries(data.by_mode).map(([mode, cnt]) => (
          <div key={mode} className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">{mode.toUpperCase()}</div>
            <div className="text-2xl font-bold">{cnt.toLocaleString()}</div>
            {totalByMode > 0 && (
              <div className="text-xs text-gray-500 mt-1">
                {Math.round((cnt / totalByMode) * 100)}%
              </div>
            )}
          </div>
        ))}
        {data.repeaters.length > 0 && (
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">Repeaters</div>
            <div className="text-2xl font-bold">{data.repeaters.length}</div>
          </div>
        )}
      </div>

      {/* ── Signal Statistics + S-Meter ───────────────────────────── */}
      {signalAnalysis && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">Avg Signal</div>
            <div className="text-2xl font-bold text-yellow-300">
              {signalAnalysis.avg.toFixed(1)}
              <span className="text-sm font-normal text-gray-400 ml-1">dBFS</span>
            </div>
            <div className={`text-xs mt-1 font-mono ${smeterColor(signalAnalysis.avg)}`}>
              {dbfsToSmeter(signalAnalysis.avg)}
            </div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">Peak Signal</div>
            <div className="text-2xl font-bold text-green-400">
              {signalAnalysis.peak.toFixed(1)}
              <span className="text-sm font-normal text-gray-400 ml-1">dBFS</span>
            </div>
            <div className={`text-xs mt-1 font-mono ${smeterColor(signalAnalysis.peak)}`}>
              {dbfsToSmeter(signalAnalysis.peak)}
            </div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">Noise Floor</div>
            <div className="text-2xl font-bold text-red-400">
              {signalAnalysis.floor.toFixed(1)}
              <span className="text-sm font-normal text-gray-400 ml-1">dBFS</span>
            </div>
            <div className={`text-xs mt-1 font-mono ${smeterColor(signalAnalysis.floor)}`}>
              {dbfsToSmeter(signalAnalysis.floor)}
            </div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">Dynamic Range</div>
            <div className="text-2xl font-bold text-cyan-300">
              {signalAnalysis.dynamicRange.toFixed(1)}
              <span className="text-sm font-normal text-gray-400 ml-1">dB</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              peak &minus; floor
            </div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 mb-1">S-Meter</div>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-lg font-bold font-mono ${smeterColor(signalAnalysis.avg)}`}>
                {dbfsToSmeter(signalAnalysis.avg)}
              </span>
              <span className="text-xs text-gray-500">avg</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-lg font-bold font-mono ${smeterColor(signalAnalysis.peak)}`}>
                {dbfsToSmeter(signalAnalysis.peak)}
              </span>
              <span className="text-xs text-gray-500">peak</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Signal Strength Trend ─────────────────────────────────── */}
      {signalAnalysis && signalAnalysis.hourlyData.length > 1 && (
        <div className="bg-gray-800 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold mb-3 text-gray-300">
            Signal Strength Over Time
            <span className="ml-2 text-xs font-normal text-gray-500">
              ({signalAnalysis.sampleCount} recordings)
            </span>
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart
              data={signalAnalysis.hourlyData}
              margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
            >
              <defs>
                <linearGradient id="signalGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                  <stop offset="50%" stopColor="#eab308" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="hour"
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                interval={Math.max(0, Math.floor(signalAnalysis.hourlyData.length / 8) - 1)}
                axisLine={{ stroke: "#374151" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                domain={["auto", "auto"]}
                axisLine={{ stroke: "#374151" }}
                tickLine={false}
                tickFormatter={(v) => `${v}`}
                label={{
                  value: "dBFS",
                  angle: -90,
                  position: "insideLeft",
                  style: { fill: "#6b7280", fontSize: 10 },
                }}
              />
              <Tooltip content={<SignalTrendTooltip />} />
              <ReferenceLine
                y={-20}
                stroke="#22c55e"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
              <ReferenceLine
                y={-40}
                stroke="#ef4444"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
              {/* Min-max band */}
              <Area
                type="monotone"
                dataKey="max"
                stroke="none"
                fill="url(#signalGradient)"
                fillOpacity={1}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="min"
                stroke="none"
                fill="#1f2937"
                fillOpacity={1}
                isAnimationActive={false}
              />
              {/* Average line */}
              <Line
                type="monotone"
                dataKey="avg"
                stroke="#eab308"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              {/* Peak line */}
              <Line
                type="monotone"
                dataKey="max"
                stroke="#22c55e"
                strokeWidth={1}
                strokeDasharray="4 2"
                dot={false}
                isAnimationActive={false}
              />
              {/* Floor line */}
              <Line
                type="monotone"
                dataKey="min"
                stroke="#ef4444"
                strokeWidth={1}
                strokeDasharray="4 2"
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex items-center justify-center gap-6 mt-2 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-yellow-500 inline-block rounded" /> Avg
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-green-500 inline-block rounded opacity-70" style={{ borderTop: "1px dashed #22c55e" }} /> Peak
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-red-500 inline-block rounded opacity-70" style={{ borderTop: "1px dashed #ef4444" }} /> Floor
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 inline-block rounded" style={{ background: "linear-gradient(to bottom, rgba(34,197,94,0.3), rgba(234,179,8,0.15), rgba(239,68,68,0.05))" }} /> Range
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Daily activity */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3 text-gray-300">Daily Activity (last 30 days)</h2>
          {data.daily_last_30.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart
                data={[...data.daily_last_30].reverse()}
                margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
              >
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#9ca3af", fontSize: 10 }}
                  tickFormatter={(d) => d.slice(5)}
                  interval={Math.max(0, Math.floor(data.daily_last_30.length / 6) - 1)}
                />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1f2937", border: "none", fontSize: 12 }}
                />
                <Bar dataKey="count" fill="#22c55e" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-500 text-sm py-8 text-center">No activity in last 30 days.</p>
          )}
        </div>

        {/* Hour-of-day */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3 text-gray-300">Activity by Hour of Day</h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={data.by_hour}
              margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
            >
              <XAxis
                dataKey="hour"
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                tickFormatter={(h) => `${h}h`}
                interval={3}
              />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1f2937", border: "none", fontSize: 12 }}
                labelFormatter={(h) => `Hour: ${h}:00`}
              />
              <Bar dataKey="count" fill="#3b82f6" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Top callsigns */}
        {data.top_callsigns.length > 0 && (
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3 text-gray-300">Top Callsigns</h2>
            <div className="space-y-2">
              {data.top_callsigns.map(({ callsign, count }) => (
                <div key={callsign} className="flex items-center gap-3">
                  <Link
                    to={`/callsign/${callsign}`}
                    className="font-mono text-purple-300 hover:text-purple-200 w-20 shrink-0 text-sm"
                  >
                    {callsign}
                  </Link>
                  <div className="flex-1 bg-gray-700 rounded h-2">
                    <div
                      className="bg-purple-600 h-2 rounded"
                      style={{
                        width: `${Math.round(
                          (count / (data.top_callsigns[0]?.count ?? 1)) * 100
                        )}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 w-8 text-right">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Repeaters */}
        {data.repeaters.length > 0 && (
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-3 text-gray-300">Repeaters on this Frequency</h2>
            <div className="space-y-3">
              {data.repeaters.map((r) => (
                <div key={r.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/callsign/${r.callsign}`}
                      className="font-mono text-purple-300 hover:text-purple-200 font-medium"
                    >
                      {r.callsign}
                    </Link>
                    {r.use && (
                      <span className="text-xs px-1.5 py-0.5 bg-gray-700 rounded text-gray-300">
                        {r.use}
                      </span>
                    )}
                    {r.pl_tone && (
                      <span className="text-xs text-gray-400">PL {r.pl_tone.toFixed(1)}</span>
                    )}
                  </div>
                  {(r.location || r.state) && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {[r.location, r.state].filter(Boolean).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Recent recordings */}
      {data.recent_recordings.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3 text-gray-300">Recent Recordings</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                  <th className="text-left py-2 pr-4">Mode</th>
                  <th className="text-left py-2 pr-4">Date/Time</th>
                  <th className="text-left py-2 pr-4">Duration</th>
                  <th className="text-left py-2 pr-4">Transcript</th>
                  <th className="text-left py-2 pr-4">Signal</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {data.recent_recordings.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-4">
                      <span
                        className={`inline-flex px-2 py-0.5 text-xs font-medium rounded ${
                          r.mode === "cw"
                            ? "bg-yellow-900 text-yellow-200"
                            : "bg-blue-900 text-blue-200"
                        }`}
                      >
                        {r.mode.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-400 text-xs">
                      {r.timestamp ? formatDateTime(r.timestamp) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-gray-400">
                      {formatDuration(r.duration_seconds)}
                    </td>
                    <td className="py-2 pr-4">
                      {(() => {
                        const s = r.transcript_status ?? (r.has_transcript ? "yes" : "no");
                        return s === "yes" ? (
                          <span className="text-green-400 text-xs">Yes</span>
                        ) : s === "pending" ? (
                          <span className="text-yellow-400 text-xs">Pending</span>
                        ) : (
                          <span className="text-gray-500 text-xs">No</span>
                        );
                      })()}
                    </td>
                    <td className="py-2 pr-4">
                      <SignalBadge db={r.signal_db} />
                    </td>
                    <td className="py-2 text-right">
                      <Link
                        to={`/player/${r.id}`}
                        className="text-green-400 hover:text-green-300 text-xs"
                      >
                        Play →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.recordings_total === 0 && (
        <div className="text-center py-12 text-gray-400">
          No recordings found for {formatFrequency(frequencyHz)} (±10 kHz).
        </div>
      )}
    </div>
  );
}

export default FrequencyPage;
