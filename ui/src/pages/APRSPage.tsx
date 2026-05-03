import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  listAprsPackets,
  listAprsStations,
  AprsPacket,
  AprsStation,
  AprsWeather,
} from "../api/client";
import { CallsignLink } from "../components/CallsignLink";
import { formatDateTime } from "../utils/time";

// ── Helpers ──────────────────────────────────────────────────────────

function fToC(f: number): string {
  return ((f - 32) * (5 / 9)).toFixed(1);
}

function formatWindDir(deg: number | null): string {
  if (deg == null) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

/** CSS rotation for a wind-direction arrow (points in the direction wind is blowing TO). */
function windArrowRotation(deg: number): string {
  return `rotate(${deg}deg)`;
}

function WeatherInline({ wx }: { wx: AprsWeather }) {
  const parts: string[] = [];
  if (wx.temp_f != null) parts.push(`${wx.temp_f}\u00b0F`);
  if (wx.humidity_pct != null) parts.push(`${wx.humidity_pct}% RH`);
  if (wx.pressure_mbar != null) parts.push(`${wx.pressure_mbar} mbar`);
  if (wx.rain_1h_in != null) parts.push(`Rain 1h: ${wx.rain_1h_in}"`);
  if (wx.rain_24h_in != null) parts.push(`24h: ${wx.rain_24h_in}"`);
  if (parts.length === 0)
    return <span className="text-gray-600 text-xs">no data</span>;
  return <span className="text-xs text-cyan-300">{parts.join(" \u00b7 ")}</span>;
}

function formatFrequency(hz: number): string {
  return `${(hz / 1_000_000).toFixed(4)} MHz`;
}

function formatTime(ts: string | null): string {
  return formatDateTime(ts);
}

function formatPos(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return "\u2014";
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

const HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "48h", value: 48 },
  { label: "7d", value: 168 },
];

type Tab = "packets" | "weather";

// ── Weather Summary Bar ──────────────────────────────────────────────

function WeatherSummaryBar({
  stations,
}: {
  stations: AprsStation[];
}) {
  const summary = useMemo(() => {
    const wxStations = stations.filter(
      (s) => s.is_weather && s.weather
    );
    if (wxStations.length === 0) return null;

    const temps: number[] = [];
    let maxWind = 0;
    let maxWindStation = "";
    const rains: number[] = [];

    for (const s of wxStations) {
      const wx = s.weather!;
      if (wx.temp_f != null) temps.push(wx.temp_f);
      if (wx.wind_speed_mph != null && wx.wind_speed_mph > maxWind) {
        maxWind = wx.wind_speed_mph;
        maxWindStation = s.callsign;
      }
      if (wx.rain_24h_in != null) rains.push(wx.rain_24h_in);
    }

    const avgTemp =
      temps.length > 0
        ? temps.reduce((a, b) => a + b, 0) / temps.length
        : null;
    const avgRain =
      rains.length > 0
        ? rains.reduce((a, b) => a + b, 0) / rains.length
        : null;

    return { count: wxStations.length, avgTemp, maxWind, maxWindStation, avgRain };
  }, [stations]);

  if (!summary) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
      <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Weather Stations
        </div>
        <div className="text-xl font-bold text-cyan-400">{summary.count}</div>
      </div>

      {summary.avgTemp != null && (
        <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            Avg Temperature
          </div>
          <div className="text-xl font-bold text-yellow-400">
            {summary.avgTemp.toFixed(1)}&deg;F
            <span className="text-sm text-gray-400 ml-1">
              / {fToC(summary.avgTemp)}&deg;C
            </span>
          </div>
        </div>
      )}

      {summary.maxWind > 0 && (
        <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            Max Wind
          </div>
          <div className="text-xl font-bold text-emerald-400">
            {summary.maxWind} mph
          </div>
          <div className="text-xs text-gray-500">{summary.maxWindStation}</div>
        </div>
      )}

      {summary.avgRain != null && (
        <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            Avg Rainfall (24h)
          </div>
          <div className="text-xl font-bold text-blue-400">
            {summary.avgRain.toFixed(2)}&Prime;
          </div>
        </div>
      )}
    </div>
  );
}

// ── Weather Station Card ─────────────────────────────────────────────

