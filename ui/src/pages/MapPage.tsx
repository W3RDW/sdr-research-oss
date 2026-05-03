import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, Polyline, Circle, Rectangle, Tooltip, useMap } from "react-leaflet";
import { listAllRepeaters, listAprsStations, listAprsTracks, getStationCenter, listVoiceCallsigns, listAircraft, listAisVessels, fetchSatellitePositions, browseFiles, getSpotMap, RepeaterEntry, AprsStation, AprsTrack, VoiceCallsign, AircraftEntry, VesselEntry, SatelliteData } from "../api/client";
import { CallsignLink } from "../components/CallsignLink";
import { formatDateTime } from "../utils/time";

function formatFrequency(hz: number): string {
  return `${(hz / 1_000_000).toFixed(4)} MHz`;
}

const DEFAULT_CENTER: [number, number] = [39.0, -77.0];
const DEFAULT_ZOOM = 9;
const RADIUS_OPTIONS = [25, 50, 100, 150, 200, 300];

const FREQ_TOLERANCE_HZ = 6000;

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

/** Map APRS symbol code to a display label + marker color */
function aprsSymbolInfo(packet: string): { label: string; color: string } {
  // Parse the symbol table char and symbol code from uncompressed APRS position
  // Format: !DDMM.mmN<table>DDDMM.mmW<code> or similar data-type prefix
  const m = packet.match(/[!=@/\\]\d{4}\.\d+[NS](.)(\d{5}\.\d+[EW])(.)/) ;
  if (!m) return { label: "", color: "#60a5fa" };
  const symbolCode = m[3];
  switch (symbolCode) {
    case ">": return { label: "car", color: "#f97316" };      // car/vehicle
    case "[": return { label: "person", color: "#a78bfa" };    // jogger/person
    case "-": return { label: "house", color: "#78716c" };     // house
    case "_": return { label: "WX", color: "#22d3ee" };        // weather station
    case "R": return { label: "repeater", color: "#22c55e" };  // repeater
    case "k": return { label: "truck", color: "#fb923c" };     // truck
    case "b": return { label: "bike", color: "#34d399" };      // bicycle
    case "Y": return { label: "yacht", color: "#3b82f6" };     // boat
    case "s": return { label: "boat", color: "#2563eb" };      // ship
    case "a": return { label: "ambulance", color: "#ef4444" }; // ambulance
    case "f": return { label: "fire", color: "#dc2626" };      // fire truck
    case "U": return { label: "bus", color: "#eab308" };       // bus
    default: return { label: symbolCode, color: "#60a5fa" };
  }
}

/** Compute Maidenhead grid square boundaries for 4-char grids visible in the current viewport */
function computeGridSquares(bounds: L.LatLngBounds): { label: string; bounds: [[number, number], [number, number]] }[] {
  const grids: { label: string; bounds: [[number, number], [number, number]] }[] = [];
  // 4-char Maidenhead: field (20x10 deg) then square (2x1 deg)
  const south = Math.max(bounds.getSouth(), -90);
  const north = Math.min(bounds.getNorth(), 90);
  const west = Math.max(bounds.getWest(), -180);
  const east = Math.min(bounds.getEast(), 180);

  // Snap to 2-degree lon and 1-degree lat boundaries
  const lonStart = Math.floor((west + 180) / 2) * 2 - 180;
  const latStart = Math.floor((south + 90) / 1) * 1 - 90;

  for (let lon = lonStart; lon < east; lon += 2) {
    for (let lat = latStart; lat < north; lat += 1) {
      // Compute 4-char Maidenhead
      const lonField = Math.floor((lon + 180) / 20);
      const latField = Math.floor((lat + 90) / 10);
      const lonSq = Math.floor(((lon + 180) % 20) / 2);
      const latSq = Math.floor(((lat + 90) % 10) / 1);
      if (lonField < 0 || lonField > 17 || latField < 0 || latField > 17) continue;
      if (lonSq < 0 || lonSq > 9 || latSq < 0 || latSq > 9) continue;
      const label =
        String.fromCharCode(65 + lonField) +
        String.fromCharCode(65 + latField) +
        String(lonSq) +
        String(latSq);
      grids.push({
        label,
        bounds: [[lat, lon], [lat + 1, lon + 2]],
      });
    }
  }
  return grids;
}

