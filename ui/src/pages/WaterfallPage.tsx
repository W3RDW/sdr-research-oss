import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { browseFiles, Recording } from "../api/client";
import { getSegmentsInRange } from "../utils/bandplan";

// ── Band Definitions ─────────────────────────────────────────────────

interface BandDef {
  label: string;
  shortLabel: string;
  minHz: number;
  maxHz: number;
  binWidthHz: number;
}

const BANDS: Record<string, BandDef> = {
  "2m": {
    label: "2m VHF",
    shortLabel: "2m",
    minHz: 144_000_000,
    maxHz: 148_000_000,
    binWidthHz: 25_000,
  },
  "70cm": {
    label: "70cm UHF",
    shortLabel: "70cm",
    minHz: 420_000_000,
    maxHz: 450_000_000,
    binWidthHz: 100_000,
  },
  pager: {
    label: "Pager",
    shortLabel: "Pager",
    minHz: 929_000_000,
    maxHz: 932_000_000,
    binWidthHz: 25_000,
  },
};

type BandKey = keyof typeof BANDS;
type TimeRange = "1h" | "6h" | "24h";

const TIME_RANGES: { key: TimeRange; label: string; hours: number }[] = [
  { key: "1h", label: "1h", hours: 1 },
  { key: "6h", label: "6h", hours: 6 },
  { key: "24h", label: "24h", hours: 24 },
];

