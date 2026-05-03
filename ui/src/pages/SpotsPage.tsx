import { useState, useMemo } from "react";
import { CallsignLink } from "../components/CallsignLink";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Polyline, CircleMarker, Circle, Popup } from "react-leaflet";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  browseSpots,
  getSpotMap,
  getSpotStats,
  getSpotBands,
  getStationCenter,
  type Spot,
  type SpotStats,
  type BandActivity,
} from "../api/client";
import { formatDateTime } from "../utils/time";
import "leaflet/dist/leaflet.css";

function formatFrequency(hz: number | null): string {
  if (hz == null) return "\u2014";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

const BAND_COLORS: Record<string, string> = {
  "160m": "#e74c3c",
  "80m": "#e67e22",
  "60m": "#f39c12",
  "40m": "#f1c40f",
  "30m": "#2ecc71",
  "20m": "#1abc9c",
  "17m": "#3498db",
  "15m": "#2980b9",
  "12m": "#9b59b6",
  "10m": "#e91e63",
};

const ALL_HF_BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"];

const HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "All", value: 0 },
];

const MODE_OPTIONS = [
  { label: "All", value: "" },
  { label: "FT8", value: "ft8" },
  { label: "FT4", value: "ft4" },
  { label: "WSPR", value: "wspr" },
];

const BAND_OPTIONS = [
  "", "160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m",
];

const DISTANCE_RINGS = [
  { radius: 1_000_000, label: "1,000 km" },
  { radius: 5_000_000, label: "5,000 km" },
  { radius: 10_000_000, label: "10,000 km" },
];

type Tab = "map" | "table" | "stats" | "leaderboard";