/** React-leaflet component that renders Maidenhead grid squares using useMap */
function GridSquareOverlay() {
  const map = useMap();
  const [bounds, setBounds] = useState(map.getBounds());

  // Subscribe to move/zoom events
  useEffect(() => {
    const update = () => setBounds(map.getBounds());
    map.on("moveend", update);
    map.on("zoomend", update);
    return () => {
      map.off("moveend", update);
      map.off("zoomend", update);
    };
  }, [map]);

  const zoom = map.getZoom();
  const grids = useMemo(() => computeGridSquares(bounds), [bounds]);
  const showLabels = zoom >= 7;

  // Limit rendering to avoid overwhelming the map at low zoom
  if (grids.length > 500) return null;

  return (
    <>
      {grids.map((g) => (
        <Rectangle
          key={g.label}
          bounds={g.bounds}
          pathOptions={{
            color: "#94a3b8",
            weight: 1,
            opacity: 0.4,
            fillOpacity: 0,
            dashArray: "4 4",
          }}
        >
          {showLabels && (
            <Tooltip
              permanent
              direction="center"
              className="grid-square-label"
            >
              <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 500, textShadow: "0 0 3px rgba(0,0,0,0.7)" }}>
                {g.label}
              </span>
            </Tooltip>
          )}
        </Rectangle>
      ))}
    </>
  );
}