function WeatherCard({ station }: { station: AprsStation }) {
  const wx = station.weather!;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 hover:border-cyan-700 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">&#x26C5;</span>
          <CallsignLink
            callsign={station.callsign}
            className="font-bold text-cyan-400 hover:underline"
          />
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-cyan-900 text-cyan-300 font-semibold uppercase">
            WX
          </span>
        </div>
        {station.last_heard && (
          <span className="text-xs text-gray-500">
            {formatTime(station.last_heard)}
          </span>
        )}
      </div>

      {/* Temperature row */}
      {wx.temp_f != null && (
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-3xl font-bold text-white">
            {wx.temp_f.toFixed(1)}&deg;F
          </span>
          <span className="text-lg text-gray-400">
            / {fToC(wx.temp_f)}&deg;C
          </span>
        </div>
      )}

      {/* Detail grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {/* Wind */}
        {(wx.wind_speed_mph != null || wx.wind_dir_deg != null) && (
          <div className="col-span-2 flex items-center gap-2 text-gray-300">
            {wx.wind_dir_deg != null && (
              <span
                className="inline-block text-emerald-400 text-lg leading-none"
                style={{ transform: windArrowRotation(wx.wind_dir_deg) }}
                title={`${wx.wind_dir_deg}\u00b0`}
              >
                &#x2191;
              </span>
            )}
            <span>
              {wx.wind_dir_deg != null && (
                <span className="font-medium text-emerald-400 mr-1">
                  {formatWindDir(wx.wind_dir_deg)}
                </span>
              )}
              {wx.wind_speed_mph != null && (
                <span>{wx.wind_speed_mph} mph</span>
              )}
              {wx.wind_gust_mph != null && (
                <span className="text-yellow-400 ml-1">
                  (gusts {wx.wind_gust_mph} mph)
                </span>
              )}
            </span>
          </div>
        )}

        {/* Humidity */}
        {wx.humidity_pct != null && (
          <div>
            <span className="text-gray-500 text-xs uppercase">Humidity</span>
            <div className="text-gray-200 font-medium">
              {wx.humidity_pct}%
            </div>
          </div>
        )}

        {/* Pressure */}
        {wx.pressure_mbar != null && (
          <div>
            <span className="text-gray-500 text-xs uppercase">Pressure</span>
            <div className="text-gray-200 font-medium">
              {wx.pressure_mbar.toFixed(1)} mbar
            </div>
          </div>
        )}

        {/* Rain 1h */}
        {wx.rain_1h_in != null && (
          <div>
            <span className="text-gray-500 text-xs uppercase">Rain (1h)</span>
            <div className="text-blue-300 font-medium">
              {wx.rain_1h_in.toFixed(2)}&Prime;
            </div>
          </div>
        )}

        {/* Rain 24h */}
        {wx.rain_24h_in != null && (
          <div>
            <span className="text-gray-500 text-xs uppercase">Rain (24h)</span>
            <div className="text-blue-300 font-medium">
              {wx.rain_24h_in.toFixed(2)}&Prime;
            </div>
          </div>
        )}
      </div>

      {/* Position */}
      {station.latitude != null && station.longitude != null && (
        <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-500 font-mono">
          {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}
          {station.frequency_hz != null && (
            <span className="ml-2 text-gray-600">
              {formatFrequency(station.frequency_hz)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Packets Tab ──────────────────────────────────────────────────────

function PacketsTab({
  callsign,
  setCallsign,
  hours,
  setHours,
  page,
  setPage,
}: {
  callsign: string;
  setCallsign: (v: string) => void;
  hours: number;
  setHours: (v: number) => void;
  page: number;
  setPage: (v: number | ((p: number) => number)) => void;
}) {
  const limit = 50;

  const { data, isLoading, error } = useQuery({
    queryKey: ["aprs-packets", callsign, hours, page],
    queryFn: () =>
      listAprsPackets({
        callsign: callsign.trim() || undefined,
        hours,
        page,
        limit,
      }),
    staleTime: 30_000,
  });

  const packets: AprsPacket[] = data?.packets ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  function handleCallsignSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
  }

  return (
    <>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <form onSubmit={handleCallsignSubmit} className="flex gap-2">
          <input
            type="text"
            value={callsign}
            onChange={(e) => {
              setCallsign(e.target.value);
              setPage(1);
            }}
            placeholder="Filter callsign\u2026"
            className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-400 w-48"
          />
        </form>

        <div className="flex gap-1">
          {HOURS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setHours(opt.value);
                setPage(1);
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
      </div>

      {isLoading && (
        <div className="text-center py-16 text-gray-400">Loading...</div>
      )}
      {error && (
        <div className="text-red-400 py-8">Failed to load: {String(error)}</div>
      )}

      {!isLoading && !error && packets.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          No APRS packets found.
        </div>
      )}

      {!isLoading && packets.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-800 text-gray-400 text-left">
                  <th className="px-3 py-2 font-medium">Callsign</th>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Freq</th>
                  <th className="px-3 py-2 font-medium">Position</th>
                  <th className="px-3 py-2 font-medium">Speed/Crs</th>
                  <th className="px-3 py-2 font-medium">Alt ft</th>
                  <th className="px-3 py-2 font-medium">Comment / Data</th>
                </tr>
              </thead>
              <tbody>
                {packets.map((p, i) => (
                  <tr
                    key={`${p.id}-${i}`}
                    className="border-t border-gray-700 hover:bg-gray-800/50"
                  >
                    <td className="px-3 py-2 font-mono text-blue-400 whitespace-nowrap">
                      <CallsignLink
                        callsign={p.callsign}
                        className="hover:underline"
                      />
                      {p.is_weather && (
                        <span className="ml-1.5 px-1 py-0.5 text-[10px] rounded bg-cyan-900 text-cyan-300 font-sans">
                          WX
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                      {formatTime(p.timestamp)}
                    </td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                      {p.frequency_hz
                        ? formatFrequency(p.frequency_hz)
                        : "\u2014"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-300 whitespace-nowrap">
                      {formatPos(p.latitude, p.longitude)}
                    </td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                      {p.is_weather
                        ? p.weather?.wind_speed_mph != null
                          ? `${p.weather.wind_speed_mph}mph ${p.weather.wind_dir_deg != null ? `${p.weather.wind_dir_deg}\u00b0` : ""}`
                          : "\u2014"
                        : p.speed_kt != null
                          ? `${p.speed_kt}kt ${p.course != null ? `${p.course}\u00b0` : ""}`
                          : "\u2014"}
                    </td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                      {p.is_weather
                        ? p.weather?.temp_f != null
                          ? `${p.weather.temp_f}\u00b0F`
                          : "\u2014"
                        : (p.altitude_ft ?? "\u2014")}
                    </td>
                    <td className="px-3 py-2 text-gray-300 max-w-sm">
                      {p.is_weather && p.weather ? (
                        <WeatherInline wx={p.weather} />
                      ) : p.comment ? (
                        p.comment
                      ) : (
                        <span className="text-gray-600 font-mono text-xs break-all">
                          {p.packet}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex justify-between items-center mt-4 text-sm text-gray-400">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1 rounded bg-gray-800 disabled:opacity-40 hover:bg-gray-700"
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1 rounded bg-gray-800 disabled:opacity-40 hover:bg-gray-700"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ── Weather Tab ──────────────────────────────────────────────────────

function WeatherTab({ hours }: { hours: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["aprs-stations-wx", hours],
    queryFn: () => listAprsStations(hours),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const wxStations = useMemo(() => {
    if (!data?.stations) return [];
    return data.stations.filter(
      (s) => s.is_weather === true && s.weather != null
    );
  }, [data]);

  return (
    <>
      {isLoading && (
        <div className="text-center py-16 text-gray-400">
          Loading weather stations...
        </div>
      )}
      {error && (
        <div className="text-red-400 py-8">Failed to load: {String(error)}</div>
      )}

      {!isLoading && !error && wxStations.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          No APRS weather stations heard in the last {hours < 168 ? `${hours}h` : "7d"}.
        </div>
      )}

      {!isLoading && wxStations.length > 0 && (
        <>
          <WeatherSummaryBar stations={wxStations} />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {wxStations.map((s) => (
              <WeatherCard key={s.callsign} station={s} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export default function APRSPage() {
  const [tab, setTab] = useState<Tab>("packets");
  const [callsign, setCallsign] = useState("");
  const [hours, setHours] = useState(24);
  const [page, setPage] = useState(1);

  // Prefetch weather station count for badge
  const { data: stationsData } = useQuery({
    queryKey: ["aprs-stations-wx", hours],
    queryFn: () => listAprsStations(hours),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const wxCount = useMemo(() => {
    if (!stationsData?.stations) return 0;
    return stationsData.stations.filter(
      (s) => s.is_weather === true && s.weather != null
    ).length;
  }, [stationsData]);

  // Packets count (from same query the PacketsTab uses, but only for header display)
  const { data: packetsData } = useQuery({
    queryKey: ["aprs-packets", callsign, hours, page],
    queryFn: () =>
      listAprsPackets({
        callsign: callsign.trim() || undefined,
        hours,
        page,
        limit: 50,
      }),
    staleTime: 30_000,
    enabled: tab === "packets",
  });

  const totalPackets = packetsData?.total ?? 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">APRS</h1>

          {/* Tabs */}
          <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
            <button
              onClick={() => setTab("packets")}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === "packets"
                  ? "bg-green-600 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Packets
              {tab === "packets" && totalPackets > 0 && (
                <span className="ml-1.5 text-xs opacity-75">
                  ({totalPackets.toLocaleString()})
                </span>
              )}
            </button>
            <button
              onClick={() => setTab("weather")}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === "weather"
                  ? "bg-cyan-600 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Weather
              {wxCount > 0 && (
                <span
                  className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
                    tab === "weather"
                      ? "bg-cyan-700 text-cyan-200"
                      : "bg-cyan-900 text-cyan-400"
                  }`}
                >
                  {wxCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Export buttons + hours selector (shared) */}
        <div className="flex items-center gap-3">
          {tab === "packets" && (
            <div className="flex gap-1">
              <a
                href={`/api/v1/aprs/export?format=geojson&hours=${hours}`}
                download
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium text-gray-200"
                title="Download GeoJSON"
              >
                GeoJSON &darr;
              </a>
              <a
                href={`/api/v1/aprs/export?format=csv&hours=${hours}`}
                download
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium text-gray-200"
                title="Download CSV"
              >
                CSV &darr;
              </a>
            </div>
          )}

          {/* Time range selector -- shared by both tabs */}
          <div className="flex gap-1">
            {HOURS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setHours(opt.value);
                  setPage(1);
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
        </div>
      </div>

      {/* Tab content */}
      {tab === "packets" && (
        <PacketsTab
          callsign={callsign}
          setCallsign={setCallsign}
          hours={hours}
          setHours={setHours}
          page={page}
          setPage={setPage}
        />
      )}
      {tab === "weather" && <WeatherTab hours={hours} />}
    </div>
  );
}
