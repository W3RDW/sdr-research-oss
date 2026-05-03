import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MapContainer,
  TileLayer,
  Marker,
  CircleMarker,
  GeoJSON,
  Popup,
  useMap,
} from "react-leaflet";
import {
  getForecast,
  getMesoscaleDiscussions,
  getMetars,
  getSpcOutlook,
  getStationCenter,
  getStormReports,
  getWeatherAlerts,
  listAprsStations,
  type AlertSeverity,
  type AprsStation,
  type ForecastPeriod,
  type MetarObservation,
  type StormReport,
  type WeatherAlert,
} from "../api/client";
import { CallsignLink } from "../components/CallsignLink";
import { formatDateTime } from "../utils/time";

// ── helpers ──────────────────────────────────────────────────────────

const DEFAULT_CENTER: [number, number] = [39.0, -84.0];
const DEFAULT_ZOOM = 7;

function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9);
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function formatWindDir(deg: number | null): string {
  if (deg == null) return "";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Severity → color/styling for warning banners + map polygons
const ALERT_STYLE: Record<string, { color: string; fill: string; weight: number; cls: string }> = {
  Tornado: { color: "#ef4444", fill: "#7f1d1d", weight: 3, cls: "bg-red-700/80 border-red-400 text-red-50" },
  TornadoWatch: { color: "#facc15", fill: "#713f12", weight: 2, cls: "bg-yellow-700/80 border-yellow-400 text-yellow-50" },
  Severe: { color: "#f97316", fill: "#7c2d12", weight: 2, cls: "bg-orange-700/80 border-orange-400 text-orange-50" },
  Flood: { color: "#22c55e", fill: "#14532d", weight: 2, cls: "bg-green-700/80 border-green-400 text-green-50" },
  Winter: { color: "#60a5fa", fill: "#1e3a8a", weight: 2, cls: "bg-blue-700/80 border-blue-400 text-blue-50" },
  Heat: { color: "#dc2626", fill: "#450a0a", weight: 2, cls: "bg-rose-700/80 border-rose-400 text-rose-50" },
  Wind: { color: "#a855f7", fill: "#581c87", weight: 2, cls: "bg-purple-700/80 border-purple-400 text-purple-50" },
  Marine: { color: "#06b6d4", fill: "#155e75", weight: 2, cls: "bg-cyan-700/80 border-cyan-400 text-cyan-50" },
  Default: { color: "#94a3b8", fill: "#1e293b", weight: 1.5, cls: "bg-slate-700/80 border-slate-400 text-slate-100" },
};

function classifyAlert(event: string | null): keyof typeof ALERT_STYLE {
  if (!event) return "Default";
  const e = event.toLowerCase();
  if (e.includes("tornado watch")) return "TornadoWatch";
  if (e.includes("tornado")) return "Tornado";
  if (e.includes("severe thunderstorm") || e.includes("severe weather")) return "Severe";
  if (e.includes("flood") || e.includes("flash flood")) return "Flood";
  if (e.includes("winter") || e.includes("snow") || e.includes("ice") || e.includes("blizzard")) return "Winter";
  if (e.includes("heat") || e.includes("excessive heat")) return "Heat";
  if (e.includes("wind") || e.includes("hurricane")) return "Wind";
  if (e.includes("marine") || e.includes("gale") || e.includes("small craft")) return "Marine";
  return "Default";
}

function severityRank(s: AlertSeverity | null | undefined): number {
  return ({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 } as const)[
    (s || "Unknown") as AlertSeverity
  ] ?? 4;
}

// SPC categorical outlook colors (matches NWS official scheme)
const SPC_CAT_COLORS: Record<string, string> = {
  TSTM: "#c0e8c0",
  MRGL: "#7fc97f",
  SLGT: "#f6e372",
  ENH: "#e69138",
  MDT: "#cc0000",
  HIGH: "#ff00ff",
};

// ── Map auto-fly when station center loads ────────────────────────

function MapFlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
  }, [center[0], center[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ── Storm report icons ────────────────────────────────────────────

function stormReportIcon(type: StormReport["type"]) {
  const colors = { tornado: "#ef4444", hail: "#3b82f6", wind: "#f59e0b", other: "#94a3b8" };
  const symbols = { tornado: "🌪", hail: "🧊", wind: "💨", other: "•" };
  return L.divIcon({
    html: `<div style="font-size:18px;line-height:1;text-shadow:0 0 4px ${colors[type]},0 0 2px #000;">${symbols[type]}</div>`,
    className: "",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -10],
  });
}

// ── Main page ─────────────────────────────────────────────────────

type SpcDay = 1 | 2 | 3;

export default function WeatherPage() {
  // Layer toggles
  const [showRadar, setShowRadar] = useState(true);
  const [showAlerts, setShowAlerts] = useState(true);
  const [showOutlook, setShowOutlook] = useState(true);
  const [showReports, setShowReports] = useState(true);
  const [showMetars, setShowMetars] = useState(true);
  const [showAprs, setShowAprs] = useState(true);
  const [spcDay, setSpcDay] = useState<SpcDay>(1);
  const [reportDate, setReportDate] = useState<"today" | "yesterday">("today");
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);

  const { data: stationCenter } = useQuery({
    queryKey: ["station-center-weather"],
    queryFn: getStationCenter,
    staleTime: Infinity,
  });

  const center: [number, number] = stationCenter
    ? [stationCenter.latitude, stationCenter.longitude]
    : DEFAULT_CENTER;

  // Data fetching
  const { data: alertsResp } = useQuery({
    queryKey: ["weather-alerts", center[0], center[1]],
    queryFn: () => getWeatherAlerts(center[0], center[1]),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: !!stationCenter,
  });

  const { data: metarsResp } = useQuery({
    queryKey: ["weather-metars", center[0], center[1]],
    queryFn: () => getMetars({ lat: center[0], lon: center[1], radius_km: 200, limit: 12 }),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    enabled: !!stationCenter,
  });

  const { data: forecastResp } = useQuery({
    queryKey: ["weather-forecast", center[0], center[1]],
    queryFn: () => getForecast({ lat: center[0], lon: center[1] }),
    refetchInterval: 30 * 60_000,
    staleTime: 10 * 60_000,
    enabled: !!stationCenter,
  });

  const { data: outlookResp } = useQuery({
    queryKey: ["spc-outlook", spcDay],
    queryFn: () => getSpcOutlook(spcDay, "cat"),
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
  });

  const { data: reportsResp } = useQuery({
    queryKey: ["spc-reports", reportDate],
    queryFn: () => getStormReports(reportDate),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const { data: mdsResp } = useQuery({
    queryKey: ["spc-mds"],
    queryFn: () => getMesoscaleDiscussions(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const { data: aprsResp } = useQuery({
    queryKey: ["aprs-stations-weather"],
    queryFn: () => listAprsStations(24),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // RainViewer radar
  const { data: radarMeta } = useQuery({
    queryKey: ["rainviewer-meta"],
    queryFn: () =>
      fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => r.json()),
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
    enabled: showRadar,
  });
  const radarFrames: { path: string; time: number }[] = radarMeta?.radar?.past ?? [];
  const radarHost: string | undefined = radarMeta?.host;

  // Animation index for radar loop
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (!playing || radarFrames.length === 0) return;
    const t = setInterval(
      () => setFrameIdx((i) => (i + 1) % radarFrames.length),
      600,
    );
    return () => clearInterval(t);
  }, [playing, radarFrames.length]);

  const currentFrame = radarFrames[Math.min(frameIdx, Math.max(0, radarFrames.length - 1))];
  const radarUrl =
    radarHost && currentFrame
      ? `${radarHost}${currentFrame.path}/256/{z}/{x}/{y}/8/1_1.png`
      : null;

  const alerts = alertsResp?.alerts ?? [];
  const metars = metarsResp?.metars ?? [];
  const forecastPeriods = forecastResp?.periods ?? [];
  const reports = reportsResp?.reports ?? [];
  const mds = mdsResp?.items ?? [];
  const aprsWx = useMemo(
    () =>
      (aprsResp?.stations ?? []).filter(
        (s) => s.is_weather === true && s.weather && s.latitude != null && s.longitude != null,
      ),
    [aprsResp],
  );

  // Critical alerts (tornado warnings, etc.) for the top banner
  const criticalAlerts = useMemo(
    () =>
      alerts.filter(
        (a) =>
          a.severity === "Extreme" ||
          (a.severity === "Severe" &&
            (a.event?.toLowerCase().includes("tornado") ||
              a.event?.toLowerCase().includes("flash flood emergency"))),
      ),
    [alerts],
  );

  const selectedAlert = useMemo(
    () => alerts.find((a) => a.id === selectedAlertId) || null,
    [alerts, selectedAlertId],
  );

  const closestMetar = metars[0] ?? null;

  const torWarn = alerts.filter((a) => a.event?.toLowerCase().startsWith("tornado warn")).length;
  const svrWarn = alerts.filter((a) => a.event?.toLowerCase().includes("severe thunderstorm warn")).length;
  const ffWarn = alerts.filter((a) => a.event?.toLowerCase().includes("flash flood")).length;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Weather Intelligence</h1>
          {forecastResp?.city && (
            <span className="text-sm text-gray-400">
              {forecastResp.city}, {forecastResp.state}
              {forecastResp.office && ` · ${forecastResp.office}`}
            </span>
          )}
        </div>

        {/* Severity pills */}
        <div className="flex items-center gap-2 text-xs font-semibold">
          {torWarn > 0 && (
            <span className="px-2 py-1 rounded bg-red-700 text-white animate-pulse">
              {torWarn} TORNADO
            </span>
          )}
          {svrWarn > 0 && (
            <span className="px-2 py-1 rounded bg-orange-700 text-white">
              {svrWarn} SVR T-STORM
            </span>
          )}
          {ffWarn > 0 && (
            <span className="px-2 py-1 rounded bg-green-700 text-white">
              {ffWarn} FLASH FLOOD
            </span>
          )}
          <span className="text-gray-500">
            {alertsResp?.fetched_at ? `updated ${relTime(alertsResp.fetched_at)}` : ""}
          </span>
        </div>
      </div>

      {/* Critical alerts banner */}
      {criticalAlerts.length > 0 && (
        <div className="border-2 border-red-500 bg-red-950/50 rounded p-2 flex flex-col gap-1 animate-pulse">
          {criticalAlerts.slice(0, 3).map((a) => (
            <button
              key={a.id}
              onClick={() => setSelectedAlertId(a.id)}
              className="text-left text-sm text-red-100 hover:text-white"
            >
              <span className="font-bold">⚠ {a.event}</span>{" "}
              <span className="text-red-300">{a.areaDesc}</span>
              {a.expires && (
                <span className="text-xs text-red-400 ml-2">until {formatDateTime(a.expires)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Layer toolbar */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-300">
        <ToggleChip on={showRadar} setOn={setShowRadar} accent="sky">Radar</ToggleChip>
        <ToggleChip on={showAlerts} setOn={setShowAlerts} accent="red">Alerts ({alerts.length})</ToggleChip>
        <ToggleChip on={showOutlook} setOn={setShowOutlook} accent="amber">SPC Day {spcDay}</ToggleChip>
        <ToggleChip on={showReports} setOn={setShowReports} accent="purple">
          Storm Reports ({reportsResp?.count ?? 0})
        </ToggleChip>
        <ToggleChip on={showMetars} setOn={setShowMetars} accent="cyan">METAR ({metars.length})</ToggleChip>
        <ToggleChip on={showAprs} setOn={setShowAprs} accent="emerald">APRS WX ({aprsWx.length})</ToggleChip>

        <div className="h-4 border-l border-gray-700" />

        <select
          value={spcDay}
          onChange={(e) => setSpcDay(Number(e.target.value) as SpcDay)}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs"
        >
          <option value={1}>Day 1</option>
          <option value={2}>Day 2</option>
          <option value={3}>Day 3</option>
        </select>

        <select
          value={reportDate}
          onChange={(e) => setReportDate(e.target.value as "today" | "yesterday")}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs"
        >
          <option value="today">Today's Reports</option>
          <option value="yesterday">Yesterday's Reports</option>
        </select>

        <div className="h-4 border-l border-gray-700" />

        {radarFrames.length > 0 && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPlaying((p) => !p)}
              className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded"
            >
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <input
              type="range"
              min={0}
              max={radarFrames.length - 1}
              value={frameIdx}
              onChange={(e) => {
                setPlaying(false);
                setFrameIdx(Number(e.target.value));
              }}
              className="w-32 accent-sky-400"
            />
            <span className="text-gray-500 text-[11px] tabular-nums">
              {currentFrame ? new Date(currentFrame.time * 1000).toLocaleTimeString() : ""}
            </span>
          </div>
        )}
      </div>

      {/* Main grid: map + side panel */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-3 min-h-0">
        {/* Map */}
        <div className="rounded-lg overflow-hidden border border-gray-700 min-h-[500px]">
          <MapContainer
            key={`${center[0]},${center[1]}`}
            center={center}
            zoom={DEFAULT_ZOOM}
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {showRadar && radarUrl && (
              <TileLayer
                key={radarUrl}
                url={radarUrl}
                opacity={0.55}
                attribution='Radar &copy; <a href="https://www.rainviewer.com">RainViewer</a>'
              />
            )}

            {showOutlook && outlookResp?.geojson && (
              <GeoJSON
                key={`spc-${spcDay}-${outlookResp.fetched_at}`}
                data={outlookResp.geojson as GeoJSON.FeatureCollection}
                style={(feat) => {
                  const label = (feat?.properties as { LABEL?: string })?.LABEL ?? "TSTM";
                  const color = SPC_CAT_COLORS[label] ?? "#94a3b8";
                  return { color, weight: 1.5, fillColor: color, fillOpacity: 0.18 };
                }}
                onEachFeature={(feat, layer) => {
                  const p = (feat.properties || {}) as { LABEL?: string; LABEL2?: string };
                  layer.bindPopup(
                    `<div><strong>SPC Day ${spcDay}</strong><br/>${p.LABEL2 || p.LABEL || "Outlook"}</div>`,
                  );
                }}
              />
            )}

            {showAlerts &&
              alerts
                .filter((a) => a.geometry)
                .map((a) => {
                  const style = ALERT_STYLE[classifyAlert(a.event)] ?? ALERT_STYLE.Default;
                  return (
                    <GeoJSON
                      key={a.id}
                      data={a.geometry as GeoJSON.Geometry}
                      style={() => ({
                        color: style.color,
                        weight: style.weight,
                        fillColor: style.fill,
                        fillOpacity: a.event?.toLowerCase().includes("warn") ? 0.35 : 0.15,
                        dashArray: a.event?.toLowerCase().includes("watch") ? "6 4" : undefined,
                      })}
                      eventHandlers={{
                        click: () => setSelectedAlertId(a.id),
                      }}
                    />
                  );
                })}

            {showReports &&
              reports.map((r, i) => (
                <Marker
                  key={`${r.type}-${i}`}
                  position={[r.lat, r.lon]}
                  icon={stormReportIcon(r.type)}
                >
                  <Popup>
                    <div className="text-xs">
                      <div className="font-bold uppercase">{r.type}{r.magnitude ? ` ${r.magnitude}` : ""}</div>
                      <div>{r.location}</div>
                      <div className="text-gray-600">{r.county}, {r.state} · {r.time}Z</div>
                      {r.comments && <div className="mt-1 italic">{r.comments}</div>}
                    </div>
                  </Popup>
                </Marker>
              ))}

            {showMetars &&
              metars.map((m) => (
                <CircleMarker
                  key={m.station_id}
                  center={[m.lat, m.lon]}
                  radius={5}
                  pathOptions={{
                    color: "#22d3ee",
                    fillColor: "#22d3ee",
                    fillOpacity: 0.7,
                    weight: 1.5,
                  }}
                >
                  <Popup>
                    <MetarPopup m={m} />
                  </Popup>
                </CircleMarker>
              ))}

            {showAprs &&
              aprsWx.map((s) => (
                <CircleMarker
                  key={s.callsign}
                  center={[s.latitude!, s.longitude!]}
                  radius={5}
                  pathOptions={{
                    color: "#34d399",
                    fillColor: "#34d399",
                    fillOpacity: 0.7,
                    weight: 1.5,
                  }}
                >
                  <Popup>
                    <AprsWxPopup s={s} />
                  </Popup>
                </CircleMarker>
              ))}

            <MapFlyTo center={center} zoom={DEFAULT_ZOOM} />
          </MapContainer>
        </div>

        {/* Side panel */}
        <div className="flex flex-col gap-3 overflow-y-auto pr-1 min-h-0">
          {selectedAlert ? (
            <AlertDetailPanel alert={selectedAlert} onClose={() => setSelectedAlertId(null)} />
          ) : (
            <AlertsPanel alerts={alerts} onSelect={setSelectedAlertId} />
          )}

          {closestMetar && <CurrentConditionsPanel metar={closestMetar} />}

          <ForecastPanel periods={forecastPeriods.slice(0, 8)} />

          {reports.length > 0 && (
            <StormReportsPanel
              reports={reports}
              byType={reportsResp?.by_type}
              date={reportsResp?.date ?? ""}
            />
          )}

          {mds.length > 0 && <MesoscaleDiscussionsPanel items={mds.slice(0, 5)} />}

          {aprsWx.length > 0 && (
            <AprsWxStationsPanel stations={aprsWx.slice(0, 8)} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function ToggleChip({
  on,
  setOn,
  accent,
  children,
}: {
  on: boolean;
  setOn: (b: boolean) => void;
  accent: "sky" | "red" | "amber" | "purple" | "cyan" | "emerald";
  children: React.ReactNode;
}) {
  const accents = {
    sky: "accent-sky-400",
    red: "accent-red-400",
    amber: "accent-amber-400",
    purple: "accent-purple-400",
    cyan: "accent-cyan-400",
    emerald: "accent-emerald-400",
  };
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
        className={accents[accent]}
      />
      {children}
    </label>
  );
}

function AlertsPanel({
  alerts,
  onSelect,
}: {
  alerts: WeatherAlert[];
  onSelect: (id: string) => void;
}) {
  const sorted = [...alerts].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (a.expires || "").localeCompare(b.expires || ""),
  );
  return (
    <Panel title={`Active Alerts (${alerts.length})`}>
      {sorted.length === 0 ? (
        <div className="text-sm text-gray-500 italic">No active alerts in your area.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.slice(0, 25).map((a) => {
            const cls = ALERT_STYLE[classifyAlert(a.event)] ?? ALERT_STYLE.Default;
            return (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                className={`text-left px-2 py-1.5 rounded border-l-4 ${cls.cls} hover:brightness-125 transition`}
              >
                <div className="font-semibold text-sm">{a.event}</div>
                <div className="text-xs opacity-80 line-clamp-1">{a.areaDesc}</div>
                <div className="text-[10px] opacity-60 flex justify-between mt-0.5">
                  <span>{a.severity}</span>
                  <span>{a.expires ? `expires ${relTime(a.expires)}` : ""}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function AlertDetailPanel({
  alert,
  onClose,
}: {
  alert: WeatherAlert;
  onClose: () => void;
}) {
  const cls = ALERT_STYLE[classifyAlert(alert.event)] ?? ALERT_STYLE.Default;
  return (
    <div className={`rounded border-l-4 ${cls.cls} p-3 flex flex-col gap-2`}>
      <div className="flex justify-between items-start gap-2">
        <div>
          <div className="font-bold text-base">{alert.event}</div>
          <div className="text-xs opacity-80">{alert.senderName}</div>
        </div>
        <button onClick={onClose} className="text-xs opacity-60 hover:opacity-100">
          ← back
        </button>
      </div>
      <div className="text-xs flex gap-3 flex-wrap opacity-90">
        <span><b>Severity:</b> {alert.severity}</span>
        <span><b>Urgency:</b> {alert.urgency}</span>
        <span><b>Certainty:</b> {alert.certainty}</span>
      </div>
      <div className="text-xs opacity-80">{alert.areaDesc}</div>
      <div className="text-xs opacity-90">
        <b>Effective:</b> {formatDateTime(alert.effective)}
        {alert.expires && <> · <b>Expires:</b> {formatDateTime(alert.expires)}</>}
      </div>
      {alert.headline && (
        <div className="text-sm font-semibold border-t border-white/20 pt-2">{alert.headline}</div>
      )}
      {alert.description && (
        <div className="text-xs whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
          {alert.description}
        </div>
      )}
      {alert.instruction && (
        <div className="text-xs whitespace-pre-wrap leading-relaxed bg-black/30 rounded p-2 mt-1">
          <b>Instructions:</b> {alert.instruction}
        </div>
      )}
    </div>
  );
}

function CurrentConditionsPanel({ metar }: { metar: MetarObservation }) {
  return (
    <Panel title="Current Conditions" subtitle={`${metar.station_id} · ${metar.name} · ${metar.distance_km} km`}>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold">{metar.temp_f != null ? `${Math.round(metar.temp_f)}°F` : "—"}</span>
        {metar.temp_c != null && <span className="text-gray-400">/ {Math.round(metar.temp_c)}°C</span>}
      </div>
      <div className="text-sm text-gray-300">{metar.text_description}</div>
      <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
        <Stat label="Wind">
          {metar.wind_dir_deg != null ? `${formatWindDir(metar.wind_dir_deg)} ` : ""}
          {metar.wind_speed_mph != null ? `${metar.wind_speed_mph} mph` : "calm"}
          {metar.wind_gust_mph ? ` G${metar.wind_gust_mph}` : ""}
        </Stat>
        <Stat label="Humidity">{metar.humidity_pct != null ? `${metar.humidity_pct}%` : "—"}</Stat>
        <Stat label="Dew Pt">{metar.dewpoint_f != null ? `${Math.round(metar.dewpoint_f)}°F` : "—"}</Stat>
        <Stat label="Pressure">{metar.pressure_mbar != null ? `${metar.pressure_mbar} mb` : "—"}</Stat>
        <Stat label="Visibility">{metar.visibility_mi != null ? `${metar.visibility_mi} mi` : "—"}</Stat>
        <Stat label="Ceiling">{metar.ceiling_ft != null ? `${metar.ceiling_ft} ft` : "—"}</Stat>
      </div>
      {metar.raw_metar && (
        <div className="font-mono text-[10px] text-gray-500 mt-2 break-all">{metar.raw_metar}</div>
      )}
      <div className="text-[10px] text-gray-600 mt-1">
        observed {relTime(metar.timestamp)}
      </div>
    </Panel>
  );
}

function ForecastPanel({ periods }: { periods: ForecastPeriod[] }) {
  if (!periods.length) return null;
  return (
    <Panel title="Forecast">
      <div className="grid grid-cols-2 gap-2">
        {periods.map((p, i) => (
          <div key={i} className="bg-gray-800 rounded p-2 text-xs">
            <div className="font-semibold text-gray-200 truncate">{p.name}</div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className={`text-lg font-bold ${p.is_daytime ? "text-yellow-300" : "text-blue-300"}`}>
                {p.temp}°{p.temp_unit}
              </span>
              {p.precip_chance != null && p.precip_chance > 0 && (
                <span className="text-blue-400 text-[10px]">💧{p.precip_chance}%</span>
              )}
            </div>
            <div className="text-gray-400 line-clamp-2 mt-0.5">{p.short_forecast}</div>
            <div className="text-[10px] text-gray-500 mt-1">
              {p.wind_dir} {p.wind_speed}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function StormReportsPanel({
  reports,
  byType,
  date,
}: {
  reports: StormReport[];
  byType?: { tornado: number; hail: number; wind: number };
  date: string;
}) {
  return (
    <Panel title={`Storm Reports`} subtitle={date}>
      {byType && (
        <div className="flex gap-2 text-xs mb-2">
          <span className="px-2 py-0.5 rounded bg-red-900 text-red-200">🌪 {byType.tornado} tor</span>
          <span className="px-2 py-0.5 rounded bg-blue-900 text-blue-200">🧊 {byType.hail} hail</span>
          <span className="px-2 py-0.5 rounded bg-amber-900 text-amber-200">💨 {byType.wind} wind</span>
        </div>
      )}
      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
        {reports.slice(0, 20).map((r, i) => (
          <div key={i} className="text-[11px] flex items-baseline gap-1.5">
            <span className="w-6 text-center">
              {r.type === "tornado" ? "🌪" : r.type === "hail" ? "🧊" : r.type === "wind" ? "💨" : "•"}
            </span>
            <span className="text-gray-400 tabular-nums">{r.time}Z</span>
            {r.magnitude && <span className="text-yellow-300 font-semibold">{r.magnitude}</span>}
            <span className="text-gray-200 truncate flex-1">
              {r.location} <span className="text-gray-500">({r.county}, {r.state})</span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function MesoscaleDiscussionsPanel({
  items,
}: {
  items: { title: string | null; link: string | null; pub_date: string | null }[];
}) {
  return (
    <Panel title="SPC Mesoscale Discussions">
      <div className="flex flex-col gap-1 text-xs">
        {items.map((m, i) => (
          <a
            key={i}
            href={m.link ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline truncate"
          >
            {m.title}
          </a>
        ))}
      </div>
    </Panel>
  );
}

function AprsWxStationsPanel({ stations }: { stations: AprsStation[] }) {
  return (
    <Panel title={`APRS Weather Stations (${stations.length})`}>
      <div className="grid grid-cols-2 gap-2">
        {stations.map((s) => {
          const wx = s.weather!;
          return (
            <div key={s.callsign} className="bg-gray-800 rounded p-2 text-xs">
              <CallsignLink callsign={s.callsign} className="font-bold text-cyan-300 hover:underline" />
              {wx.temp_f != null && (
                <div className="text-base font-bold mt-1">
                  {Math.round(wx.temp_f)}°F
                  <span className="text-[10px] text-gray-500 ml-1">/{fToC(wx.temp_f)}°C</span>
                </div>
              )}
              <div className="text-gray-400">
                {wx.wind_dir_deg != null ? `${formatWindDir(wx.wind_dir_deg)} ` : ""}
                {wx.wind_speed_mph != null ? `${wx.wind_speed_mph}mph` : ""}
              </div>
              {wx.humidity_pct != null && (
                <div className="text-gray-500">{wx.humidity_pct}% RH</div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── Generic UI bits ──────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3">
      <div className="flex justify-between items-baseline mb-2">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        {subtitle && <span className="text-[10px] text-gray-500 truncate ml-2">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800 rounded px-2 py-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-sm font-semibold text-gray-100">{children}</div>
    </div>
  );
}

// ── Map popup contents ────────────────────────────────────────────

function MetarPopup({ m }: { m: MetarObservation }) {
  return (
    <div className="text-xs">
      <div className="font-bold">{m.station_id} · {m.name}</div>
      <div className="text-gray-600">{m.distance_km} km away</div>
      {m.temp_f != null && <div>Temp: {Math.round(m.temp_f)}°F / {Math.round(m.temp_c!)}°C</div>}
      {m.wind_speed_mph != null && (
        <div>
          Wind: {formatWindDir(m.wind_dir_deg)} {m.wind_speed_mph} mph
          {m.wind_gust_mph ? ` G${m.wind_gust_mph}` : ""}
        </div>
      )}
      {m.humidity_pct != null && <div>Humidity: {m.humidity_pct}%</div>}
      {m.pressure_mbar != null && <div>Pressure: {m.pressure_mbar} mb</div>}
      {m.visibility_mi != null && <div>Vis: {m.visibility_mi} mi</div>}
      {m.text_description && <div className="italic mt-1">{m.text_description}</div>}
      <div className="text-gray-500 mt-1">{relTime(m.timestamp)}</div>
    </div>
  );
}

function AprsWxPopup({ s }: { s: AprsStation }) {
  const wx = s.weather!;
  return (
    <div className="text-xs">
      <CallsignLink callsign={s.callsign} className="font-bold hover:underline" />
      <div className="text-gray-600">APRS WX</div>
      {wx.temp_f != null && <div>Temp: {Math.round(wx.temp_f)}°F</div>}
      {wx.wind_speed_mph != null && (
        <div>
          Wind: {formatWindDir(wx.wind_dir_deg)} {wx.wind_speed_mph} mph
          {wx.wind_gust_mph ? ` G${wx.wind_gust_mph}` : ""}
        </div>
      )}
      {wx.humidity_pct != null && <div>Humidity: {wx.humidity_pct}%</div>}
      {wx.pressure_mbar != null && <div>Pressure: {wx.pressure_mbar} mb</div>}
      {wx.rain_24h_in != null && wx.rain_24h_in > 0 && (
        <div className="text-blue-600">Rain (24h): {wx.rain_24h_in.toFixed(2)}"</div>
      )}
      <div className="text-gray-500 mt-1">{relTime(s.last_heard)}</div>
    </div>
  );
}