function MapPage() {
  const [showCircle, setShowCircle] = useState(true);
  const [circleRadiusKm, setCircleRadiusKm] = useState(50);
  const [showRadar, setShowRadar] = useState(false);
  const [showVoiceCallsigns, setShowVoiceCallsigns] = useState(false);
  const [showAircraft, setShowAircraft] = useState(true);
  const [showSatellites, setShowSatellites] = useState(true);
  const [showVessels, setShowVessels] = useState(false);
  const [showGridSquares, setShowGridSquares] = useState(false);
  const [showHfContacts, setShowHfContacts] = useState(false);

  const { data: stationCenter, isLoading: centerLoading } = useQuery({
    queryKey: ["station-center"],
    queryFn: getStationCenter,
    staleTime: Infinity,
  });

  const { data: repeaters = [], isLoading: repLoading, error: repError } = useQuery({
    queryKey: ["repeaters-map"],
    queryFn: listAllRepeaters,
    staleTime: 5 * 60 * 1000,
  });

  const { data: aprsData, isLoading: aprsLoading } = useQuery({
    queryKey: ["aprs-stations-map"],
    queryFn: () => listAprsStations(24),
    staleTime: 2 * 60 * 1000,
  });

  const { data: tracksData } = useQuery({
    queryKey: ["aprs-tracks-map"],
    queryFn: () => listAprsTracks(24),
    staleTime: 5 * 60 * 1000,
  });

  const { data: voiceCallsignsData } = useQuery({
    queryKey: ["voice-callsigns-map"],
    queryFn: () => listVoiceCallsigns(72),
    staleTime: 5 * 60 * 1000,
    enabled: showVoiceCallsigns,
  });

  const { data: aircraftData } = useQuery({
    queryKey: ["aircraft-map"],
    queryFn: () => listAircraft(),
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: showAircraft,
  });

  const { data: satelliteData } = useQuery({
    queryKey: ["satellites-map"],
    queryFn: fetchSatellitePositions,
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: showSatellites,
  });

  const { data: vesselData = [] } = useQuery({
    queryKey: ["ais-vessels-map"],
    queryFn: listAisVessels,
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: showVessels,
  });

  // Recent recordings for repeater activity detection (last 24h)
  const { data: recentRecordings } = useQuery({
    queryKey: ["recent-recordings-map"],
    queryFn: () => {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return browseFiles({
        date_from: dayAgo.toISOString().slice(0, 19),
        limit: 500,
        mode: "voice",
      });
    },
    staleTime: 5 * 60 * 1000,
  });

  // Build set of active frequencies from recent recordings
  const activeFreqs = useMemo(() => {
    const freqs = new Set<number>();
    if (recentRecordings?.items) {
      for (const rec of recentRecordings.items) {
        if (rec.frequency_hz != null) {
          freqs.add(rec.frequency_hz);
        }
      }
    }
    return freqs;
  }, [recentRecordings]);

  // HF contact spots (last 6h)
  const { data: hfSpotData } = useQuery({
    queryKey: ["hf-spots-map"],
    queryFn: () => getSpotMap({ hours: 6, limit: 500 }),
    staleTime: 5 * 60 * 1000,
    enabled: showHfContacts,
  });

  const hfSpots = useMemo(() => {
    if (!hfSpotData?.spots) return [];
    return hfSpotData.spots.filter(
      (s) => s.tx_latitude != null && s.tx_longitude != null
    );
  }, [hfSpotData]);

  const { data: radarMeta } = useQuery({
    queryKey: ["rainviewer-meta"],
    queryFn: () => fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
    enabled: showRadar,
  });
  const radarFrames: { path: string }[] = radarMeta?.radar?.past ?? [];
  const latestFrame = radarFrames[radarFrames.length - 1];
  const radarTileUrl = radarMeta && latestFrame
    ? `${radarMeta.host}${latestFrame.path}/256/{z}/{x}/{y}/8/1_1.png`
    : null;

  const aprsTracks = (tracksData?.tracks ?? []) as AprsTrack[];
  const aprsStations = (aprsData?.stations ?? []).filter(
    (s) => s.latitude != null && s.longitude != null
  );
  const aircraft = (aircraftData?.aircraft ?? []).filter(
    (a) => a.lat != null && a.lon != null
  );
  const satellites = satelliteData ?? [];
  const vessels = vesselData.filter((v) => v.lat != null && v.lon != null);

  const digital = repeaters.filter((r) => r.digital_modes.length > 0);
  const analog = repeaters.filter((r) => r.digital_modes.length === 0);

  /** Check if a repeater frequency has been heard in the last 24h */
  const isRepeaterActive = useMemo(() => {
    return (repeaterHz: number): boolean => {
      for (const recHz of activeFreqs) {
        if (Math.abs(recHz - repeaterHz) <= FREQ_TOLERANCE_HZ) return true;
      }
      return false;
    };
  }, [activeFreqs]);

  const isLoading = repLoading || aprsLoading || centerLoading;

  const center: [number, number] = stationCenter
    ? [stationCenter.latitude, stationCenter.longitude]
    : DEFAULT_CENTER;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Map</h1>
        <div className="flex items-center gap-4">
          {stationCenter && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCircle}
                  onChange={(e) => setShowCircle(e.target.checked)}
                  className="accent-yellow-400"
                />
                Range circle
              </label>
              {showCircle && (
                <select
                  value={circleRadiusKm}
                  onChange={(e) => setCircleRadiusKm(Number(e.target.value))}
                  className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-sm text-white focus:outline-none focus:border-green-400"
                >
                  {RADIUS_OPTIONS.map((r) => (
                    <option key={r} value={r}>{r} km</option>
                  ))}
                </select>
              )}
            </div>
          )}
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showRadar}
              onChange={(e) => setShowRadar(e.target.checked)}
              className="accent-sky-400"
            />
            Radar overlay
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showVoiceCallsigns}
              onChange={(e) => setShowVoiceCallsigns(e.target.checked)}
              className="accent-purple-400"
            />
            Voice callsigns
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showAircraft}
              onChange={(e) => setShowAircraft(e.target.checked)}
              className="accent-amber-400"
            />
            Aircraft
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showSatellites}
              onChange={(e) => setShowSatellites(e.target.checked)}
              className="accent-green-400"
            />
            Satellites
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showVessels}
              onChange={(e) => setShowVessels(e.target.checked)}
              className="accent-blue-400"
            />
            AIS Vessels
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showGridSquares}
              onChange={(e) => setShowGridSquares(e.target.checked)}
              className="accent-slate-400"
            />
            Grid Squares
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-400">
            <input
              type="checkbox"
              checked={showHfContacts}
              onChange={(e) => setShowHfContacts(e.target.checked)}
              className="accent-red-400"
            />
            HF Contacts
          </label>
          {!isLoading && (
            <div className="text-sm text-gray-400">
              {repeaters.length} repeaters · {aprsStations.length} APRS
              {showVoiceCallsigns && voiceCallsignsData ? ` · ${voiceCallsignsData.stations.length} voice` : ""}
              {showAircraft && aircraftData ? ` · ${aircraft.length}/${aircraftData.total_raw ?? aircraftData.total} aircraft` : ""}
              {showSatellites && satellites.length > 0 ? ` · ${satellites.length} sat` : ""}
              {showVessels ? ` · ${vessels.length} AIS` : ""}
              {showHfContacts && hfSpots.length > 0 ? ` · ${hfSpots.length} HF` : ""}
            </div>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      )}
      {repError && (
        <div className="text-red-400 py-8">Failed to load: {String(repError)}</div>
      )}

      {!isLoading && !repError && (
        <>
          <div className="flex flex-wrap gap-4 mb-3 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-green-400 opacity-90" />
              Active repeater (24h)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-gray-500 opacity-60" />
              Inactive repeater
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-orange-400 opacity-80" />
              Digital repeater
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-blue-400 opacity-80" />
              APRS station (24h)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-8 h-0.5 bg-blue-300 opacity-60" />
              APRS track
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-cyan-400 opacity-80" />
              WX station (24h)
            </span>
            {showRadar && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-green-400 opacity-60" />
                Radar
              </span>
            )}
            {showVoiceCallsigns && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-purple-400 opacity-80" />
                Voice callsign (72h)
              </span>
            )}
            {showAircraft && (
              <span className="flex items-center gap-1">
                <span>✈️</span>
                Aircraft (ADS-B, with position)
              </span>
            )}
            {showSatellites && (
              <span className="flex items-center gap-1">
                <span>🛰️</span>
                Satellite (live, 30s)
              </span>
            )}
            {showVessels && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full bg-blue-600 opacity-80" />
                AIS vessel (60s)
              </span>
            )}
            {showGridSquares && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-6 h-4 border border-dashed border-slate-400 opacity-50" />
                Grid squares
              </span>
            )}
            {showHfContacts && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-8 h-0.5 bg-gradient-to-r from-red-500 via-yellow-400 to-blue-500 opacity-70" />
                HF contacts (6h)
              </span>
            )}
            {showCircle && stationCenter && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-8 h-0.5 border-t-2 border-dashed border-yellow-400 opacity-70" />
                Station range ({circleRadiusKm} km)
              </span>
            )}
          </div>

          <div className="rounded-lg overflow-hidden border border-gray-700" style={{ height: "calc(100vh - 11rem)", minHeight: "500px" }}>
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
              {showRadar && radarTileUrl && (
                <TileLayer
                  url={radarTileUrl}
                  opacity={0.4}
                  attribution='Radar &copy; <a href="https://www.rainviewer.com">RainViewer</a>'
                />
              )}
              {showCircle && stationCenter && (
                <Circle
                  center={center}
                  radius={circleRadiusKm * 1000}
                  pathOptions={{
                    color: "#facc15",
                    fillColor: "#facc15",
                    fillOpacity: 0.04,
                    weight: 2,
                    dashArray: "6 6",
                    opacity: 0.7,
                  }}
                />
              )}
              {analog.map((r) => {
                const active = isRepeaterActive(r.frequency_hz);
                return (
                  <RepeaterMarker
                    key={r.id}
                    r={r}
                    color={active ? "#4ade80" : "#6b7280"}
                    active={active}
                  />
                );
              })}
              {digital.map((r) => {
                const active = isRepeaterActive(r.frequency_hz);
                return (
                  <RepeaterMarker
                    key={r.id}
                    r={r}
                    color={active ? "#fb923c" : "#6b7280"}
                    active={active}
                  />
                );
              })}
              {aprsTracks.map((track) => (
                <Polyline
                  key={`track-${track.callsign}`}
                  positions={track.positions.map((p) => [p.lat, p.lon])}
                  pathOptions={{ color: "#93c5fd", weight: 2, opacity: 0.6 }}
                />
              ))}
              {aprsStations.map((s) => (
                <AprsMarker key={s.callsign} s={s} symbolInfo={aprsSymbolInfo(s.packet)} />
              ))}
              {showVoiceCallsigns && (voiceCallsignsData?.stations ?? []).map((s) => (
                <VoiceCallsignMarker key={s.callsign} s={s} />
              ))}
              {showAircraft && aircraft.map((a) => (
                <AircraftMarker key={a.hex} a={a} />
              ))}
              {showSatellites && satellites.flatMap((s) =>
                s.groundTrack.map((seg, i) => (
                  <Polyline
                    key={`sat-track-${s.id}-${i}`}
                    positions={seg}
                    pathOptions={{ color: s.color, weight: 1.5, opacity: 0.5, dashArray: "6 5" }}
                  />
                ))
              )}
              {showSatellites && satellites.map((s) => (
                <SatelliteMarker key={s.id} sat={s} />
              ))}
              {showVessels && vessels.map((v) => (
                <VesselMarker key={v.mmsi} v={v} />
              ))}
              {showGridSquares && <GridSquareOverlay />}
              {showHfContacts && stationCenter && hfSpots.map((spot, i) => {
                const color = BAND_COLORS[spot.band ?? ""] || "#888";
                return (
                  <Polyline
                    key={`hf-${spot.callsign}-${spot.band}-${i}`}
                    positions={[
                      [stationCenter.latitude, stationCenter.longitude],
                      [spot.tx_latitude!, spot.tx_longitude!],
                    ]}
                    pathOptions={{ color, weight: 1.5, opacity: 0.5 }}
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
              {showHfContacts && hfSpots.map((spot, i) => {
                const color = BAND_COLORS[spot.band ?? ""] || "#888";
                return (
                  <CircleMarker
                    key={`hf-dot-${spot.callsign}-${spot.band}-${i}`}
                    center={[spot.tx_latitude!, spot.tx_longitude!]}
                    radius={4}
                    pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1 }}
                  >
                    <Popup>
                      <div className="text-xs">
                        {spot.callsign ? <CallsignLink callsign={spot.callsign} className="font-bold text-blue-400 hover:underline" /> : <strong>Unknown</strong>}<br />
                        {spot.grid} | {spot.band} {spot.mode?.toUpperCase()}<br />
                        SNR: {spot.snr_db} dB{spot.distance_km != null ? ` | ${spot.distance_km.toLocaleString()} km` : ""}
                      </div>
                    </Popup>
                  </CircleMarker>
                );
              })}
            </MapContainer>
          </div>
        </>
      )}
    </div>
  );
}

