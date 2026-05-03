import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  getSpectrum,
  SpectrumCapture,
  SpectrumDetection,
} from "../api/client";

// ── Band presets ─────────────────────────────────────────────────────

interface BandPreset {
  label: string;
  captureId: string | null; // null = show all captures
  defaultMinHz: number;
  defaultMaxHz: number;
}

const BAND_PRESETS: Record<string, BandPreset> = {
  all: {
    label: "All",
    captureId: null,
    defaultMinHz: 0,
    defaultMaxHz: 1_000_000_000,
  },
  "2m": {
    label: "2m VHF",
    captureId: "2m",
    defaultMinHz: 144_000_000,
    defaultMaxHz: 148_000_000,
  },
  "70cm": {
    label: "70cm UHF",
    captureId: "70cm",
    defaultMinHz: 420_000_000,
    defaultMaxHz: 450_000_000,
  },
  pager: {
    label: "Pager",
    captureId: "pager",
    defaultMinHz: 929_000_000,
    defaultMaxHz: 932_000_000,
  },
};

type BandKey = keyof typeof BAND_PRESETS;

// ── Helpers ──────────────────────────────────────────────────────────

function formatFreqMHz(hz: number): string {
  return (hz / 1e6).toFixed(4);
}

function formatFreqLabel(hz: number): string {
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(3)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function modeColor(mode: string): string {
  switch (mode.toLowerCase()) {
    case "fm":
    case "nbfm":
      return "#22c55e"; // green-500
    case "cw":
      return "#eab308"; // yellow-500
    case "am":
      return "#3b82f6"; // blue-500
    case "ssb":
      return "#a855f7"; // purple-500
    case "digital":
      return "#06b6d4"; // cyan-500
    default:
      return "#6b7280"; // gray-500
  }
}

function modeColorBright(mode: string): string {
  switch (mode.toLowerCase()) {
    case "fm":
    case "nbfm":
      return "#4ade80"; // green-400
    case "cw":
      return "#facc15"; // yellow-400
    case "am":
      return "#60a5fa"; // blue-400
    case "ssb":
      return "#c084fc"; // purple-400
    case "digital":
      return "#22d3ee"; // cyan-400
    default:
      return "#9ca3af"; // gray-400
  }
}

// ── SVG Spectrum Display ─────────────────────────────────────────────

interface SpectrumChartProps {
  captures: SpectrumCapture[];
  band: BandPreset;
}

function SpectrumChart({ captures, band }: SpectrumChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    det: SpectrumDetection;
    captureId: string;
  } | null>(null);

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

  // Collect all detections across captures for the view
  const allDetections = useMemo(() => {
    const result: { det: SpectrumDetection; captureId: string; noiseFloor: number | null }[] = [];
    for (const cap of captures) {
      for (const det of cap.detections) {
        result.push({
          det,
          captureId: cap.capture_id,
          noiseFloor: cap.noise_floor_db,
        });
      }
    }
    return result.sort((a, b) => a.det.frequency_hz - b.det.frequency_hz);
  }, [captures]);

  // Determine frequency range
  const { minFreq, maxFreq, noiseFloor, minPower, maxPower } = useMemo(() => {
    if (allDetections.length === 0) {
      return {
        minFreq: band.defaultMinHz,
        maxFreq: band.defaultMaxHz,
        noiseFloor: -80,
        minPower: -100,
        maxPower: -20,
      };
    }

    // Use capture center_freq +/- sample_rate/2 or detection extent, whichever is wider
    let fMin = Infinity;
    let fMax = -Infinity;
    for (const cap of captures) {
      if (cap.center_freq_hz && cap.sample_rate) {
        const halfBw = cap.sample_rate / 2;
        fMin = Math.min(fMin, cap.center_freq_hz - halfBw);
        fMax = Math.max(fMax, cap.center_freq_hz + halfBw);
      }
      for (const d of cap.detections) {
        fMin = Math.min(fMin, d.frequency_hz - (d.bandwidth_hz || 5000));
        fMax = Math.max(fMax, d.frequency_hz + (d.bandwidth_hz || 5000));
      }
    }

    // If band preset has narrower defaults that contain all data, use them
    if (band.captureId !== null) {
      fMin = band.defaultMinHz;
      fMax = band.defaultMaxHz;
    }

    // Power range
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const { det } of allDetections) {
      pMin = Math.min(pMin, det.power_db);
      pMax = Math.max(pMax, det.power_db);
    }

    // Noise floor: use first capture that has it
    let nf = -80;
    for (const cap of captures) {
      if (cap.noise_floor_db !== null && cap.noise_floor_db !== undefined) {
        nf = cap.noise_floor_db;
        break;
      }
    }

    // Add margin to power axis
    const powerMargin = 5;
    pMin = Math.min(nf - 10, pMin - powerMargin);
    pMax = pMax + powerMargin;

    return {
      minFreq: fMin,
      maxFreq: fMax,
      noiseFloor: nf,
      minPower: pMin,
      maxPower: pMax,
    };
  }, [allDetections, captures, band]);

  // Chart dimensions
  const LEFT_MARGIN = 64;
  const RIGHT_MARGIN = 16;
  const TOP_MARGIN = 16;
  const BOTTOM_MARGIN = 48;
  const plotWidth = Math.max(containerWidth - LEFT_MARGIN - RIGHT_MARGIN, 100);
  const plotHeight = 320;
  const svgWidth = LEFT_MARGIN + plotWidth + RIGHT_MARGIN;
  const svgHeight = TOP_MARGIN + plotHeight + BOTTOM_MARGIN;

  // Scale functions
  const freqToX = useCallback(
    (hz: number) => LEFT_MARGIN + ((hz - minFreq) / (maxFreq - minFreq)) * plotWidth,
    [minFreq, maxFreq, plotWidth]
  );

  const powerToY = useCallback(
    (db: number) =>
      TOP_MARGIN + plotHeight - ((db - minPower) / (maxPower - minPower)) * plotHeight,
    [minPower, maxPower, plotHeight]
  );

  // Frequency axis labels (~10 labels)
  const freqLabels = useMemo(() => {
    const count = 10;
    const step = (maxFreq - minFreq) / count;
    const labels: { hz: number; x: number; label: string }[] = [];
    for (let i = 0; i <= count; i++) {
      const hz = minFreq + i * step;
      labels.push({ hz, x: freqToX(hz), label: formatFreqMHz(hz) });
    }
    return labels;
  }, [minFreq, maxFreq, freqToX]);

  // Power axis labels (~6 labels)
  const powerLabels = useMemo(() => {
    const count = 6;
    const step = (maxPower - minPower) / count;
    const labels: { db: number; y: number; label: string }[] = [];
    for (let i = 0; i <= count; i++) {
      const db = minPower + i * step;
      labels.push({ db, y: powerToY(db), label: `${Math.round(db)}` });
    }
    return labels;
  }, [minPower, maxPower, powerToY]);

  // Noise floor Y position
  const noiseFloorY = powerToY(noiseFloor);

  // Mouse handling for tooltips
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Find closest detection within 12px
      let closest: { det: SpectrumDetection; captureId: string; dist: number } | null = null;
      for (const { det, captureId } of allDetections) {
        const dx = freqToX(det.frequency_hz) - mx;
        const dy = powerToY(det.power_db) - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 20 && (!closest || dist < closest.dist)) {
          closest = { det, captureId, dist };
        }
      }

      if (closest) {
        setTooltip({
          x: e.clientX,
          y: e.clientY,
          det: closest.det,
          captureId: closest.captureId,
        });
      } else {
        setTooltip(null);
      }
    },
    [allDetections, freqToX, powerToY]
  );

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        width={svgWidth}
        height={svgHeight}
        className="block"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        style={{ cursor: "crosshair" }}
      >
        {/* Background */}
        <rect
          x={LEFT_MARGIN}
          y={TOP_MARGIN}
          width={plotWidth}
          height={plotHeight}
          fill="#0a0a0a"
          rx={2}
        />

        {/* Grid lines - horizontal (power) */}
        {powerLabels.map(({ db, y }) => (
          <g key={`pwr-${db}`}>
            <line
              x1={LEFT_MARGIN}
              y1={y}
              x2={LEFT_MARGIN + plotWidth}
              y2={y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
            <text
              x={LEFT_MARGIN - 6}
              y={y + 4}
              fill="#6b7280"
              fontSize={10}
              textAnchor="end"
              fontFamily="monospace"
            >
              {`${Math.round(db)}`}
            </text>
          </g>
        ))}

        {/* Grid lines - vertical (frequency) */}
        {freqLabels.map(({ hz, x, label }) => (
          <g key={`freq-${hz}`}>
            <line
              x1={x}
              y1={TOP_MARGIN}
              x2={x}
              y2={TOP_MARGIN + plotHeight}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
            <text
              x={x}
              y={TOP_MARGIN + plotHeight + 18}
              fill="#6b7280"
              fontSize={10}
              textAnchor="middle"
              fontFamily="monospace"
            >
              {label}
            </text>
          </g>
        ))}

        {/* Noise floor line */}
        {noiseFloor !== null && (
          <>
            <line
              x1={LEFT_MARGIN}
              y1={noiseFloorY}
              x2={LEFT_MARGIN + plotWidth}
              y2={noiseFloorY}
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="6,4"
              opacity={0.5}
            />
            <text
              x={LEFT_MARGIN + plotWidth - 4}
              y={noiseFloorY - 4}
              fill="#ef4444"
              fontSize={9}
              textAnchor="end"
              fontFamily="monospace"
              opacity={0.7}
            >
              Noise Floor {Math.round(noiseFloor)} dB
            </text>
          </>
        )}

        {/* Detection peaks - bars from noise floor to peak power */}
        {allDetections.map(({ det, captureId }, i) => {
          const x = freqToX(det.frequency_hz);
          const yTop = powerToY(det.power_db);
          const yBot = noiseFloorY;
          const barWidth = Math.max(
            ((det.bandwidth_hz || 5000) / (maxFreq - minFreq)) * plotWidth,
            3
          );
          const color = modeColor(det.mode);
          const isRecording = det.recording;

          return (
            <g key={`det-${captureId}-${i}`}>
              {/* Signal bar */}
              <rect
                x={x - barWidth / 2}
                y={yTop}
                width={barWidth}
                height={Math.max(yBot - yTop, 1)}
                fill={color}
                opacity={0.35}
                rx={1}
              />
              {/* Peak line */}
              <line
                x1={x - barWidth / 2}
                y1={yTop}
                x2={x + barWidth / 2}
                y2={yTop}
                stroke={color}
                strokeWidth={2}
              />
              {/* Peak dot */}
              <circle
                cx={x}
                cy={yTop}
                r={3.5}
                fill={isRecording ? "#f59e0b" : color}
                stroke={isRecording ? "#fbbf24" : "none"}
                strokeWidth={isRecording ? 1.5 : 0}
              />
              {/* Recording indicator pulse */}
              {isRecording && (
                <circle
                  cx={x}
                  cy={yTop}
                  r={7}
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={1}
                  opacity={0.6}
                >
                  <animate
                    attributeName="r"
                    from="5"
                    to="12"
                    dur="1.5s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    from="0.6"
                    to="0"
                    dur="1.5s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Y-axis label */}
        <text
          x={14}
          y={TOP_MARGIN + plotHeight / 2}
          fill="#6b7280"
          fontSize={10}
          textAnchor="middle"
          fontFamily="monospace"
          transform={`rotate(-90, 14, ${TOP_MARGIN + plotHeight / 2})`}
        >
          Power (dB)
        </text>

        {/* X-axis label */}
        <text
          x={LEFT_MARGIN + plotWidth}
          y={TOP_MARGIN + plotHeight + 38}
          fill="#6b7280"
          fontSize={10}
          textAnchor="end"
          fontFamily="monospace"
        >
          Frequency (MHz)
        </text>
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
          <div className="text-gray-200 font-mono font-semibold">
            {formatFreqLabel(tooltip.det.frequency_hz)}
          </div>
          <div className="mt-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Power:</span>
              <span className="text-gray-200 font-mono">
                {tooltip.det.power_db.toFixed(1)} dB
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Mode:</span>
              <span
                className="font-mono font-semibold"
                style={{ color: modeColorBright(tooltip.det.mode) }}
              >
                {tooltip.det.mode.toUpperCase()}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">BW:</span>
              <span className="text-gray-200 font-mono">
                {tooltip.det.bandwidth_hz >= 1000
                  ? `${(tooltip.det.bandwidth_hz / 1000).toFixed(1)} kHz`
                  : `${tooltip.det.bandwidth_hz} Hz`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Capture:</span>
              <span className="text-gray-300">{tooltip.captureId}</span>
            </div>
            {tooltip.det.recording && (
              <div className="flex items-center gap-1 mt-1 text-amber-400">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="8" />
                </svg>
                Recording in progress
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Detection list table ─────────────────────────────────────────────

function DetectionTable({
  captures,
}: {
  captures: SpectrumCapture[];
}) {
  const navigate = useNavigate();
  const allDetections = useMemo(() => {
    const result: {
      det: SpectrumDetection;
      captureId: string;
      noiseFloor: number | null;
    }[] = [];
    for (const cap of captures) {
      for (const det of cap.detections) {
        result.push({
          det,
          captureId: cap.capture_id,
          noiseFloor: cap.noise_floor_db,
        });
      }
    }
    return result.sort((a, b) => b.det.power_db - a.det.power_db);
  }, [captures]);

  if (allDetections.length === 0) {
    return (
      <div className="text-gray-600 text-sm text-center py-4">
        No signals detected
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-700">
            <th className="text-left py-2 px-2 font-medium">Frequency</th>
            <th className="text-left py-2 px-2 font-medium">Mode</th>
            <th className="text-right py-2 px-2 font-medium">Power</th>
            <th className="text-right py-2 px-2 font-medium">SNR</th>
            <th className="text-right py-2 px-2 font-medium">BW</th>
            <th className="text-center py-2 px-2 font-medium">Capture</th>
            <th className="text-center py-2 px-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {allDetections.map(({ det, captureId, noiseFloor }, i) => {
            const snr =
              noiseFloor !== null
                ? (det.power_db - noiseFloor).toFixed(1)
                : "--";
            return (
              <tr
                key={`${captureId}-${i}`}
                className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors"
                onClick={() =>
                  navigate(
                    `/frequency/${Math.round(det.frequency_hz)}`
                  )
                }
              >
                <td className="py-2 px-2 font-mono text-gray-200">
                  {formatFreqLabel(det.frequency_hz)}
                </td>
                <td className="py-2 px-2">
                  <span
                    className="font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded"
                    style={{
                      color: modeColorBright(det.mode),
                      backgroundColor: `${modeColor(det.mode)}20`,
                    }}
                  >
                    {det.mode.toUpperCase()}
                  </span>
                </td>
                <td className="py-2 px-2 text-right font-mono text-gray-300">
                  {det.power_db.toFixed(1)} dB
                </td>
                <td className="py-2 px-2 text-right font-mono text-gray-400">
                  {snr} dB
                </td>
                <td className="py-2 px-2 text-right font-mono text-gray-400">
                  {det.bandwidth_hz >= 1000
                    ? `${(det.bandwidth_hz / 1000).toFixed(1)}k`
                    : `${det.bandwidth_hz}`}
                </td>
                <td className="py-2 px-2 text-center text-gray-400">
                  {captureId}
                </td>
                <td className="py-2 px-2 text-center">
                  {det.recording ? (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      REC
                    </span>
                  ) : (
                    <span className="text-gray-600">--</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

function SpectrumPage() {
  const [band, setBand] = useState<BandKey>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshRate, setRefreshRate] = useState(2000);

  const bandPreset = BAND_PRESETS[band];

  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["spectrum", bandPreset.captureId],
    queryFn: () => getSpectrum(bandPreset.captureId ?? undefined),
    refetchInterval: autoRefresh ? refreshRate : false,
    staleTime: 1000,
  });

  const captures = data?.captures ?? [];
  const totalSignals = captures.reduce(
    (sum, c) => sum + c.detections.length,
    0
  );
  const recordingCount = captures.reduce(
    (sum, c) => sum + c.detections.filter((d) => d.recording).length,
    0
  );
  const freshestAge = captures.length
    ? Math.min(...captures.map((c) => c.age_seconds))
    : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">
            Live Spectrum Analyzer
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Real-time FFT detection data from SDR receivers
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isFetching && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Updating...
            </div>
          )}
          {dataUpdatedAt > 0 && (
            <div className="text-[10px] text-gray-600 font-mono">
              Last update: {new Date(dataUpdatedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
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
              {Object.entries(BAND_PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  onClick={() => setBand(key as BandKey)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                    band === key
                      ? "bg-green-700 text-green-100"
                      : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Refresh rate */}
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Refresh
            </label>
            <div className="flex gap-1">
              {[
                { ms: 1000, label: "1s" },
                { ms: 2000, label: "2s" },
                { ms: 5000, label: "5s" },
              ].map((opt) => (
                <button
                  key={opt.ms}
                  onClick={() => setRefreshRate(opt.ms)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                    refreshRate === opt.ms
                      ? "bg-green-700 text-green-100"
                      : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-refresh toggle */}
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Live
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
              {autoRefresh ? "ON" : "OFF"}
            </button>
          </div>

          {/* Status summary */}
          <div className="ml-auto flex gap-6 text-right">
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                Signals
              </div>
              <div className="text-lg font-bold text-gray-100 font-mono">
                {totalSignals}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                Recording
              </div>
              <div
                className={`text-lg font-bold font-mono ${
                  recordingCount > 0 ? "text-amber-400" : "text-gray-600"
                }`}
              >
                {recordingCount}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                Data Age
              </div>
              <div
                className={`text-lg font-bold font-mono ${
                  freshestAge !== null && freshestAge < 10
                    ? "text-green-400"
                    : freshestAge !== null && freshestAge < 30
                    ? "text-yellow-400"
                    : "text-red-400"
                }`}
              >
                {freshestAge !== null ? `${Math.round(freshestAge)}s` : "--"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Spectrum chart */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-200">
            Spectrum Display
          </h2>
          <div className="flex items-center gap-4 text-[10px]">
            {/* Legend */}
            <div className="flex items-center gap-3">
              {["FM", "CW", "AM", "SSB", "Digital"].map((m) => (
                <div key={m} className="flex items-center gap-1">
                  <div
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ backgroundColor: modeColor(m.toLowerCase()) }}
                  />
                  <span className="text-gray-400">{m}</span>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-gray-400">Recording</span>
              </div>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-80 text-gray-500 text-sm">
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 border-2 border-gray-500 border-t-green-400 rounded-full animate-spin" />
              Loading spectrum data...
            </div>
          </div>
        ) : captures.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-80 text-gray-500 text-sm">
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
            <div>No detection data available.</div>
            <div className="text-gray-600 text-xs mt-1">
              Waiting for SDR detection files...
            </div>
          </div>
        ) : (
          <SpectrumChart captures={captures} band={bandPreset} />
        )}
      </div>

      {/* Bottom: detection table + capture info */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Detection table -- 3 cols */}
        <div className="lg:col-span-3 bg-gray-800 rounded-lg border border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-200 mb-3">
            Detected Signals
          </h2>
          <DetectionTable captures={captures} />
        </div>

        {/* Capture info sidebar -- 1 col */}
        <div className="space-y-4">
          {captures.map((cap) => (
            <div
              key={cap.capture_id}
              className="bg-gray-800 rounded-lg border border-gray-700 p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-200">
                  {cap.capture_id.toUpperCase()}
                </h3>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    cap.stale
                      ? "bg-red-900/50 text-red-400"
                      : "bg-green-900/50 text-green-400"
                  }`}
                >
                  {cap.stale ? "STALE" : "LIVE"}
                </span>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Center</span>
                  <span className="text-gray-200 font-mono">
                    {formatFreqLabel(cap.center_freq_hz)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Sample Rate</span>
                  <span className="text-gray-200 font-mono">
                    {cap.sample_rate >= 1e6
                      ? `${(cap.sample_rate / 1e6).toFixed(2)} MHz`
                      : `${(cap.sample_rate / 1e3).toFixed(0)} kHz`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Noise Floor</span>
                  <span className="text-gray-200 font-mono">
                    {cap.noise_floor_db !== null
                      ? `${cap.noise_floor_db.toFixed(1)} dB`
                      : "--"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Signals</span>
                  <span className="text-green-400 font-mono">
                    {cap.detections.length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Data Age</span>
                  <span
                    className={`font-mono ${
                      cap.age_seconds < 10
                        ? "text-green-400"
                        : cap.age_seconds < 30
                        ? "text-yellow-400"
                        : "text-red-400"
                    }`}
                  >
                    {cap.age_seconds.toFixed(0)}s ago
                  </span>
                </div>
                {cap.detections.filter((d) => d.recording).length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Recording</span>
                    <span className="text-amber-400 font-mono">
                      {cap.detections.filter((d) => d.recording).length} active
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}

          {captures.length === 0 && !isLoading && (
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
              <div className="text-gray-500 text-xs text-center">
                No capture sources available
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SpectrumPage;
