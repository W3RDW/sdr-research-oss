import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { browseFiles, type Recording } from "../api/client";
import { formatDateTime, formatTime } from "../utils/time";

/* ── helpers ─────────────────────────────────────────────────────────── */

function formatFrequency(hz: number | null): string {
  if (hz == null) return "Unknown freq";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  return `${(hz / 1_000).toFixed(1)} kHz`;
}

function bandForFrequency(hz: number | null): string {
  if (hz == null) return "unknown";
  if (hz < 30_000_000) return "hf";
  if (hz >= 144_000_000 && hz <= 148_000_000) return "2m";
  if (hz >= 420_000_000 && hz <= 450_000_000) return "70cm";
  return "other";
}

function bandLabel(hz: number | null): string | null {
  if (hz == null) return null;
  const b = bandForFrequency(hz);
  if (b === "hf") return "HF";
  if (b === "2m") return "2m";
  if (b === "70cm") return "70cm";
  return null;
}

function imageUrl(id: number): string {
  return `/api/v1/files/${id}/image`;
}

function relativeTime(ts: string | null): string {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z").getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/* ── constants ───────────────────────────────────────────────────────── */

const TIME_OPTIONS = [
  { label: "24h", value: 24 },
  { label: "48h", value: 48 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
  { label: "All", value: 0 },
];

const BAND_OPTIONS = [
  { label: "All Bands", value: "all" },
  { label: "HF", value: "hf" },
  { label: "2m", value: "2m" },
  { label: "70cm", value: "70cm" },
];

const BAND_FREQ_RANGES: Record<string, { min?: number; max?: number }> = {
  all: {},
  hf: { min: 1_000, max: 30_000_000 },
  "2m": { min: 144_000_000, max: 148_000_000 },
  "70cm": { min: 420_000_000, max: 450_000_000 },
};

const AUTO_REFRESH_INTERVAL = 60_000;

/* ── Lightbox component ──────────────────────────────────────────────── */

interface LightboxProps {
  captures: Recording[];
  selectedIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

function Lightbox({ captures, selectedIndex, onClose, onNavigate }: LightboxProps) {
  const cap = captures[selectedIndex];
  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex < captures.length - 1;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onNavigate(selectedIndex - 1);
      else if (e.key === "ArrowRight" && hasNext) onNavigate(selectedIndex + 1);
    },
    [onClose, onNavigate, selectedIndex, hasPrev, hasNext]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [handleKeyDown]);

  if (!cap) return null;

  return (
    <div
      className="fixed inset-0 bg-black/90 z-50 flex"
      onClick={onClose}
    >
      {/* Navigation arrow left */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (hasPrev) onNavigate(selectedIndex - 1);
        }}
        disabled={!hasPrev}
        className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-black/50 text-white text-2xl hover:bg-black/70 transition-colors disabled:opacity-20 disabled:cursor-default"
        aria-label="Previous image"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      {/* Navigation arrow right */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (hasNext) onNavigate(selectedIndex + 1);
        }}
        disabled={!hasNext}
        className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-black/50 text-white text-2xl hover:bg-black/70 transition-colors disabled:opacity-20 disabled:cursor-default md:right-80"
        aria-label="Next image"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute top-3 right-3 z-10 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors md:right-[calc(20rem+0.75rem)]"
        aria-label="Close lightbox"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Main image area */}
      <div
        className="flex-1 flex items-center justify-center p-4 md:pr-0"
        onClick={onClose}
      >
        <img
          src={imageUrl(cap.id)}
          alt={`SSTV capture ${cap.filename}`}
          className="max-h-[90vh] max-w-full object-contain rounded shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onError={(e) => {
            const el = e.target as HTMLImageElement;
            el.alt = "Image unavailable";
            el.style.border = "1px solid #374151";
            el.style.padding = "2rem";
          }}
        />
      </div>

      {/* Metadata sidebar */}
      <div
        className="hidden md:flex flex-col w-80 bg-gray-900 border-l border-gray-700 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white mb-1">Image Details</h3>
          <p className="text-xs text-gray-500">
            {selectedIndex + 1} of {captures.length}
          </p>
        </div>

        <div className="p-5 space-y-4 flex-1">
          {/* Frequency */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              Frequency
            </label>
            <p className="text-cyan-400 font-mono text-sm">
              {formatFrequency(cap.frequency_hz)}
            </p>
            {cap.frequency_label && (
              <p className="text-gray-400 text-xs mt-0.5">{cap.frequency_label}</p>
            )}
            {bandLabel(cap.frequency_hz) && (
              <span className="inline-block mt-1 px-2 py-0.5 text-xs rounded bg-gray-800 text-gray-300 border border-gray-700">
                {bandLabel(cap.frequency_hz)}
              </span>
            )}
          </div>

          {/* Timestamp */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              Captured
            </label>
            <p className="text-white text-sm">{formatDateTime(cap.timestamp)}</p>
            <p className="text-gray-500 text-xs mt-0.5">{relativeTime(cap.timestamp)}</p>
          </div>

          {/* Source SDR */}
          {cap.source_sdr && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                Source SDR
              </label>
              <p className="text-white text-sm">{cap.source_sdr}</p>
            </div>
          )}

          {/* Mode */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              Mode
            </label>
            <span className="inline-block px-2 py-0.5 text-xs rounded bg-purple-900/60 text-purple-300 border border-purple-700/50">
              SSTV
            </span>
          </div>

          {/* Signal */}
          {cap.signal_db != null && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                Signal
              </label>
              <p className="text-white text-sm font-mono">{cap.signal_db.toFixed(1)} dB</p>
            </div>
          )}

          {/* Tags */}
          {cap.tags && cap.tags.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                Tags
              </label>
              <div className="flex flex-wrap gap-1">
                {cap.tags.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-0.5 text-xs rounded bg-gray-800 text-gray-300 border border-gray-700"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Filename */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              Filename
            </label>
            <p className="text-gray-400 text-xs font-mono break-all">{cap.filename}</p>
          </div>
        </div>

        {/* Download footer */}
        <div className="p-5 border-t border-gray-700">
          <a
            href={imageUrl(cap.id)}
            download={cap.filename}
            className="block w-full text-center px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-sm font-medium text-white transition-colors"
          >
            Download Image
          </a>
        </div>
      </div>

      {/* Mobile metadata (bottom sheet) */}
      <div
        className="md:hidden fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-cyan-400 font-mono text-sm">{formatFrequency(cap.frequency_hz)}</p>
            <p className="text-gray-400 text-xs">{formatDateTime(cap.timestamp)}</p>
          </div>
          <div className="flex items-center gap-2">
            {cap.source_sdr && (
              <span className="text-xs text-gray-500">{cap.source_sdr}</span>
            )}
            <span className="px-2 py-0.5 text-xs rounded bg-purple-900/60 text-purple-300 border border-purple-700/50">
              SSTV
            </span>
            <a
              href={imageUrl(cap.id)}
              download={cap.filename}
              className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-xs font-medium text-white transition-colors"
            >
              Save
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Stats Bar ───────────────────────────────────────────────────────── */

interface StatsBarProps {
  total: number;
  todayCount: number;
  lastDecode: string | null;
}

function StatsBar({ total, todayCount, lastDecode }: StatsBarProps) {
  return (
    <div className="grid grid-cols-3 gap-3 mb-4">
      <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Total Images</p>
        <p className="text-xl font-bold text-white mt-0.5">{total.toLocaleString()}</p>
      </div>
      <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Today</p>
        <p className="text-xl font-bold text-green-400 mt-0.5">{todayCount.toLocaleString()}</p>
      </div>
      <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Last Decode</p>
        <p className="text-sm font-medium text-gray-300 mt-1">
          {lastDecode ? relativeTime(lastDecode) : "---"}
        </p>
        {lastDecode && (
          <p className="text-xs text-gray-500">{formatTime(lastDecode)}</p>
        )}
      </div>
    </div>
  );
}

/* ── Main page component ─────────────────────────────────────────────── */

export default function SStvPage() {
  const [hours, setHours] = useState(168);
  const [band, setBand] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [page, setPage] = useState(1);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limit = 48;

  const now = new Date();
  const dateFrom =
    hours > 0
      ? new Date(now.getTime() - hours * 3_600_000).toISOString().slice(0, 19)
      : undefined;

  const freqRange = BAND_FREQ_RANGES[band] ?? {};

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["sstv-captures", hours, band, page],
    queryFn: () =>
      browseFiles({
        mode: "sstv",
        date_from: dateFrom,
        frequency_min: freqRange.min,
        frequency_max: freqRange.max,
        page,
        limit,
      }),
    staleTime: autoRefresh ? AUTO_REFRESH_INTERVAL - 5_000 : 60_000,
  });

  // Separate query for today's count (always last 24h, no band filter)
  const todayFrom = new Date(now.getTime() - 24 * 3_600_000).toISOString().slice(0, 19);
  const { data: todayData } = useQuery({
    queryKey: ["sstv-today-count"],
    queryFn: () =>
      browseFiles({
        mode: "sstv",
        date_from: todayFrom,
        page: 1,
        limit: 1,
      }),
    staleTime: 60_000,
  });

  const captures = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const todayCount = todayData?.total ?? 0;
  const lastDecode = captures.length > 0 ? captures[0].timestamp : null;

  // Auto-refresh
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (autoRefresh) {
      refreshTimerRef.current = setInterval(() => {
        refetch();
      }, AUTO_REFRESH_INTERVAL);
    }
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [autoRefresh, refetch]);

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const navigateLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">SSTV Gallery</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Slow-Scan Television image captures decoded from radio frequencies
          </p>
        </div>
      </div>

      {/* Stats bar */}
      <StatsBar total={total} todayCount={todayCount} lastDecode={lastDecode} />

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Time range */}
        <div className="flex gap-1">
          {TIME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setHours(opt.value);
                setPage(1);
                setLightboxIndex(null);
              }}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                hours === opt.value
                  ? "bg-green-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Band filter */}
        <div className="flex gap-1">
          {BAND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setBand(opt.value);
                setPage(1);
                setLightboxIndex(null);
              }}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                band === opt.value
                  ? "bg-cyan-700 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Auto-refresh toggle */}
        <button
          onClick={() => setAutoRefresh((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            autoRefresh
              ? "bg-green-800 text-green-200 border border-green-600"
              : "bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-700"
          }`}
          title={autoRefresh ? "Auto-refresh enabled (60s)" : "Enable auto-refresh"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={autoRefresh ? "animate-spin" : ""}
            style={autoRefresh ? { animationDuration: "3s" } : undefined}
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {autoRefresh ? "Live" : "Auto"}
        </button>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="text-center py-16">
          <div className="inline-block w-8 h-8 border-2 border-gray-600 border-t-green-500 rounded-full animate-spin mb-3" />
          <p className="text-gray-400">Loading SSTV captures...</p>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-400">
          <p className="font-medium">Failed to load captures</p>
          <p className="text-sm mt-1 text-red-500">{String(error)}</p>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && captures.length === 0 && (
        <div className="text-center py-20">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gray-800 border border-gray-700 mb-5">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-300 mb-2">
            No SSTV images decoded yet
          </h2>
          <p className="text-gray-500 max-w-md mx-auto mb-4">
            SSTV (Slow-Scan Television) is a method of transmitting still images
            over radio. Ham radio operators use it to send pictures on HF, 2m,
            and 70cm bands. The ISS also periodically transmits SSTV images on
            145.800 MHz during special events.
          </p>
          <p className="text-xs text-gray-600 max-w-sm mx-auto">
            Images will appear here automatically once the SSTV decoder is
            running and writing PNG files to{" "}
            <code className="font-mono bg-gray-800 px-1 py-0.5 rounded text-gray-400">
              /data/images/sstv/
            </code>
          </p>
        </div>
      )}

      {/* Image gallery grid */}
      {!isLoading && captures.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {captures.map((cap, idx) => (
              <button
                key={cap.id}
                onClick={() => openLightbox(idx)}
                className="group relative rounded-lg overflow-hidden border border-gray-700 hover:border-green-500 transition-all duration-200 bg-gray-900 flex flex-col text-left hover:shadow-lg hover:shadow-green-900/20"
              >
                {/* Thumbnail */}
                <div className="relative w-full" style={{ maxHeight: "200px", overflow: "hidden" }}>
                  <img
                    src={imageUrl(cap.id)}
                    alt={cap.filename}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    style={{ maxHeight: "200px" }}
                    loading="lazy"
                    onError={(e) => {
                      const el = e.target as HTMLImageElement;
                      el.style.display = "none";
                      const placeholder = el.nextElementSibling as HTMLElement | null;
                      if (placeholder) placeholder.style.display = "flex";
                    }}
                  />
                  <div
                    className="w-full items-center justify-center bg-gray-800 text-gray-600"
                    style={{ display: "none", height: "200px" }}
                  >
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>

                  {/* Mode badge overlay */}
                  {bandLabel(cap.frequency_hz) && (
                    <span className="absolute top-2 right-2 px-1.5 py-0.5 text-[10px] font-medium rounded bg-black/60 text-cyan-300 backdrop-blur-sm border border-cyan-800/40">
                      {bandLabel(cap.frequency_hz)}
                    </span>
                  )}
                </div>

                {/* Card metadata */}
                <div className="px-3 py-2.5 border-t border-gray-800">
                  <p className="text-xs font-mono text-cyan-400 truncate">
                    {formatFrequency(cap.frequency_hz)}
                    {cap.frequency_label && (
                      <span className="text-gray-500 font-sans ml-1.5">
                        {cap.frequency_label}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                    {formatDateTime(cap.timestamp)}
                  </p>
                  {cap.source_sdr && (
                    <p className="text-[10px] text-gray-600 mt-0.5 truncate">
                      {cap.source_sdr}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-between items-center mt-6 text-sm text-gray-400">
              <button
                onClick={() => {
                  setPage((p) => Math.max(1, p - 1));
                  setLightboxIndex(null);
                }}
                disabled={page <= 1}
                className="px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default transition-colors"
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
                <span className="text-gray-600 ml-2">
                  ({total.toLocaleString()} image{total !== 1 ? "s" : ""})
                </span>
              </span>
              <button
                onClick={() => {
                  setPage((p) => Math.min(totalPages, p + 1));
                  setLightboxIndex(null);
                }}
                disabled={page >= totalPages}
                className="px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {/* Lightbox viewer */}
      {lightboxIndex != null && captures.length > 0 && (
        <Lightbox
          captures={captures}
          selectedIndex={lightboxIndex}
          onClose={closeLightbox}
          onNavigate={navigateLightbox}
        />
      )}
    </div>
  );
}