function RepeaterMarker({ r, color, active }: { r: RepeaterEntry; color: string; active: boolean }) {
  if (r.latitude == null || r.longitude == null) return null;
  return (
    <CircleMarker
      center={[r.latitude, r.longitude]}
      radius={active ? 7 : 5}
      pathOptions={{
        color,
        fillColor: color,
        fillOpacity: active ? 0.9 : 0.4,
        weight: active ? 2 : 1,
      }}
    >
      <Popup>
        <div className="text-sm">
          <div className="flex items-center gap-1.5">
            <CallsignLink callsign={r.callsign} className="font-bold hover:underline" />
            {active && (
              <span className="text-xs font-semibold text-green-600">ACTIVE</span>
            )}
          </div>
          <div>{formatFrequency(r.frequency_hz)}</div>
          {r.pl_tone && <div>PL {r.pl_tone.toFixed(1)} Hz</div>}
          {r.location && (
            <div>
              {r.location}
              {r.state ? `, ${r.state}` : ""}
            </div>
          )}
          {r.digital_modes.length > 0 && (
            <div className="mt-1">{r.digital_modes.join(", ")}</div>
          )}
          {r.linked_nodes && (
            <div className="text-gray-600 text-xs mt-1">{r.linked_nodes}</div>
          )}
          <div className="mt-1.5 flex gap-2">
            <a href={`/browse?repeater=${r.callsign}`} className="text-xs text-blue-600 hover:underline">Recordings</a>
            <a href={`/frequency/${r.frequency_hz}`} className="text-xs text-blue-600 hover:underline">Frequency</a>
          </div>
        </div>
      </Popup>
    </CircleMarker>
  );
}

