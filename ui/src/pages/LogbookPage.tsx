import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MapContainer, TileLayer, Rectangle, Tooltip } from "react-leaflet";
import {
  browseFiles,
  listAprsStations,
  browseSpots,
  type Recording,
  type AprsStation,
  type Spot,
} from "../api/client";
import { formatDateTime } from "../utils/time";

// ── Helpers ──────────────────────────────────────────────────────────

function formatFrequency(hz: number | null): string {
  if (hz == null) return "\u2014";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function freqToBand(hz: number | null): string {
  if (hz == null) return "\u2014";
  const mhz = hz / 1_000_000;
  if (mhz < 0.5) return "MF";
  if (mhz < 1.8) return "MF";
  if (mhz < 2.0) return "160m";
  if (mhz < 3.5) return "HF";
  if (mhz < 4.0) return "80m";
  if (mhz < 5.3) return "HF";
  if (mhz < 5.5) return "60m";
  if (mhz < 7.0) return "HF";
  if (mhz < 7.3) return "40m";
  if (mhz < 10.1) return "HF";
  if (mhz < 10.15) return "30m";
  if (mhz < 14.0) return "HF";
  if (mhz < 14.35) return "20m";
  if (mhz < 18.068) return "HF";
  if (mhz < 18.168) return "17m";
  if (mhz < 21.0) return "HF";
  if (mhz < 21.45) return "15m";
  if (mhz < 24.89) return "HF";
  if (mhz < 24.99) return "12m";
  if (mhz < 28.0) return "HF";
  if (mhz < 29.7) return "10m";
  if (mhz < 50.0) return "HF";
  if (mhz < 54.0) return "6m";
  if (mhz < 144.0) return "VHF";
  if (mhz < 148.0) return "2m";
  if (mhz < 420.0) return "UHF";
  if (mhz < 450.0) return "70cm";
  if (mhz < 902.0) return "UHF";
  if (mhz < 928.0) return "33cm";
  if (mhz < 1240.0) return "UHF";
  if (mhz < 1300.0) return "23cm";
  return "UHF";
}

/** Extract 4-char grid square from a 4+ char grid locator. */
function grid4(grid: string | null | undefined): string | null {
  if (!grid || grid.length < 4) return null;
  return grid.substring(0, 4).toUpperCase();
}

/** Convert Maidenhead 4-char grid to center lat/lon. */
function gridToLatLon(g: string): [number, number] | null {
  if (g.length < 4) return null;
  const A = "A".charCodeAt(0);
  const lon = (g.charCodeAt(0) - A) * 20 - 180 + parseInt(g[2]) * 2 + 1;
  const lat = (g.charCodeAt(1) - A) * 10 - 90 + parseInt(g[3]) + 0.5;
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return [lat, lon];
}

// ── Types ────────────────────────────────────────────────────────────

interface LogEntry {
  callsign: string;
  name: string | null;
  qth: string | null;
  grid: string | null;
  state: string | null;
  modes: Set<string>;
  bands: Set<string>;
  frequencies: Set<number>;
  firstHeard: Date | null;
  lastHeard: Date | null;
  count: number;
}

type SortKey =
  | "callsign"
  | "name"
  | "qth"
  | "mode"
  | "band"
  | "frequency"
  | "firstHeard"
  | "lastHeard"
  | "count";

// ── Data aggregation ─────────────────────────────────────────────────

function parseTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function mergeIntoEntry(
  map: Map<string, LogEntry>,
  callsign: string,
  opts: {
    name?: string | null;
    qth?: string | null;
    grid?: string | null;
    state?: string | null;
    mode: string;
    frequency_hz?: number | null;
    timestamp?: string | null;
  }
) {
  const cs = callsign.toUpperCase();
  const existing = map.get(cs);
  const ts = parseTs(opts.timestamp);
  const band = freqToBand(opts.frequency_hz ?? null);

  if (existing) {
    existing.modes.add(opts.mode);
    if (band !== "\u2014") existing.bands.add(band);
    if (opts.frequency_hz) existing.frequencies.add(opts.frequency_hz);
    if (opts.name && !existing.name) existing.name = opts.name;
    if (opts.qth && !existing.qth) existing.qth = opts.qth;
    if (opts.grid && !existing.grid) existing.grid = opts.grid;
    if (opts.state && !existing.state) existing.state = opts.state;
    if (ts) {
      if (!existing.firstHeard || ts < existing.firstHeard) existing.firstHeard = ts;
      if (!existing.lastHeard || ts > existing.lastHeard) existing.lastHeard = ts;
    }
    existing.count += 1;
  } else {
    map.set(cs, {
      callsign: cs,
      name: opts.name ?? null,
      qth: opts.qth ?? null,
      grid: opts.grid ?? null,
      state: opts.state ?? null,
      modes: new Set([opts.mode]),
      bands: new Set(band !== "\u2014" ? [band] : []),
      frequencies: new Set(opts.frequency_hz ? [opts.frequency_hz] : []),
      firstHeard: ts,
      lastHeard: ts,
      count: 1,
    });
  }
}

function buildLogbook(
  voiceRecordings: Recording[],
  aprsStations: AprsStation[],
  spots: Spot[]
): LogEntry[] {
  const map = new Map<string, LogEntry>();

  // Voice callsigns from recordings
  for (const rec of voiceRecordings) {
    const callsigns = rec.callsign_tags ?? [];
    for (const cs of callsigns) {
      if (!cs) continue;
      const operators = rec.operators?.filter(
        (o) => o.callsign.toUpperCase() === cs.toUpperCase()
      );
      const op = operators?.[0];
      mergeIntoEntry(map, cs, {
        name: op?.name ?? null,
        qth: op ? [op.qth_city, op.qth_state].filter(Boolean).join(", ") || null : null,
        grid: op?.grid ?? null,
        state: op?.qth_state ?? null,
        mode: rec.mode === "cw" ? "CW" : rec.mode === "hfdl" ? "HFDL" : "Voice",
        frequency_hz: rec.frequency_hz,
        timestamp: rec.timestamp,
      });
    }
  }

  // APRS stations
  for (const st of aprsStations) {
    if (!st.callsign) continue;
    mergeIntoEntry(map, st.callsign, {
      mode: "APRS",
      frequency_hz: st.frequency_hz,
      timestamp: st.last_heard,
    });
  }

  // FT8/WSPR spots
  for (const sp of spots) {
    if (!sp.callsign) continue;
    mergeIntoEntry(map, sp.callsign, {
      grid: sp.grid,
      mode: sp.mode?.toUpperCase() ?? "FT8",
      frequency_hz: sp.dial_frequency_hz,
      timestamp: sp.timestamp,
    });
  }

  return Array.from(map.values());
}

// ── ADIF Export ──────────────────────────────────────────────────────

function padField(name: string, value: string): string {
  return `<${name}:${value.length}>${value}`;
}

function modeToAdif(mode: string): string {
  switch (mode) {
    case "FT8":
      return "FT8";
    case "FT4":
      return "FT4";
    case "WSPR":
      return "WSPR";
    case "CW":
      return "CW";
    case "APRS":
      return "PKT";
    case "HFDL":
      return "DATA";
    default:
      return "SSB";
  }
}

function generateAdif(entries: LogEntry[]): string {
  const header = [
    "ADIF Export from SDR Research Viewer",
    `Generated: ${new Date().toISOString()}`,
    "<ADIF_VER:5>3.1.4",
    `<PROGRAMID:14>SDR Viewer RXO`,
    `<PROGRAMVERSION:5>1.0.0`,
    "<EOH>",
    "",
  ].join("\n");

  const records = entries.map((entry) => {
    const fields: string[] = [];
    fields.push(padField("CALL", entry.callsign));

    const mode = Array.from(entry.modes)[0] ?? "Voice";
    fields.push(padField("MODE", modeToAdif(mode)));

    const bandStr = Array.from(entry.bands)[0];
    if (bandStr) fields.push(padField("BAND", bandStr));

    const freq = Array.from(entry.frequencies)[0];
    if (freq) {
      const mhz = (freq / 1_000_000).toFixed(5);
      fields.push(padField("FREQ", mhz));
    }

    if (entry.lastHeard) {
      const d = entry.lastHeard;
      const dateStr = [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0"),
      ].join("");
      const timeStr = [
        String(d.getUTCHours()).padStart(2, "0"),
        String(d.getUTCMinutes()).padStart(2, "0"),
      ].join("");
      fields.push(padField("QSO_DATE", dateStr));
      fields.push(padField("TIME_ON", timeStr));
    }

    if (entry.grid) {
      fields.push(padField("GRIDSQUARE", entry.grid));
    }

    if (entry.name) {
      fields.push(padField("NAME", entry.name));
    }

    if (entry.qth) {
      fields.push(padField("QTH", entry.qth));
    }

    if (entry.state) {
      fields.push(padField("STATE", entry.state));
    }

    // RX-only station, no real RST exchange
    fields.push(padField("RST_SENT", "00"));
    fields.push(padField("RST_RCVD", "00"));

    fields.push("<EOR>");
    return fields.join(" ");
  });

  return header + records.join("\n") + "\n";
}

// ── CSV Export ───────────────────────────────────────────────────────

function generateCsv(entries: LogEntry[]): string {
  const headers = [
    "Callsign",
    "Name",
    "QTH",
    "Grid",
    "State",
    "Modes",
    "Bands",
    "Frequency (MHz)",
    "First Heard (UTC)",
    "Last Heard (UTC)",
    "Count",
  ];
  const rows = entries.map((e) => [
    e.callsign,
    e.name ?? "",
    e.qth ?? "",
    e.grid ?? "",
    e.state ?? "",
    Array.from(e.modes).join(";"),
    Array.from(e.bands).join(";"),
    Array.from(e.frequencies)
      .map((f) => (f / 1_000_000).toFixed(5))
      .join(";"),
    e.firstHeard?.toISOString() ?? "",
    e.lastHeard?.toISOString() ?? "",
    String(e.count),
  ]);
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  return [headers.join(","), ...rows.map((r) => r.map(escape).join(","))].join(
    "\n"
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Grid Map Component ───────────────────────────────────────────────

function GridSquareMap({ grids }: { grids: Map<string, number> }) {
  if (grids.size === 0) {
    return (
      <p className="text-gray-500 text-sm italic">No grid squares available.</p>
    );
  }

  const maxCount = Math.max(...grids.values());

  // Compute bounding box of all grids to fit the view
  const points: [number, number][] = [];
  grids.forEach((_count, g) => {
    const ll = gridToLatLon(g);
    if (ll) points.push(ll);
  });

  if (points.length === 0) {
    return (
      <p className="text-gray-500 text-sm italic">
        No valid grid coordinates found.
      </p>
    );
  }

  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  const padLat = Math.max((maxLat - minLat) * 0.15, 3);
  const padLon = Math.max((maxLon - minLon) * 0.15, 5);

  const bounds: [[number, number], [number, number]] = [
    [minLat - padLat, minLon - padLon],
    [maxLat + padLat, maxLon + padLon],
  ];

  return (
    <MapContainer
      bounds={bounds}
      scrollWheelZoom={true}
      style={{ height: 350 }}
      className="rounded-lg border border-gray-700"
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      {Array.from(grids.entries()).map(([g, count]) => {
        const ll = gridToLatLon(g);
        if (!ll) return null;
        // 4-char grid square: 2 deg lon x 1 deg lat
        const rectBounds: [[number, number], [number, number]] = [
          [ll[0] - 0.5, ll[1] - 1],
          [ll[0] + 0.5, ll[1] + 1],
        ];
        const intensity = Math.min(count / maxCount, 1);
        const r = Math.round(34 + intensity * (74 - 34));
        const gv = Math.round(197 + intensity * (222 - 197));
        const b = Math.round(94 + intensity * (128 - 94));
        const opacity = 0.3 + intensity * 0.7;
        return (
          <Rectangle
            key={g}
            bounds={rectBounds}
            pathOptions={{
              color: `rgb(${r},${gv},${b})`,
              fillColor: `rgb(${r},${gv},${b})`,
              fillOpacity: opacity,
              weight: 1,
              opacity: 0.8,
            }}
          >
            <Tooltip direction="top" sticky>
              <span className="text-xs font-mono">{g}: {count} contact{count !== 1 ? "s" : ""}</span>
            </Tooltip>
          </Rectangle>
        );
      })}
    </MapContainer>
  );
}

// ── Main Page Component ──────────────────────────────────────────────

export default function LogbookPage() {
  const [searchFilter, setSearchFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastHeard");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Fetch voice/cw recordings with callsign tags (paginate to get a good sample)
  const { data: voiceData, isLoading: voiceLoading } = useQuery({
    queryKey: ["logbook-voice"],
    queryFn: async () => {
      const allRecordings: Recording[] = [];
      let pg = 1;
      const batchSize = 500;
      let done = false;
      while (!done) {
        const res = await browseFiles({
          page: pg,
          limit: batchSize,
        });
        allRecordings.push(...res.items);
        if (pg * batchSize >= res.total || res.items.length === 0) {
          done = true;
        }
        pg++;
        // Safety cap to avoid huge fetches
        if (pg > 20) done = true;
      }
      return allRecordings.filter(
        (r) => r.callsign_tags && r.callsign_tags.length > 0
      );
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch APRS stations (all time)
  const { data: aprsData, isLoading: aprsLoading } = useQuery({
    queryKey: ["logbook-aprs"],
    queryFn: async () => {
      const res = await listAprsStations(0);
      return res.stations;
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch FT8/WSPR spots
  const { data: spotData, isLoading: spotsLoading } = useQuery({
    queryKey: ["logbook-spots"],
    queryFn: async () => {
      const allSpots: Spot[] = [];
      let pg = 1;
      const batchSize = 500;
      let done = false;
      while (!done) {
        const res = await browseSpots({ page: pg, limit: batchSize, hours: 0 });
        allSpots.push(...res.items);
        if (pg * batchSize >= res.total || res.items.length === 0) {
          done = true;
        }
        pg++;
        if (pg > 20) done = true;
      }
      return allSpots.filter((s) => s.callsign);
    },
    staleTime: 5 * 60 * 1000,
  });

  const isLoading = voiceLoading || aprsLoading || spotsLoading;

  // Build the logbook
  const logbook = useMemo(() => {
    return buildLogbook(
      voiceData ?? [],
      aprsData ?? [],
      spotData ?? []
    );
  }, [voiceData, aprsData, spotData]);

  // Summary stats
  const stats = useMemo(() => {
    const uniqueCallsigns = logbook.length;
    const allGrids = new Set<string>();
    const allStates = new Set<string>();
    const allBands = new Set<string>();
    for (const entry of logbook) {
      const g = grid4(entry.grid);
      if (g) allGrids.add(g);
      if (entry.state) allStates.add(entry.state);
      for (const b of entry.bands) allBands.add(b);
    }
    return {
      uniqueCallsigns,
      uniqueGrids: allGrids.size,
      uniqueStates: allStates.size,
      activeBands: allBands.size,
      bandsSet: allBands,
    };
  }, [logbook]);

  // Grid counts for map
  const gridCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of logbook) {
      const g = grid4(entry.grid);
      if (g) {
        map.set(g, (map.get(g) ?? 0) + entry.count);
      }
    }
    return map;
  }, [logbook]);

  // Filtered + sorted entries
  const filtered = useMemo(() => {
    let entries = logbook;
    if (searchFilter.trim()) {
      const q = searchFilter.trim().toUpperCase();
      entries = entries.filter(
        (e) =>
          e.callsign.includes(q) ||
          (e.name && e.name.toUpperCase().includes(q)) ||
          (e.qth && e.qth.toUpperCase().includes(q)) ||
          (e.grid && e.grid.toUpperCase().includes(q))
      );
    }
    return entries;
  }, [logbook, searchFilter]);

  const sorted = useMemo(() => {
    const compare = (a: LogEntry, b: LogEntry): number => {
      let result = 0;
      switch (sortKey) {
        case "callsign":
          result = a.callsign.localeCompare(b.callsign);
          break;
        case "name":
          result = (a.name ?? "").localeCompare(b.name ?? "");
          break;
        case "qth":
          result = (a.qth ?? "").localeCompare(b.qth ?? "");
          break;
        case "mode":
          result = Array.from(a.modes)
            .join(",")
            .localeCompare(Array.from(b.modes).join(","));
          break;
        case "band":
          result = Array.from(a.bands)
            .join(",")
            .localeCompare(Array.from(b.bands).join(","));
          break;
        case "frequency": {
          const fa = Array.from(a.frequencies)[0] ?? 0;
          const fb = Array.from(b.frequencies)[0] ?? 0;
          result = fa - fb;
          break;
        }
        case "firstHeard": {
          const ta = a.firstHeard?.getTime() ?? 0;
          const tb = b.firstHeard?.getTime() ?? 0;
          result = ta - tb;
          break;
        }
        case "lastHeard": {
          const ta = a.lastHeard?.getTime() ?? 0;
          const tb = b.lastHeard?.getTime() ?? 0;
          result = ta - tb;
          break;
        }
        case "count":
          result = a.count - b.count;
          break;
      }
      return sortAsc ? result : -result;
    };
    return [...filtered].sort(compare);
  }, [filtered, sortKey, sortAsc]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageEntries = sorted.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortAsc((a) => !a);
      } else {
        setSortKey(key);
        setSortAsc(key === "callsign");
      }
      setPage(1);
    },
    [sortKey]
  );

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return (
      <span className="ml-1 text-green-400">{sortAsc ? "\u25B2" : "\u25BC"}</span>
    );
  };

  const handleExportCsv = () => {
    const csv = generateCsv(sorted);
    downloadFile(csv, "sdr-logbook.csv", "text/csv");
  };

  const handleExportAdif = () => {
    const adif = generateAdif(sorted);
    downloadFile(adif, "sdr-logbook.adi", "application/octet-stream");
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Contact Log (QSO Logbook)</h1>
        <p className="text-gray-400 text-sm">
          Receive-only station log. Aggregates all heard callsigns from voice
          recordings, APRS, and FT8/WSPR digital modes.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="text-3xl font-bold text-green-400">
            {isLoading ? "\u2026" : stats.uniqueCallsigns.toLocaleString()}
          </div>
          <div className="text-sm text-gray-400 mt-1">Unique Callsigns</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="text-3xl font-bold text-cyan-400">
            {isLoading ? "\u2026" : stats.uniqueGrids.toLocaleString()}
          </div>
          <div className="text-sm text-gray-400 mt-1">Unique Grids</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="text-3xl font-bold text-amber-400">
            {isLoading ? "\u2026" : stats.uniqueStates.toLocaleString()}
          </div>
          <div className="text-sm text-gray-400 mt-1">States Heard</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="text-3xl font-bold text-purple-400">
            {isLoading ? "\u2026" : stats.activeBands.toLocaleString()}
          </div>
          <div className="text-sm text-gray-400 mt-1">Bands Active</div>
        </div>
      </div>

      {/* Grid map */}
      {gridCounts.size > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Grid Squares Heard</h2>
          <GridSquareMap grids={gridCounts} />
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded"
                style={{ backgroundColor: "rgb(34,197,94)", opacity: 0.3 }}
              />
              Fewer contacts
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded"
                style={{ backgroundColor: "rgb(74,222,128)", opacity: 1 }}
              />
              More contacts
            </span>
          </div>
        </div>
      )}

      {/* Controls: search + export */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Filter by callsign, name, QTH, grid..."
          value={searchFilter}
          onChange={(e) => {
            setSearchFilter(e.target.value);
            setPage(1);
          }}
          className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm flex-1 min-w-[200px] focus:outline-none focus:border-green-500"
        />
        <button
          onClick={handleExportCsv}
          disabled={sorted.length === 0}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
        >
          Export CSV
        </button>
        <button
          onClick={handleExportAdif}
          disabled={sorted.length === 0}
          className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
        >
          Export ADIF
        </button>
      </div>

      {/* Result count */}
      <div className="text-sm text-gray-400 mb-2">
        {isLoading
          ? "Loading logbook data..."
          : `${sorted.length.toLocaleString()} callsign${sorted.length !== 1 ? "s" : ""}${
              searchFilter.trim() ? " matching filter" : ""
            }`}
      </div>

      {/* Logbook table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left">
              {(
                [
                  ["callsign", "Callsign"],
                  ["name", "Name"],
                  ["qth", "QTH"],
                  ["mode", "Mode"],
                  ["band", "Band"],
                  ["frequency", "Frequency"],
                  ["firstHeard", "First Heard"],
                  ["lastHeard", "Last Heard"],
                  ["count", "Count"],
                ] as [SortKey, string][]
              ).map(([key, label]) => (
                <th
                  key={key}
                  onClick={() => handleSort(key)}
                  className="px-3 py-2 font-medium text-gray-300 cursor-pointer hover:text-white select-none whitespace-nowrap"
                >
                  {label}
                  {sortIndicator(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                  <div className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-400" />
                    Loading logbook data...
                  </div>
                </td>
              </tr>
            ) : pageEntries.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                  No callsigns found.
                </td>
              </tr>
            ) : (
              pageEntries.map((entry) => (
                <tr
                  key={entry.callsign}
                  className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors"
                >
                  <td className="px-3 py-2">
                    <Link
                      to={`/callsign/${encodeURIComponent(entry.callsign)}`}
                      className="text-green-400 hover:text-green-300 font-mono font-medium"
                    >
                      {entry.callsign}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-300">
                    {entry.name ?? "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-gray-300 max-w-[160px] truncate">
                    {entry.qth ?? "\u2014"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {Array.from(entry.modes).map((m) => (
                        <span
                          key={m}
                          className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                            m === "FT8" || m === "FT4"
                              ? "bg-cyan-900/50 text-cyan-300"
                              : m === "WSPR"
                              ? "bg-purple-900/50 text-purple-300"
                              : m === "APRS"
                              ? "bg-amber-900/50 text-amber-300"
                              : m === "CW"
                              ? "bg-yellow-900/50 text-yellow-300"
                              : m === "HFDL"
                              ? "bg-blue-900/50 text-blue-300"
                              : "bg-green-900/50 text-green-300"
                          }`}
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                    {Array.from(entry.bands).join(", ") || "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs whitespace-nowrap">
                    {entry.frequencies.size > 0
                      ? formatFrequency(Array.from(entry.frequencies)[0])
                      : "\u2014"}
                    {entry.frequencies.size > 1 && (
                      <span className="text-gray-600 ml-1">
                        +{entry.frequencies.size - 1}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">
                    {entry.firstHeard
                      ? formatDateTime(entry.firstHeard.toISOString())
                      : "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">
                    {entry.lastHeard
                      ? formatDateTime(entry.lastHeard.toISOString())
                      : "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {entry.count.toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-gray-500">
            Page {safePage} of {totalPages}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(1)}
              disabled={safePage <= 1}
              className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-40 hover:bg-gray-700 transition-colors"
            >
              First
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-40 hover:bg-gray-700 transition-colors"
            >
              Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-40 hover:bg-gray-700 transition-colors"
            >
              Next
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={safePage >= totalPages}
              className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-40 hover:bg-gray-700 transition-colors"
            >
              Last
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