function getTimeBinMinutes(timeRange: TimeRange): number {
  switch (timeRange) {
    case "1h":
      return 2;
    case "6h":
      return 5;
    case "24h":
      return 15;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatFrequency(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatFrequencyShort(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(2)}`;
  return `${(hz / 1_000).toFixed(0)}k`;
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  });
}

function intensityColor(count: number, maxCount: number): string {
  if (count === 0) return "rgba(0, 0, 0, 0.6)";
  const t = Math.min(count / Math.max(maxCount, 1), 1);
  // Dark green to bright green gradient
  const r = Math.round(0 + t * 34);
  const g = Math.round(40 + t * 157);
  const b = Math.round(0 + t * 34);
  return `rgb(${r}, ${g}, ${b})`;
}

// ── Grid computation ─────────────────────────────────────────────────

interface GridCell {
  row: number;
  col: number;
  count: number;
  timeStart: Date;
  timeEnd: Date;
  freqMin: number;
  freqMax: number;
}

interface GridData {
  cells: GridCell[];
  rows: number;
  cols: number;
  maxCount: number;
  timeBins: { start: Date; end: Date }[];
  freqBins: { min: number; max: number; center: number }[];
}

function buildGrid(
  recordings: Recording[],
  band: BandDef,
  timeRange: TimeRange
): GridData {
  const now = new Date();
  const hours = TIME_RANGES.find((t) => t.key === timeRange)!.hours;
  const rangeStart = new Date(now.getTime() - hours * 3600_000);
  const timeBinMin = getTimeBinMinutes(timeRange);
  const totalMinutes = hours * 60;
  const rows = Math.ceil(totalMinutes / timeBinMin);
  const cols = Math.ceil((band.maxHz - band.minHz) / band.binWidthHz);

  // Build time bins (newest first = row 0)
  const timeBins: { start: Date; end: Date }[] = [];
  for (let r = 0; r < rows; r++) {
    const binEnd = new Date(now.getTime() - r * timeBinMin * 60_000);
    const binStart = new Date(binEnd.getTime() - timeBinMin * 60_000);
    timeBins.push({ start: binStart, end: binEnd });
  }

  // Build frequency bins
  const freqBins: { min: number; max: number; center: number }[] = [];
  for (let c = 0; c < cols; c++) {
    const fMin = band.minHz + c * band.binWidthHz;
    const fMax = fMin + band.binWidthHz;
    freqBins.push({ min: fMin, max: fMax, center: fMin + band.binWidthHz / 2 });
  }

  // Initialize count array
  const counts = new Array(rows * cols).fill(0);

  // Bin recordings
  for (const rec of recordings) {
    if (!rec.frequency_hz || !rec.timestamp) continue;
    const freq = rec.frequency_hz;
    if (freq < band.minHz || freq >= band.maxHz) continue;

    const ts = new Date(
      rec.timestamp.endsWith("Z") || rec.timestamp.includes("+")
        ? rec.timestamp
        : rec.timestamp + "Z"
    );
    if (ts < rangeStart || ts > now) continue;

    const minutesAgo = (now.getTime() - ts.getTime()) / 60_000;
    const row = Math.floor(minutesAgo / timeBinMin);
    const col = Math.floor((freq - band.minHz) / band.binWidthHz);

    if (row >= 0 && row < rows && col >= 0 && col < cols) {
      counts[row * cols + col]++;
    }
  }

  // Build cells and find max
  let maxCount = 0;
  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const count = counts[r * cols + c];
      if (count > maxCount) maxCount = count;
      cells.push({
        row: r,
        col: c,
        count,
        timeStart: timeBins[r].start,
        timeEnd: timeBins[r].end,
        freqMin: freqBins[c].min,
        freqMax: freqBins[c].max,
      });
    }
  }

  return { cells, rows, cols, maxCount, timeBins, freqBins };
}

// ── Top frequencies ──────────────────────────────────────────────────

interface FreqSummary {
  freqHz: number;
  label: string;
  count: number;
}

function topFrequencies(recordings: Recording[], limit = 5): FreqSummary[] {
  const map = new Map<number, number>();
  for (const rec of recordings) {
    if (!rec.frequency_hz) continue;
    map.set(rec.frequency_hz, (map.get(rec.frequency_hz) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hz, count]) => ({
      freqHz: hz,
      label: formatFrequency(hz),
      count,
    }));
}

// ── SVG Waterfall Component ──────────────────────────────────────────

function WaterfallGrid({
  grid,
  band,
  onCellClick,
  showBandPlan = true,
}: {
  grid: GridData;
  band: BandDef;
  onCellClick: (cell: GridCell) => void;
  showBandPlan?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    cell: GridCell;
  } | null>(null);

  const LEFT_MARGIN = 64;
  const BOTTOM_MARGIN = showBandPlan ? 60 : 48;
  const TOP_MARGIN = 8;
  const RIGHT_MARGIN = 8;

  // Use container width for responsive sizing
  const [containerWidth, setContainerWidth] = useState(900);
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const plotWidth = containerWidth - LEFT_MARGIN - RIGHT_MARGIN;
  const cellW = Math.max(plotWidth / grid.cols, 1);
  const cellH = Math.max(Math.min(8, 600 / grid.rows), 2);
  const plotHeight = cellH * grid.rows;
  const svgWidth = LEFT_MARGIN + plotWidth + RIGHT_MARGIN;
  const svgHeight = TOP_MARGIN + plotHeight + BOTTOM_MARGIN;

  // Frequency axis labels (show ~10 labels)
  const freqLabelStep = Math.max(1, Math.floor(grid.cols / 10));
  const freqLabels: { col: number; label: string; hz: number }[] = [];
  for (let c = 0; c <= grid.cols; c += freqLabelStep) {
    const hz = band.minHz + c * band.binWidthHz;
    freqLabels.push({ col: c, label: formatFrequencyShort(hz), hz });
  }

  // Time axis labels (show ~8 labels)
  const timeLabelStep = Math.max(1, Math.floor(grid.rows / 8));
  const timeLabels: { row: number; label: string }[] = [];
  for (let r = 0; r < grid.rows; r += timeLabelStep) {
    timeLabels.push({
      row: r,
      label: formatTimeLabel(grid.timeBins[r].end),
    });
  }

  // Band plan segments overlapping this frequency range
  const bandSegments = useMemo(() => {
    if (!showBandPlan) return [];
    return getSegmentsInRange(band.minHz, band.maxHz).filter(
      (seg) => (seg.end_hz - seg.start_hz) > 1 // skip point segments
    );
  }, [band.minHz, band.maxHz, showBandPlan]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const col = Math.floor((x - LEFT_MARGIN) / cellW);
      const row = Math.floor((y - TOP_MARGIN) / cellH);

      if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) {
        const cell = grid.cells[row * grid.cols + col];
        setTooltip({ x: e.clientX, y: e.clientY, cell });
      } else {
        setTooltip(null);
      }
    },
    [grid, cellW, cellH]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const col = Math.floor((x - LEFT_MARGIN) / cellW);
      const row = Math.floor((y - TOP_MARGIN) / cellH);

      if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) {
        const cell = grid.cells[row * grid.cols + col];
        if (cell.count > 0) {
          onCellClick(cell);
        }
      }
    },
    [grid, cellW, cellH, onCellClick]
  );

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        width={svgWidth}
        height={svgHeight}
        className="block"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        onClick={handleClick}
        style={{ cursor: "crosshair" }}
      >
        {/* Background */}
        <rect
          x={LEFT_MARGIN}
          y={TOP_MARGIN}
          width={plotWidth}
          height={plotHeight}
          fill="#0a0a0a"
        />

        {/* Cells */}
        {grid.cells.map((cell) => (
          <rect
            key={`${cell.row}-${cell.col}`}
            x={LEFT_MARGIN + cell.col * cellW}
            y={TOP_MARGIN + cell.row * cellH}
            width={Math.ceil(cellW)}
            height={cellH}
            fill={intensityColor(cell.count, grid.maxCount)}
            stroke="none"
          />
        ))}

        {/* Frequency axis labels (bottom) */}
        {freqLabels.map(({ col, label }) => (
          <g key={`freq-${col}`}>
            <line
              x1={LEFT_MARGIN + col * cellW}
              y1={TOP_MARGIN}
              x2={LEFT_MARGIN + col * cellW}
              y2={TOP_MARGIN + plotHeight}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
            <text
              x={LEFT_MARGIN + col * cellW}
              y={TOP_MARGIN + plotHeight + 16}
              fill="#9ca3af"
              fontSize={10}
              textAnchor="middle"
              fontFamily="monospace"
            >
              {label}
            </text>
          </g>
        ))}

        {/* "MHz" label at bottom right */}
        <text
          x={LEFT_MARGIN + plotWidth}
          y={TOP_MARGIN + plotHeight + (showBandPlan ? 48 : 36)}
          fill="#6b7280"
          fontSize={10}
          textAnchor="end"
          fontFamily="monospace"
        >
          MHz
        </text>

        {/* Time axis labels (left) */}
        {timeLabels.map(({ row, label }) => (
          <g key={`time-${row}`}>
            <line
              x1={LEFT_MARGIN}
              y1={TOP_MARGIN + row * cellH}
              x2={LEFT_MARGIN + plotWidth}
              y2={TOP_MARGIN + row * cellH}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth={1}
            />
            <text
              x={LEFT_MARGIN - 6}
              y={TOP_MARGIN + row * cellH + cellH / 2 + 3}
              fill="#9ca3af"
              fontSize={10}
              textAnchor="end"
              fontFamily="monospace"
            >
              {label}
            </text>
          </g>
        ))}

        {/* Band plan segment boundaries */}
        {bandSegments.map((seg, i) => {
          const bandSpan = band.maxHz - band.minHz;
          // Boundary line at segment start (if within visible range)
          const startPx =
            ((Math.max(seg.start_hz, band.minHz) - band.minHz) / bandSpan) * plotWidth;
          const endPx =
            ((Math.min(seg.end_hz, band.maxHz) - band.minHz) / bandSpan) * plotWidth;
          const segWidthPx = endPx - startPx;
          const midPx = startPx + segWidthPx / 2;
          const showLabel = segWidthPx > 30;

          return (
            <g key={`bp-${i}`}>
              {/* Segment boundary line (left edge) */}
              {seg.start_hz > band.minHz && (
                <line
                  x1={LEFT_MARGIN + startPx}
                  y1={TOP_MARGIN}
                  x2={LEFT_MARGIN + startPx}
                  y2={TOP_MARGIN + plotHeight}
                  stroke={seg.color}
                  strokeWidth={0.75}
                  strokeDasharray="3,4"
                  opacity={0.45}
                />
              )}
              {/* Colored strip along the bottom axis area */}
              <rect
                x={LEFT_MARGIN + startPx}
                y={TOP_MARGIN + plotHeight + 1}
                width={Math.max(segWidthPx, 1)}
                height={3}
                fill={seg.color}
                opacity={0.6}
                rx={1}
              />
              {/* Segment label below frequency axis */}
              {showLabel && (
                <text
                  x={LEFT_MARGIN + midPx}
                  y={TOP_MARGIN + plotHeight + 30}
                  fill={seg.color}
                  fontSize={8}
                  textAnchor="middle"
                  fontFamily="monospace"
                  opacity={0.8}
                >
                  {seg.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 border border-gray-600 rounded-md px-3 py-2 text-xs shadow-lg"
          style={{
            left: tooltip.x + 16,
            top: tooltip.y - 8,
          }}
        >
          <div className="text-gray-200 font-mono">
            {formatFrequency(tooltip.cell.freqMin)} &ndash;{" "}
            {formatFrequency(tooltip.cell.freqMax)}
          </div>
          <div className="text-gray-400 mt-1">
            {formatTimeLabel(tooltip.cell.timeStart)} &ndash;{" "}
            {formatTimeLabel(tooltip.cell.timeEnd)}
          </div>
          <div className="mt-1">
            <span
              className={
                tooltip.cell.count > 0 ? "text-green-400" : "text-gray-600"
              }
            >
              {tooltip.cell.count} recording{tooltip.cell.count !== 1 ? "s" : ""}
            </span>
          </div>
          {(() => {
            const segs = getSegmentsInRange(tooltip.cell.freqMin, tooltip.cell.freqMax)
              .filter((s) => (s.end_hz - s.start_hz) > 1);
            if (segs.length === 0) return null;
            return (
              <div className="mt-1 border-t border-gray-700 pt-1">
                {segs.slice(0, 2).map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: s.color }}
                    />
                    <span style={{ color: s.color }} className="text-[10px]">
                      {s.band} {s.label}
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
          {tooltip.cell.count > 0 && (
            <div className="text-gray-500 mt-0.5 text-[10px]">
              Click to browse
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Color Legend ──────────────────────────────────────────────────────

function ColorLegend({ maxCount }: { maxCount: number }) {
  const steps = 6;
  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span>Quiet</span>
      {Array.from({ length: steps }, (_, i) => {
        const count = Math.round((i / (steps - 1)) * maxCount);
        return (
          <div
            key={i}
            className="w-5 h-3 rounded-sm"
            style={{ backgroundColor: intensityColor(count, maxCount) }}
          />
        );
      })}
      <span>Active ({maxCount})</span>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

function WaterfallPage() {
  const navigate = useNavigate();
  const [band, setBand] = useState<BandKey>("2m");
  const [timeRange, setTimeRange] = useState<TimeRange>("6h");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const bandDef = BANDS[band];
  const hours = TIME_RANGES.find((t) => t.key === timeRange)!.hours;
  const dateFrom = useMemo(() => {
    const d = new Date(Date.now() - hours * 3600_000);
    return d.toISOString();
  }, [hours]);

  // Fetch recordings for the selected band + time range
  const {
    data: browseData,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ["waterfall-data", band, timeRange, dateFrom],
    queryFn: () =>
      browseFiles({
        frequency_min: bandDef.minHz,
        frequency_max: bandDef.maxHz,
        date_from: dateFrom,
        limit: 2000,
      }),
    refetchInterval: autoRefresh ? 30_000 : false,
    staleTime: 15_000,
  });

  const recordings = browseData?.items ?? [];

  // Build the grid
  const grid = useMemo(
    () => buildGrid(recordings, bandDef, timeRange),
    [recordings, bandDef, timeRange]
  );

  // Top frequencies
  const topFreqs = useMemo(
    () => topFrequencies(recordings, 5),
    [recordings]
  );

  // Activity stats
  const totalRecordings = browseData?.total ?? recordings.length;
  const signalDensity =
    hours > 0 ? (totalRecordings / hours).toFixed(1) : "0";

  // Cell click handler
  const handleCellClick = useCallback(
    (cell: GridCell) => {
      const params = new URLSearchParams();
      params.set("frequency_min", String(cell.freqMin));
      params.set("frequency_max", String(cell.freqMax));
      params.set("date_from", cell.timeStart.toISOString());
      params.set("date_to", cell.timeEnd.toISOString());
      navigate(`/browse?${params.toString()}`);
    },
    [navigate]
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">
            Band Activity Waterfall
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Time vs. frequency heatmap of signal activity
          </p>
        </div>
        {isFetching && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Updating...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          {/* Band selector */}
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Band
            </label>
            <div className="flex gap-1">
              {Object.entries(BANDS).map(([key, def]) => (
                <button
                  key={key}
                  onClick={() => setBand(key as BandKey)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                    band === key
                      ? "bg-green-700 text-green-100"
                      : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                  }`}
                >
                  {def.label}
                </button>
              ))}
            </div>
          </div>

          {/* Time range */}
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Time Range
            </label>
            <div className="flex gap-1">
              {TIME_RANGES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTimeRange(t.key)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                    timeRange === t.key
                      ? "bg-green-700 text-green-100"
                      : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-refresh toggle */}
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Auto-refresh
            </label>
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors flex items-center gap-2 ${
                autoRefresh
                  ? "bg-green-700 text-green-100"
                  : "bg-gray-700 text-gray-400"
              }`}
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  autoRefresh ? "bg-green-300 animate-pulse" : "bg-gray-500"
                }`}
              />
              {autoRefresh ? "ON (30s)" : "OFF"}
            </button>
          </div>

          {/* Band info */}
          <div className="ml-auto text-right">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Range
            </div>
            <div className="text-sm text-gray-300 font-mono">
              {formatFrequency(bandDef.minHz)} &ndash;{" "}
              {formatFrequency(bandDef.maxHz)}
            </div>
            <div className="text-[10px] text-gray-600">
              {bandDef.binWidthHz >= 1000
                ? `${bandDef.binWidthHz / 1000} kHz`
                : `${bandDef.binWidthHz} Hz`}{" "}
              bins, {getTimeBinMinutes(timeRange)}-min rows
            </div>
          </div>
        </div>
      </div>

      {/* Main content: Waterfall + Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Waterfall Grid -- 3 cols */}
        <div className="lg:col-span-3 bg-gray-800 rounded-lg border border-gray-700 p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 border-2 border-gray-500 border-t-green-400 rounded-full animate-spin" />
                Loading waterfall data...
              </div>
            </div>
          ) : recordings.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 text-sm">
              <svg
                className="w-12 h-12 text-gray-700 mb-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
              <div>No recordings in this band for the selected time range.</div>
              <div className="text-gray-600 text-xs mt-1">
                Try a different band or longer time range.
              </div>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <WaterfallGrid
                  grid={grid}
                  band={bandDef}
                  onCellClick={handleCellClick}
                />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <ColorLegend maxCount={grid.maxCount} />
                <div className="text-[10px] text-gray-600">
                  Newest at top. Click a cell to browse recordings.
                </div>
              </div>
            </>
          )}
        </div>

        {/* Sidebar -- 1 col */}
        <div className="space-y-4">
          {/* Activity Summary */}
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
            <h2 className="text-sm font-semibold text-gray-200 mb-3">
              Activity Summary
            </h2>
            <div className="space-y-3">
              <div>
                <div className="text-2xl font-bold text-gray-100">
                  {totalRecordings.toLocaleString()}
                </div>
                <div className="text-xs text-gray-500">
                  Total recordings in range
                </div>
              </div>
              <div>
                <div className="text-lg font-semibold text-gray-200">
                  {signalDensity}
                </div>
                <div className="text-xs text-gray-500">Recordings per hour</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-gray-200">
                  {grid.maxCount}
                </div>
                <div className="text-xs text-gray-500">
                  Peak count in single cell
                </div>
              </div>
            </div>
          </div>

          {/* Top Frequencies */}
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
            <h2 className="text-sm font-semibold text-gray-200 mb-3">
              Most Active Frequencies
            </h2>
            {topFreqs.length === 0 ? (
              <div className="text-gray-600 text-xs">
                No activity in this range
              </div>
            ) : (
              <div className="space-y-2">
                {topFreqs.map((f, i) => {
                  const barPct =
                    topFreqs[0].count > 0
                      ? Math.round((f.count / topFreqs[0].count) * 100)
                      : 0;
                  return (
                    <button
                      key={f.freqHz}
                      onClick={() => navigate(`/frequency/${f.freqHz}`)}
                      className="w-full text-left group"
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-4 text-gray-600 font-mono">
                          {i + 1}
                        </span>
                        <span className="flex-1 font-mono text-gray-200 group-hover:text-green-300 transition-colors truncate">
                          {f.label}
                        </span>
                        <span className="text-gray-400 font-mono">
                          {f.count}
                        </span>
                      </div>
                      <div className="ml-6 mt-0.5 bg-gray-700/50 rounded h-1.5">
                        <div
                          className="bg-green-600 h-1.5 rounded transition-all"
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick band jumps */}
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
            <h2 className="text-sm font-semibold text-gray-200 mb-3">
              Band Info
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Band</span>
                <span className="text-gray-200 font-mono">
                  {bandDef.label}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Freq bins</span>
                <span className="text-gray-200 font-mono">{grid.cols}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Time bins</span>
                <span className="text-gray-200 font-mono">{grid.rows}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Grid cells</span>
                <span className="text-gray-200 font-mono">
                  {(grid.rows * grid.cols).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Active cells</span>
                <span className="text-green-400 font-mono">
                  {grid.cells.filter((c) => c.count > 0).length.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WaterfallPage;