function formatWindDir(deg: number | null): string {
  if (deg == null) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

/** Map APRS symbol labels to visual shapes for the marker */
const APRS_SYMBOL_SHAPES: Record<string, { emoji: string }> = {
  car: { emoji: "\u{1F697}" },
  person: { emoji: "\u{1F6B6}" },
  house: { emoji: "\u{1F3E0}" },
  WX: { emoji: "\u{26C5}" },
  repeater: { emoji: "\u{1F4E1}" },
  truck: { emoji: "\u{1F69A}" },
  bike: { emoji: "\u{1F6B2}" },
  yacht: { emoji: "\u26F5" },
  boat: { emoji: "\u{1F6A2}" },
  ambulance: { emoji: "\u{1F691}" },
  fire: { emoji: "\u{1F692}" },
  bus: { emoji: "\u{1F68C}" },
};

function AprsMarker({ s, symbolInfo }: { s: AprsStation; symbolInfo: { label: string; color: string } }) {
  if (s.latitude == null || s.longitude == null) return null;
  const isWx = s.is_weather === true;
  const color = isWx ? "#22d3ee" : symbolInfo.color;
  const wx = s.weather;
  const symbolShape = APRS_SYMBOL_SHAPES[symbolInfo.label];

  // Use a divIcon with emoji for recognized symbols, CircleMarker for others
  if (symbolShape && !isWx) {
    const icon = L.divIcon({
      html: `<div style="font-size:18px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8));">${symbolShape.emoji}</div>`,
      className: "",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -12],
    });
    return (
      <Marker position={[s.latitude, s.longitude]} icon={icon}>
        <Popup>
          <AprsPopupContent s={s} isWx={isWx} wx={wx} symbolLabel={symbolInfo.label} />
        </Popup>
      </Marker>
    );
  }

  return (
    <CircleMarker
      center={[s.latitude, s.longitude]}
      radius={7}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1.5 }}
    >
      <Popup>
        <AprsPopupContent s={s} isWx={isWx} wx={wx} symbolLabel={symbolInfo.label} />
      </Popup>
    </CircleMarker>
  );
}