export default function SpotsPage() {
  const [hours, setHours] = useState(24);
  const [mode, setMode] = useState("");
  const [band, setBand] = useState("");
  const [callsign, setCallsign] = useState("");
  const [tab, setTab] = useState<Tab>("map");
  const [page, setPage] = useState(1);
  const limit = 50;

  // Station center for map
  const { data: stationCenter } = useQuery({
    queryKey: ["station-center"],
    queryFn: getStationCenter,
    staleTime: 600_000,
  });

  // Spot map data
  const { data: mapData } = useQuery({
    queryKey: ["spot-map", mode, band, hours],
    queryFn: () => getSpotMap({ mode: mode || undefined, band: band || undefined, hours }),
    staleTime: 30_000,
    enabled: tab === "map" || tab === "leaderboard",
  });

  // Browse data
  const { data: browseData, isLoading: browseLoading } = useQuery({
    queryKey: ["spot-browse", mode, band, callsign, hours, page],
    queryFn: () =>
      browseSpots({
        mode: mode || undefined,
        band: band || undefined,
        callsign: callsign.trim() || undefined,
        hours,
        page,
        limit,
      }),
    staleTime: 30_000,
    enabled: tab === "table",
  });

  // Stats data
  const { data: statsData } = useQuery({
    queryKey: ["spot-stats", hours],
    queryFn: () => getSpotStats(hours),
    staleTime: 30_000,
    enabled: tab === "stats",
  });

  // 24h stats for leaderboard (always 24h window for leaderboard)
  const { data: leaderboardStats } = useQuery({
    queryKey: ["spot-stats-leaderboard", hours],
    queryFn: () => getSpotStats(hours || 24),
    staleTime: 30_000,
    enabled: tab === "leaderboard",
  });

  // All spots for leaderboard (need full data for FT8/WSPR split)
  const { data: leaderboardMap } = useQuery({
    queryKey: ["spot-map-leaderboard", hours],
    queryFn: () => getSpotMap({ hours: hours || 24, limit: 5000 }),
    staleTime: 30_000,
    enabled: tab === "leaderboard",
  });

  // Band activity (for indicator) -- always 1h
  const { data: bandActivity } = useQuery({
    queryKey: ["spot-bands"],
    queryFn: () => getSpotBands(1),
    staleTime: 30_000,
  });

  // 24h band activity for the spot rate chart
  const { data: bandActivity24h } = useQuery({
    queryKey: ["spot-bands-24h"],
    queryFn: () => getSpotBands(24),
    staleTime: 60_000,
  });

  const rxLat = stationCenter?.latitude ?? 39.0;
  const rxLon = stationCenter?.longitude ?? -77.0;

  const totalSpots = browseData?.total ?? mapData?.total ?? 0;

  // Aggregate band counts for the header pills (from 1h band activity)
  const bandCountMap = useMemo(() => {
    const m: Record<string, number> = {};
    if (bandActivity?.bands) {
      for (const b of bandActivity.bands) {
        m[b.band] = (m[b.band] || 0) + b.count;
      }
    }
    return m;
  }, [bandActivity]);

  // Propagation summary: find the band with most spots, and its farthest contact
  const propagationSummary = useMemo(() => {
    if (!bandActivity?.bands || bandActivity.bands.length === 0) return null;
    // Sum by band
    const bandTotals: Record<string, number> = {};
    for (const b of bandActivity.bands) {
      bandTotals[b.band] = (bandTotals[b.band] || 0) + b.count;
    }
    let bestBand = "";
    let bestCount = 0;
    for (const [b, c] of Object.entries(bandTotals)) {
      if (c > bestCount) { bestBand = b; bestCount = c; }
    }
    if (!bestBand) return null;
    // Find the farthest contact on that band from map data (if available)
    const allSpots = mapData?.spots ?? [];
    let farthestSpot: Spot | null = null;
    for (const s of allSpots) {
      if (s.band === bestBand && s.distance_km != null) {
        if (!farthestSpot || (s.distance_km > (farthestSpot.distance_km ?? 0))) {
          farthestSpot = s;
        }
      }
    }
    return { band: bestBand, count: bestCount, farthest: farthestSpot };
  }, [bandActivity, mapData]);

  const handleBandPillClick = (b: string) => {
    setBand((prev) => (prev === b ? "" : b));
    setPage(1);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">FT8 / WSPR Spots</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            HF digital mode decoding via RX888 MkII + WSJT-X (jt9/wsprd)
          </p>
        </div>
        <div className="text-sm text-gray-400">
          {totalSpots.toLocaleString()} spot{totalSpots !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Band Activity Header -- clickable pills for all HF bands */}
      <div className="bg-gray-800/50 rounded-lg px-4 py-3 mb-4 border border-gray-700">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Band Activity (1h)</span>
        </div>
        <div className="flex gap-2 flex-wrap mb-2">
          {ALL_HF_BANDS.map((b) => {
            const count = bandCountMap[b] || 0;
            const isActive = band === b;
            const bgColor = count > 10 ? "#16a34a" : count > 0 ? "#ca8a04" : "#4b5563";
            const textColor = count > 10 ? "#bbf7d0" : count > 0 ? "#fef08a" : "#9ca3af";
            return (
              <button
                key={b}
                onClick={() => handleBandPillClick(b)}
                className={`px-2.5 py-1 rounded-full text-xs font-mono font-bold transition-all ${
                  isActive ? "ring-2 ring-white ring-offset-1 ring-offset-gray-900" : ""
                }`}
                style={{
                  backgroundColor: isActive ? BAND_COLORS[b] + "40" : bgColor + "30",
                  color: isActive ? BAND_COLORS[b] : textColor,
                  border: `1px solid ${isActive ? BAND_COLORS[b] : bgColor}80`,
                }}
              >
                {b} <span className="ml-1 opacity-80">{count}</span>
              </button>
            );
          })}
          {band && (
            <button
              onClick={() => { setBand(""); setPage(1); }}
              className="px-2 py-1 rounded-full text-xs text-gray-400 bg-gray-700 hover:bg-gray-600 transition-colors"
            >
              Clear filter
            </button>
          )}
        </div>
        {propagationSummary && (
          <div className="text-xs text-gray-400">
            <span style={{ color: BAND_COLORS[propagationSummary.band] }} className="font-bold">
              {propagationSummary.band}
            </span>
            : {propagationSummary.count} spots
            {propagationSummary.farthest && propagationSummary.farthest.distance_km != null && (
              <>
                , farthest{" "}
                <span className="text-yellow-400 font-mono">
                  {propagationSummary.farthest.callsign}
                </span>
                {" "}at {propagationSummary.farthest.distance_km.toLocaleString()} km
              </>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {(["map", "table", "stats", "leaderboard"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              tab === t
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {t === "map" ? "Spot Map" : t === "table" ? "Log" : t === "stats" ? "Stats" : "DX Leaderboard"}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex gap-1">
          {HOURS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setHours(opt.value); setPage(1); }}
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
        <div className="flex gap-1">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setMode(opt.value); setPage(1); }}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                mode === opt.value
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <select
          value={band}
          onChange={(e) => { setBand(e.target.value); setPage(1); }}
          className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-white"
        >
          <option value="">All Bands</option>
          {BAND_OPTIONS.filter(Boolean).map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        {tab === "table" && (
          <input
            type="text"
            value={callsign}
            onChange={(e) => { setCallsign(e.target.value.toUpperCase()); setPage(1); }}
            placeholder="Callsign\u2026"
            className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-400 w-32"
          />
        )}
      </div>

      {/* Map Tab */}
      {tab === "map" && (
        <SpotMap
          spots={mapData?.spots ?? []}
          rxLat={rxLat}
          rxLon={rxLon}
        />
      )}

      {/* Table Tab */}
      {tab === "table" && (
        <SpotTable
          items={browseData?.items ?? []}
          total={browseData?.total ?? 0}
          page={page}
          limit={limit}
          loading={browseLoading}
          onPageChange={setPage}
        />
      )}

      {/* Stats Tab */}
      {tab === "stats" && statsData && (
        <SpotStatsPanel
          stats={statsData}
          bandActivity24h={bandActivity24h?.bands}
          allSpots={mapData?.spots}
        />
      )}

      {/* Leaderboard Tab */}
      {tab === "leaderboard" && (
        <DistanceLeaderboard
          stats={leaderboardStats ?? null}
          allSpots={leaderboardMap?.spots ?? []}
        />
      )}

      {/* Empty state */}
      {totalSpots === 0 && tab !== "stats" && tab !== "leaderboard" && (
        <div className="text-center py-16 text-gray-500">
          <p className="text-lg mb-2">No FT8/WSPR spots found.</p>
          <p className="text-sm">
            Scale the <code className="font-mono bg-gray-800 px-1 rounded">ft8-wspr-decoder</code>{" "}
            deployment to 1 replica (and <code className="font-mono bg-gray-800 px-1 rounded">openwebrxplus</code> to 0).
          </p>
          <p className="text-xs text-gray-600 mt-2">
            kubectl scale deploy ft8-wspr-decoder -n sdr-research --replicas=1
          </p>
        </div>
      )}
    </div>
  );
}

// ── Spot Map Component ──────────────────────────────────────────────
function SpotMap({
  spots,
  rxLat,
  rxLon,
}: {
  spots: Spot[];
  rxLat: number;
  rxLon: number;
}) {
  // Group spots by callsign+band for unique lines
  const lines = useMemo(() => {
    const seen = new Set<string>();
    return spots
      .filter((s) => s.tx_latitude != null && s.tx_longitude != null)
      .filter((s) => {
        const key = `${s.callsign}-${s.band}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [spots]);

  return (
    <div className="rounded-lg overflow-hidden border border-gray-700" style={{ height: "calc(100vh - 20rem)", minHeight: "400px" }}>
      <MapContainer
        center={[rxLat, rxLon]}
        zoom={3}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        {/* Distance rings */}
        {DISTANCE_RINGS.map((ring) => (
          <Circle
            key={ring.label}
            center={[rxLat, rxLon]}
            radius={ring.radius}
            pathOptions={{
              color: "#6b7280",
              weight: 1,
              opacity: 0.3,
              fillOpacity: 0,
              dashArray: "6 4",
            }}
          >
            <Popup>
              <span className="text-xs">{ring.label} radius</span>
            </Popup>
          </Circle>
        ))}

        {/* Station marker */}
        <CircleMarker
          center={[rxLat, rxLon]}
          radius={8}
          pathOptions={{ color: "#22c55e", fillColor: "#22c55e", fillOpacity: 0.9, weight: 2 }}
        >
          <Popup>
            <strong>Your Station</strong>
            <br />
            <span className="text-xs">
              {rxLat.toFixed(4)}, {rxLon.toFixed(4)}
            </span>
          </Popup>
        </CircleMarker>

        {/* Great circle lines from RX to TX */}
        {lines.map((spot, i) => {
          const color = BAND_COLORS[spot.band ?? ""] || "#888";
          return (
            <Polyline
              key={`${spot.callsign}-${spot.band}-${i}`}
              positions={[
                [rxLat, rxLon],
                [spot.tx_latitude!, spot.tx_longitude!],
              ]}
              pathOptions={{ color, weight: 1.5, opacity: 0.6 }}
            >
              <Popup>
                <div className="text-xs">
                  {spot.callsign ? <CallsignLink callsign={spot.callsign} className="font-bold text-blue-400 hover:underline" /> : <strong>Unknown</strong>} ({spot.grid})<br />
                  {spot.band} {spot.mode?.toUpperCase()} SNR:{spot.snr_db} dB<br />
                  {spot.distance_km != null && `${spot.distance_km.toLocaleString()} km`}
                </div>
              </Popup>
            </Polyline>
          );
        })}

        {/* TX station dots */}
        {lines.map((spot, i) => {
          const color = BAND_COLORS[spot.band ?? ""] || "#888";
          return (
            <CircleMarker
              key={`dot-${spot.callsign}-${spot.band}-${i}`}
              center={[spot.tx_latitude!, spot.tx_longitude!]}
              radius={4}
              pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1 }}
            >
              <Popup>
                <div className="text-xs">
                  {spot.callsign ? <CallsignLink callsign={spot.callsign} className="font-bold text-blue-400 hover:underline" /> : <strong>Unknown</strong>}<br />
                  {spot.grid} | {spot.band} {spot.mode?.toUpperCase()}<br />
                  SNR: {spot.snr_db} dB | {spot.distance_km?.toLocaleString()} km
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Band color legend */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-gray-800 text-xs">
        <span className="text-gray-500 mr-1">Bands:</span>
        {Object.entries(BAND_COLORS).map(([bandName, color]) => (
          <span key={bandName} className="flex items-center gap-1">
            <span className="w-3 h-1 rounded" style={{ backgroundColor: color }} />
            <span style={{ color }}>{bandName}</span>
          </span>
        ))}
        <span className="text-gray-600 ml-2">|</span>
        <span className="text-gray-500 ml-1">Rings: 1k / 5k / 10k km</span>
      </div>
    </div>
  );
}

// ── Spot Table Component ────────────────────────────────────────────
function SpotTable({
  items,
  total,
  page,
  limit,
  loading,
  onPageChange,
}: {
  items: Spot[];
  total: number;
  page: number;
  limit: number;
  loading: boolean;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (loading) {
    return <div className="text-center py-16 text-gray-400">Loading\u2026</div>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-gray-700 sticky-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800 text-gray-400 text-left">
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Mode</th>
              <th className="px-3 py-2 font-medium">Band</th>
              <th className="px-3 py-2 font-medium">Frequency</th>
              <th className="px-3 py-2 font-medium">Callsign</th>
              <th className="px-3 py-2 font-medium">Grid</th>
              <th className="px-3 py-2 font-medium">SNR</th>
              <th className="px-3 py-2 font-medium">Distance</th>
              <th className="px-3 py-2 font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {items.map((spot) => (
              <tr key={spot.id} className="border-t border-gray-700 hover:bg-gray-800/40">
                <td className="px-3 py-2 text-gray-400 whitespace-nowrap font-mono text-xs">
                  {formatDateTime(spot.timestamp)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                    spot.mode === "ft8" ? "bg-blue-900/50 text-blue-300" :
                    spot.mode === "wspr" ? "bg-purple-900/50 text-purple-300" :
                    "bg-gray-700 text-gray-300"
                  }`}>
                    {spot.mode?.toUpperCase()}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs font-mono" style={{
                  color: BAND_COLORS[spot.band ?? ""] || "#aaa",
                }}>
                  {spot.band ?? "\u2014"}
                </td>
                <td className="px-3 py-2 text-cyan-400 whitespace-nowrap font-mono text-xs">
                  {formatFrequency(spot.dial_frequency_hz)}
                </td>
                <td className="px-3 py-2 text-yellow-400 font-mono text-xs font-bold">
                  {spot.callsign ?? "\u2014"}
                </td>
                <td className="px-3 py-2 text-gray-300 font-mono text-xs">
                  {spot.grid ?? "\u2014"}
                </td>
                <td className="px-3 py-2 text-gray-300 font-mono text-xs text-right">
                  {spot.snr_db != null ? `${spot.snr_db > 0 ? "+" : ""}${spot.snr_db}` : "\u2014"}
                </td>
                <td className="px-3 py-2 text-gray-300 font-mono text-xs text-right">
                  {spot.distance_km != null
                    ? `${spot.distance_km.toLocaleString()} km`
                    : "\u2014"}
                </td>
                <td className="px-3 py-2 text-gray-400 text-xs font-mono max-w-xs truncate">
                  {spot.message ?? "\u2014"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-gray-400 pagination">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="px-3 py-1 rounded bg-gray-800 disabled:opacity-40 hover:bg-gray-700"
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages} ({total.toLocaleString()} spots)
          </span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1 rounded bg-gray-800 disabled:opacity-40 hover:bg-gray-700"
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

// ── Distance Leaderboard ────────────────────────────────────────────
function DistanceLeaderboard({
  stats,
  allSpots,
}: {
  stats: SpotStats | null;
  allSpots: Spot[];
}) {
  // Split spots by mode and sort by distance
  const { ft8Top, wsprTop } = useMemo(() => {
    const ft8: Spot[] = [];
    const wspr: Spot[] = [];
    // Deduplicate by callsign+band, keeping farthest
    const ft8Best = new Map<string, Spot>();
    const wsprBest = new Map<string, Spot>();

    for (const s of allSpots) {
      if (s.distance_km == null || s.callsign == null) continue;
      const key = `${s.callsign}-${s.band}`;
      if (s.mode === "ft8" || s.mode === "ft4") {
        const existing = ft8Best.get(key);
        if (!existing || (s.distance_km > (existing.distance_km ?? 0))) {
          ft8Best.set(key, s);
        }
      } else if (s.mode === "wspr") {
        const existing = wsprBest.get(key);
        if (!existing || (s.distance_km > (existing.distance_km ?? 0))) {
          wsprBest.set(key, s);
        }
      }
    }

    for (const s of ft8Best.values()) ft8.push(s);
    for (const s of wsprBest.values()) wspr.push(s);

    ft8.sort((a, b) => (b.distance_km ?? 0) - (a.distance_km ?? 0));
    wspr.sort((a, b) => (b.distance_km ?? 0) - (a.distance_km ?? 0));

    return { ft8Top: ft8.slice(0, 10), wsprTop: wspr.slice(0, 10) };
  }, [allSpots]);

  if (!stats && allSpots.length === 0) {
    return <div className="text-center py-16 text-gray-500">No data available for leaderboard.</div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Spots" value={stats.total_spots.toLocaleString()} />
          <StatCard label="Unique Callsigns" value={stats.unique_callsigns.toLocaleString()} />
          <StatCard
            label="Farthest DX"
            value={
              stats.farthest.length > 0 && stats.farthest[0].distance_km
                ? `${stats.farthest[0].distance_km.toLocaleString()} km`
                : "\u2014"
            }
            sub={stats.farthest.length > 0 ? `${stats.farthest[0].callsign ?? ""} (${stats.farthest[0].band ?? ""})` : ""}
          />
          <StatCard
            label="Bands Active"
            value={String(stats.by_band.length)}
          />
        </div>
      )}

      {/* FT8 Leaderboard */}
      <div>
        <h3 className="text-sm font-semibold text-blue-400 mb-2 flex items-center gap-2">
          <span className="px-1.5 py-0.5 bg-blue-900/50 rounded text-xs font-bold">FT8</span>
          Top 10 Farthest Contacts
        </h3>
        {ft8Top.length > 0 ? (
          <LeaderboardTable spots={ft8Top} />
        ) : (
          <div className="text-sm text-gray-500 py-4">No FT8 spots with distance data.</div>
        )}
      </div>

      {/* WSPR Leaderboard */}
      <div>
        <h3 className="text-sm font-semibold text-purple-400 mb-2 flex items-center gap-2">
          <span className="px-1.5 py-0.5 bg-purple-900/50 rounded text-xs font-bold">WSPR</span>
          Top 10 Farthest Contacts
        </h3>
        {wsprTop.length > 0 ? (
          <LeaderboardTable spots={wsprTop} />
        ) : (
          <div className="text-sm text-gray-500 py-4">No WSPR spots with distance data.</div>
        )}
      </div>

      {/* Overall farthest from stats (mixed mode) */}
      {stats && stats.farthest.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Overall Farthest DX (All Modes)</h3>
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-800 text-gray-400 text-left">
                  <th className="px-3 py-2 font-medium w-8">#</th>
                  <th className="px-3 py-2 font-medium">Callsign</th>
                  <th className="px-3 py-2 font-medium">Grid</th>
                  <th className="px-3 py-2 font-medium">Band</th>
                  <th className="px-3 py-2 font-medium">Mode</th>
                  <th className="px-3 py-2 font-medium">Distance</th>
                  <th className="px-3 py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {stats.farthest.map((f, i) => (
                  <tr key={i} className="border-t border-gray-700">
                    <td className="px-3 py-2 text-gray-600 text-xs">{i + 1}</td>
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs font-bold">{f.callsign}</td>
                    <td className="px-3 py-2 text-gray-300 font-mono text-xs">{f.grid}</td>
                    <td className="px-3 py-2 text-xs font-mono" style={{ color: BAND_COLORS[f.band ?? ""] || "#aaa" }}>
                      {f.band}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                        f.mode === "ft8" ? "bg-blue-900/50 text-blue-300" :
                        f.mode === "wspr" ? "bg-purple-900/50 text-purple-300" :
                        "bg-gray-700 text-gray-300"
                      }`}>
                        {f.mode?.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-green-400 font-mono text-xs">
                      {f.distance_km?.toLocaleString()} km
                    </td>
                    <td className="px-3 py-2 text-gray-400 font-mono text-xs">
                      {f.timestamp ? formatDateTime(f.timestamp) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LeaderboardTable({ spots }: { spots: Spot[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-700 sticky-table">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800 text-gray-400 text-left">
            <th className="px-3 py-2 font-medium w-8">#</th>
            <th className="px-3 py-2 font-medium">Callsign</th>
            <th className="px-3 py-2 font-medium">Grid</th>
            <th className="px-3 py-2 font-medium">Band</th>
            <th className="px-3 py-2 font-medium">Distance</th>
            <th className="px-3 py-2 font-medium">SNR</th>
          </tr>
        </thead>
        <tbody>
          {spots.map((s, i) => (
            <tr key={`${s.callsign}-${s.band}-${i}`} className={`border-t border-gray-700 ${i === 0 ? "bg-yellow-900/10" : ""}`}>
              <td className="px-3 py-2 text-xs font-bold" style={{
                color: i === 0 ? "#fbbf24" : i === 1 ? "#94a3b8" : i === 2 ? "#d97706" : "#6b7280",
              }}>
                {i + 1}
              </td>
              <td className="px-3 py-2 text-yellow-400 font-mono text-xs font-bold">
                {s.callsign ?? "\u2014"}
              </td>
              <td className="px-3 py-2 text-gray-300 font-mono text-xs">
                {s.grid ?? "\u2014"}
              </td>
              <td className="px-3 py-2 text-xs font-mono" style={{ color: BAND_COLORS[s.band ?? ""] || "#aaa" }}>
                {s.band ?? "\u2014"}
              </td>
              <td className="px-3 py-2 text-green-400 font-mono text-xs font-bold">
                {s.distance_km != null ? `${s.distance_km.toLocaleString()} km` : "\u2014"}
              </td>
              <td className="px-3 py-2 text-gray-300 font-mono text-xs">
                {s.snr_db != null ? `${s.snr_db > 0 ? "+" : ""}${s.snr_db} dB` : "\u2014"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Spot Rate Chart (stacked area by band, last 24h) ────────────────
function SpotRateChart({ stats }: { stats: SpotStats }) {
  // Build hourly data from stats.by_hour, augmented with band breakdown
  // stats.by_hour gives total counts per hour; we'll show it as a single series
  // For a proper stacked chart, we'd need by_hour broken out per band from the API.
  // We use the available by_hour data and show it stacked by the top bands from by_band.
  const chartData = useMemo(() => {
    if (!stats.by_hour || stats.by_hour.length === 0) return [];
    // by_hour gives [{hour: 0, count: N}, ...] for 0-23
    // Build a sorted array of all 24 hours
    const hourMap = new Map<number, number>();
    for (const h of stats.by_hour) {
      hourMap.set(h.hour, h.count);
    }
    // Determine active bands and their proportions
    const totalByBand: Record<string, number> = {};
    let grandTotal = 0;
    for (const b of stats.by_band) {
      totalByBand[b.band] = b.count;
      grandTotal += b.count;
    }
    const activeBands = stats.by_band
      .sort((a, b) => b.count - a.count)
      .map((b) => b.band)
      .slice(0, 6); // top 6 bands

    const data = [];
    for (let h = 0; h < 24; h++) {
      const total = hourMap.get(h) ?? 0;
      const entry: Record<string, number | string> = {
        hour: `${h.toString().padStart(2, "0")}:00`,
      };
      // Distribute the hourly count proportionally among active bands
      let distributed = 0;
      for (const b of activeBands) {
        const proportion = grandTotal > 0 ? (totalByBand[b] ?? 0) / grandTotal : 0;
        const bandCount = Math.round(total * proportion);
        entry[b] = bandCount;
        distributed += bandCount;
      }
      // Put any remainder in "Other"
      const remainder = total - distributed;
      if (remainder > 0) {
        entry["Other"] = remainder;
      }
      data.push(entry);
    }
    return data;
  }, [stats]);

  const activeBands = useMemo(() => {
    return stats.by_band
      .sort((a, b) => b.count - a.count)
      .map((b) => b.band)
      .slice(0, 6);
  }, [stats]);

  if (chartData.length === 0) {
    return <div className="text-sm text-gray-500 py-4">No hourly data available.</div>;
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h3 className="text-sm font-semibold text-gray-400 mb-3">Spots per Hour by Band</h3>
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart data={chartData}>
          <XAxis
            dataKey="hour"
            tick={{ fill: "#9ca3af", fontSize: 10 }}
            axisLine={{ stroke: "#374151" }}
            tickLine={false}
            interval={2}
          />
          <YAxis
            tick={{ fill: "#9ca3af", fontSize: 10 }}
            axisLine={{ stroke: "#374151" }}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1f2937",
              border: "1px solid #374151",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "#d1d5db" }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "#9ca3af" }}
          />
          {activeBands.map((b) => (
            <Area
              key={b}
              type="monotone"
              dataKey={b}
              stackId="1"
              stroke={BAND_COLORS[b] || "#888"}
              fill={BAND_COLORS[b] || "#888"}
              fillOpacity={0.4}
            />
          ))}
          {chartData.some((d) => (d["Other"] as number) > 0) && (
            <Area
              type="monotone"
              dataKey="Other"
              stackId="1"
              stroke="#6b7280"
              fill="#6b7280"
              fillOpacity={0.3}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Grid Square Tracker ─────────────────────────────────────────────
function GridSquareTracker({ spots }: { spots?: Spot[] }) {
  const { uniqueGrids, gridsByBand, totalBands } = useMemo(() => {
    if (!spots || spots.length === 0) return { uniqueGrids: 0, gridsByBand: new Map<string, Set<string>>(), totalBands: 0 };
    const grids = new Set<string>();
    const byBand = new Map<string, Set<string>>();
    for (const s of spots) {
      if (!s.grid) continue;
      const g4 = s.grid.substring(0, 4).toUpperCase();
      grids.add(g4);
      if (s.band) {
        if (!byBand.has(s.band)) byBand.set(s.band, new Set());
        byBand.get(s.band)!.add(g4);
      }
    }
    return { uniqueGrids: grids.size, gridsByBand: byBand, totalBands: byBand.size };
  }, [spots]);

  if (uniqueGrids === 0) return null;

  // Sort bands by grid count descending
  const sortedBands = [...gridsByBand.entries()].sort((a, b) => b[1].size - a[1].size);

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <h3 className="text-sm font-semibold text-gray-400 mb-2">Grid Square Tracker</h3>
      <div className="text-2xl font-bold text-white mb-1">
        {uniqueGrids.toLocaleString()} <span className="text-sm font-normal text-gray-400">unique grids</span>
      </div>
      <div className="text-xs text-gray-500 mb-3">
        across {totalBands} band{totalBands !== 1 ? "s" : ""}
      </div>
      <div className="flex gap-2 flex-wrap">
        {sortedBands.map(([bandName, gridSet]) => (
          <div
            key={bandName}
            className="px-2.5 py-1.5 rounded bg-gray-700/50 text-center min-w-[70px]"
          >
            <div className="text-sm font-bold" style={{ color: BAND_COLORS[bandName] || "#aaa" }}>
              {gridSet.size}
            </div>
            <div className="text-xs text-gray-500">{bandName}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stats Panel ─────────────────────────────────────────────────────
function SpotStatsPanel({
  stats,
  allSpots,
}: {
  stats: SpotStats;
  bandActivity24h?: BandActivity[];
  allSpots?: Spot[];
}) {
  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Spots" value={stats.total_spots.toLocaleString()} />
        <StatCard label="Unique Callsigns" value={stats.unique_callsigns.toLocaleString()} />
        <StatCard
          label="Bands Active"
          value={String(stats.by_band.length)}
        />
        <StatCard
          label="Farthest"
          value={
            stats.farthest.length > 0 && stats.farthest[0].distance_km
              ? `${stats.farthest[0].distance_km.toLocaleString()} km`
              : "\u2014"
          }
          sub={stats.farthest.length > 0 ? stats.farthest[0].callsign ?? "" : ""}
        />
      </div>

      {/* Spot Rate Chart */}
      <SpotRateChart stats={stats} />

      {/* Grid Square Tracker */}
      <GridSquareTracker spots={allSpots} />

      {/* By Band */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-2">Spots by Band</h3>
        <div className="flex gap-2 flex-wrap">
          {stats.by_band.map((b) => (
            <div
              key={b.band}
              className="px-3 py-2 rounded bg-gray-800 text-center min-w-[80px]"
            >
              <div className="text-lg font-bold" style={{ color: BAND_COLORS[b.band] || "#aaa" }}>
                {b.count.toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">{b.band}</div>
            </div>
          ))}
        </div>
      </div>

      {/* By Mode */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-2">Spots by Mode</h3>
        <div className="flex gap-2">
          {Object.entries(stats.by_mode).map(([m, count]) => (
            <div key={m} className="px-3 py-2 rounded bg-gray-800 text-center min-w-[80px]">
              <div className="text-lg font-bold text-blue-400">{count.toLocaleString()}</div>
              <div className="text-xs text-gray-500">{m.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Top Callsigns */}
      {stats.top_callsigns.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Top Callsigns</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {stats.top_callsigns.slice(0, 12).map((c) => (
              <div key={c.callsign} className="flex justify-between px-3 py-1.5 rounded bg-gray-800 text-sm">
                <span className="text-yellow-400 font-mono">{c.callsign}</span>
                <span className="text-gray-500">{c.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Farthest DX */}
      {stats.farthest.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Farthest DX</h3>
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-800 text-gray-400 text-left">
                  <th className="px-3 py-2 font-medium">Callsign</th>
                  <th className="px-3 py-2 font-medium">Grid</th>
                  <th className="px-3 py-2 font-medium">Band</th>
                  <th className="px-3 py-2 font-medium">Distance</th>
                  <th className="px-3 py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {stats.farthest.map((f, i) => (
                  <tr key={i} className="border-t border-gray-700">
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs">{f.callsign}</td>
                    <td className="px-3 py-2 text-gray-300 font-mono text-xs">{f.grid}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: BAND_COLORS[f.band ?? ""] || "#aaa" }}>
                      {f.band}
                    </td>
                    <td className="px-3 py-2 text-green-400 font-mono text-xs">
                      {f.distance_km?.toLocaleString()} km
                    </td>
                    <td className="px-3 py-2 text-gray-400 font-mono text-xs">
                      {f.timestamp ? formatDateTime(f.timestamp) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-800 rounded-lg px-4 py-3">
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