function AprsPopupContent({ s, isWx, wx, symbolLabel }: {
  s: AprsStation;
  isWx: boolean;
  wx: AprsStation["weather"];
  symbolLabel: string;
}) {
  return (
    <div className="text-sm">
      <div className="flex items-center gap-1">
        <CallsignLink callsign={s.callsign} className="font-bold hover:underline" />
        {isWx && <span className="text-xs text-cyan-600 font-semibold">WX</span>}
        {symbolLabel && !isWx && (
          <span className="text-xs text-gray-500">[{symbolLabel}]</span>
        )}
      </div>
      {s.frequency_hz && <div>{formatFrequency(s.frequency_hz)}</div>}
      <div className="text-gray-600 text-xs">
        {s.latitude!.toFixed(4)}, {s.longitude!.toFixed(4)}
      </div>
      {isWx && wx ? (
        <div className="mt-1 space-y-0.5">
          {wx.temp_f != null && <div>Temp: {wx.temp_f.toFixed(1)} F</div>}
          {(wx.wind_speed_mph != null || wx.wind_dir_deg != null) && (
            <div>
              Wind:{" "}
              {wx.wind_dir_deg != null ? `${formatWindDir(wx.wind_dir_deg)} (${wx.wind_dir_deg}) ` : ""}
              {wx.wind_speed_mph != null ? `${wx.wind_speed_mph} mph` : ""}
              {wx.wind_gust_mph != null ? ` gusts ${wx.wind_gust_mph} mph` : ""}
            </div>
          )}
          {wx.humidity_pct != null && <div>Humidity: {wx.humidity_pct}%</div>}
          {wx.pressure_mbar != null && <div>Pressure: {wx.pressure_mbar.toFixed(1)} mbar</div>}
          {wx.rain_1h_in != null && wx.rain_1h_in > 0 && <div>Rain (1h): {wx.rain_1h_in.toFixed(2)} in</div>}
          {wx.rain_24h_in != null && wx.rain_24h_in > 0 && <div>Rain (24h): {wx.rain_24h_in.toFixed(2)} in</div>}
        </div>
      ) : (
        <>
          {s.speed_kt != null && (
            <div>{s.speed_kt} kt {s.course != null ? `@ ${s.course}` : ""}</div>
          )}
          {s.altitude_ft != null && <div>{s.altitude_ft} ft</div>}
          {s.comment && <div className="mt-1 text-xs">{s.comment}</div>}
        </>
      )}
      {s.last_heard && (
        <div className="text-gray-500 text-xs mt-1">
          {formatDateTime(s.last_heard)}
        </div>
      )}
      <div className="mt-1">
        <a href={`/callsign/${s.callsign}`} className="text-xs text-blue-600 hover:underline">Activity</a>
        {" · "}
        <a href={`/browse?callsign=${s.callsign}`} className="text-xs text-blue-600 hover:underline">Recordings</a>
      </div>
    </div>
  );
}

function AircraftMarker({ a }: { a: AircraftEntry }) {
  if (a.lat == null || a.lon == null) return null;
  const label = a.flight?.trim() || a.hex.toUpperCase();
  const alt = typeof a.alt_baro === "number" ? `${a.alt_baro.toLocaleString()} ft` : a.alt_baro ?? "—";
  const trackDeg = a.track ?? 0;
  const icon = L.divIcon({
    html: `<div style="font-size:22px;line-height:1;transform:rotate(${trackDeg}deg);filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));">✈️</div>`,
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14],
  });
  return (
    <Marker position={[a.lat, a.lon]} icon={icon}>
      <Popup>
        <div className="text-sm">
          <div className="font-bold">{label}</div>
          {a.flight?.trim() && a.flight.trim() !== a.hex.toUpperCase() && (
            <div className="text-gray-500 text-xs">{a.hex.toUpperCase()}</div>
          )}
          <div>Alt: {alt}</div>
          {a.gs != null && (
            <div>Speed: {Math.round(a.gs)} kt{a.track != null ? ` @ ${Math.round(a.track)}°` : ""}</div>
          )}
          {a.squawk && <div>Squawk: {a.squawk}</div>}
          {a.category && <div className="text-gray-500 text-xs">{a.category}</div>}
        </div>
      </Popup>
    </Marker>
  );
}

function SatelliteMarker({ sat }: { sat: SatelliteData }) {
  const speedKt = Math.round(sat.velocity / 1.852);
  const icon = L.divIcon({
    html: `<div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;">
      <div style="position:absolute;inset:0;border-radius:50%;background:${sat.color};opacity:0.2;"></div>
      <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${sat.color};opacity:0.8;"></div>
      <div style="font-size:16px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.9));">🛰️</div>
    </div>`,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -15],
  });
  return (
    <Marker position={[sat.latitude, sat.longitude]} icon={icon}>
      <Popup>
        <div className="text-sm">
          <div className="font-bold flex items-center gap-1.5">
            <span style={{ color: sat.color }}>●</span>
            {sat.name}
          </div>
          <div>Alt: {sat.altitude.toFixed(1)} km</div>
          <div>Speed: {speedKt.toLocaleString()} kt</div>
          <div className="text-gray-500 text-xs mt-1">
            {sat.latitude.toFixed(4)}, {sat.longitude.toFixed(4)}
          </div>
        </div>
      </Popup>
    </Marker>
  );
}

function VesselMarker({ v }: { v: VesselEntry }) {
  if (v.lat == null || v.lon == null) return null;
  const label = v.name?.trim() || String(v.mmsi);
  const color = "#2563eb";
  return (
    <CircleMarker
      center={[v.lat, v.lon]}
      radius={5}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1.5 }}
    >
      <Popup>
        <div className="text-sm">
          <div className="font-bold">{label}</div>
          <div className="text-gray-500 text-xs">MMSI: {v.mmsi}</div>
          {v.callsign && <div>Call: {v.callsign}</div>}
          {v.speed != null && (
            <div>Speed: {v.speed.toFixed(1)} kt{v.course != null ? ` @ ${Math.round(v.course)}°` : ""}</div>
          )}
        </div>
      </Popup>
    </CircleMarker>
  );
}

function VoiceCallsignMarker({ s }: { s: VoiceCallsign }) {
  const color = "#c084fc";
  return (
    <CircleMarker
      center={[s.latitude, s.longitude]}
      radius={6}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.75, weight: 1.5 }}
    >
      <Popup>
        <div className="text-sm">
          <CallsignLink callsign={s.callsign} className="font-bold hover:underline" />
          {s.name && <div>{s.name}</div>}
          {(s.qth_city || s.qth_state) && (
            <div className="text-gray-600 text-xs">
              {[s.qth_city, s.qth_state].filter(Boolean).join(", ")}
            </div>
          )}
          {s.grid && <div className="text-gray-600 text-xs">Grid: {s.grid}</div>}
          {s.last_heard && (
            <div className="text-gray-500 text-xs mt-1">Heard: {formatDateTime(s.last_heard)}</div>
          )}
          <div className="text-xs text-purple-600 mt-1">Voice recording</div>
        </div>
      </Popup>
    </CircleMarker>
  );
}

export default MapPage;
