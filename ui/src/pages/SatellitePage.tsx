import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import * as sat from "satellite.js";
import {
  getSatellitePasses,
  getStationCenter,
  type SatelliteTleEntry,
  type SatelliteFrequencyInfo,
} from "../api/client";

/* ── Constants ────────────────────────────────────────────────────────── */

const TZ = "America/New_York";

const SAT_COLORS: Record<number, string> = {
  25544: "#22d3ee", // ISS
  48274: "#fb923c", // CSS
  25338: "#86efac", // NOAA-15
  28654: "#c084fc", // NOAA-18
  33591: "#86efac", // NOAA-19
  43013: "#f472b6", // NOAA-20
  43017: "#facc15", // AO-91
  27607: "#f87171", // SO-50
  7530: "#a78bfa",  // AO-7
  54684: "#38bdf8", // TEVEL-3
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/* ── Types ────────────────────────────────────────────────────────────── */

interface Pass {
  satellite: string;
  norad_id: number;
  aos: Date;
  los: Date;
  max_elevation: number;
  duration_minutes: number;
  aos_azimuth: number;
  los_azimuth: number;
  direction: string;
  frequencies: SatelliteFrequencyInfo[];
}

interface CurrentPosition {
  name: string;
  norad_id: number;
  latitude: number;
  longitude: number;
  altitude_km: number;
  velocity_kms: number;
  elevation: number;
  azimuth: number;
  in_range: boolean;
  frequencies: SatelliteFrequencyInfo[];
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function azimuthToCompass(deg: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
}

function formatDuration(mins: number): string {
  const m = Math.floor(mins);
  const s = Math.round((mins - m) * 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function elevationColor(maxEl: number): string {
  if (maxEl >= 45) return "text-green-400";
  if (maxEl >= 20) return "text-yellow-400";
  return "text-gray-400";
}

function elevationBgColor(maxEl: number): string {
  if (maxEl >= 45) return "bg-green-900/30 border-green-700/40";
  if (maxEl >= 20) return "bg-yellow-900/20 border-yellow-700/30";
  return "bg-gray-800/50 border-gray-700/40";
}

/** Compute look angle (elevation, azimuth) from observer to satellite. */
function lookAngle(
  obsLat: number, obsLng: number, obsAlt: number,
  satEci: sat.EciVec3<number>, gmst: number
): { elevation: number; azimuth: number } {
  const observerGd = {
    longitude: obsLng * DEG2RAD,
    latitude: obsLat * DEG2RAD,
    height: obsAlt / 1000, // km
  };
  const positionEcf = sat.eciToEcf(satEci, gmst);
  const lookAngles = sat.ecfToLookAngles(observerGd, positionEcf);
  return {
    elevation: lookAngles.elevation * RAD2DEG,
    azimuth: lookAngles.azimuth * RAD2DEG,
  };
}

/** Predict passes for a single satellite over the given time window. */
function predictPasses(
  tle: SatelliteTleEntry,
  stationLat: number,
  stationLng: number,
  hours: number,
  minElevation: number,
): Pass[] {
  const satrec = sat.twoline2satrec(tle.tle_line1, tle.tle_line2);
  const passes: Pass[] = [];

  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600_000);
  const stepMs = 30_000; // 30 seconds
  const fineStepMs = 5_000; // 5 seconds for refining AOS/LOS

  let inPass = false;
  let passStart: Date | null = null;
  let passMaxEl = 0;
  let passAosAz = 0;
  let passLosAz = 0;
  let prevEl = -90;

  for (let t = now.getTime(); t <= end.getTime(); t += stepMs) {
    const d = new Date(t);
    const pv = sat.propagate(satrec, d);
    if (!pv || !pv.position || typeof pv.position === "boolean") continue;

    const gmst = sat.gstime(d);
    const { elevation, azimuth } = lookAngle(
      stationLat, stationLng, 0,
      pv.position as sat.EciVec3<number>, gmst
    );

    if (!inPass && elevation > 0 && prevEl <= 0) {
      // Satellite just rose -- refine AOS
      inPass = true;
      passMaxEl = elevation;
      // Refine AOS by stepping back
      let aosTime = t;
      for (let ft = t - stepMs; ft < t; ft += fineStepMs) {
        const fd = new Date(ft);
        const fpv = sat.propagate(satrec, fd);
        if (!fpv || !fpv.position || typeof fpv.position === "boolean") continue;
        const fgmst = sat.gstime(fd);
        const fla = lookAngle(stationLat, stationLng, 0, fpv.position as sat.EciVec3<number>, fgmst);
        if (fla.elevation > 0) {
          aosTime = ft;
          break;
        }
      }
      passStart = new Date(aosTime);
      passAosAz = azimuth;
    } else if (inPass) {
      if (elevation > passMaxEl) {
        passMaxEl = elevation;
      }
      if (elevation <= 0 && prevEl > 0) {
        // Satellite just set -- refine LOS
        let losTime = t;
        for (let ft = t - stepMs; ft < t; ft += fineStepMs) {
          const fd = new Date(ft);
          const fpv = sat.propagate(satrec, fd);
          if (!fpv || !fpv.position || typeof fpv.position === "boolean") continue;
          const fgmst = sat.gstime(fd);
          const fla = lookAngle(stationLat, stationLng, 0, fpv.position as sat.EciVec3<number>, fgmst);
          if (fla.elevation <= 0) {
            losTime = ft;
            break;
          }
        }
        passLosAz = azimuth;
        const los = new Date(losTime);
        const durationMin = (los.getTime() - passStart!.getTime()) / 60_000;

        if (passMaxEl >= minElevation && durationMin > 0.5) {
          passes.push({
            satellite: tle.name,
            norad_id: tle.norad_id,
            aos: passStart!,
            los,
            max_elevation: Math.round(passMaxEl * 10) / 10,
            duration_minutes: Math.round(durationMin * 10) / 10,
            aos_azimuth: Math.round(passAosAz),
            los_azimuth: Math.round(passLosAz),
            direction: `${azimuthToCompass(passAosAz)}-${azimuthToCompass(passLosAz)}`,
            frequencies: tle.frequencies,
          });
        }

        inPass = false;
        passStart = null;
        passMaxEl = 0;
      }
    }

    prevEl = elevation;
  }

  return passes;
}

/** Compute current position for a satellite. */
function computeCurrentPosition(
  tle: SatelliteTleEntry,
  stationLat: number,
  stationLng: number,
): CurrentPosition | null {
  try {
    const satrec = sat.twoline2satrec(tle.tle_line1, tle.tle_line2);
    const now = new Date();
    const pv = sat.propagate(satrec, now);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;

    const gmst = sat.gstime(now);
    const geo = sat.eciToGeodetic(pv.position as sat.EciVec3<number>, gmst);
    const latitude = sat.degreesLat(geo.latitude);
    const longitude = sat.degreesLong(geo.longitude);
    if (!isFinite(latitude) || !isFinite(longitude)) return null;

    const vel = pv.velocity;
    const speed = !vel || typeof vel === "boolean"
      ? 0
      : Math.sqrt(
          (vel as sat.EciVec3<number>).x ** 2 +
          (vel as sat.EciVec3<number>).y ** 2 +
          (vel as sat.EciVec3<number>).z ** 2
        );

    const { elevation, azimuth } = lookAngle(
      stationLat, stationLng, 0,
      pv.position as sat.EciVec3<number>, gmst
    );

    return {
      name: tle.name,
      norad_id: tle.norad_id,
      latitude,
      longitude,
      altitude_km: geo.height,
      velocity_kms: speed,
      elevation: Math.round(elevation * 10) / 10,
      azimuth: Math.round(azimuth * 10) / 10,
      in_range: elevation > 0,
      frequencies: tle.frequencies,
    };
  } catch {
    return null;
  }
}

/* ── Components ───────────────────────────────────────────────────────── */

function PassQualityBadge({ maxEl }: { maxEl: number }) {
  if (maxEl >= 45) {
    return <span className="inline-block px-1.5 py-0.5 rounded text-xs font-semibold bg-green-800/60 text-green-300">Excellent</span>;
  }
  if (maxEl >= 20) {
    return <span className="inline-block px-1.5 py-0.5 rounded text-xs font-semibold bg-yellow-800/50 text-yellow-300">Good</span>;
  }
  return <span className="inline-block px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-700/60 text-gray-400">Low</span>;
}

function FrequencyPill({ freq }: { freq: SatelliteFrequencyInfo }) {
  const dirColor = freq.direction === "downlink" ? "text-green-300" : "text-blue-300";
  const dirIcon = freq.direction === "downlink" ? "Rx" : "Tx";
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-700/60 text-xs whitespace-nowrap">
      <span className={`font-semibold ${dirColor}`}>{dirIcon}</span>
      <span>{freq.mhz.toFixed(3)}</span>
      <span className="text-gray-500">{freq.mode}</span>
    </span>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

function SatellitePage() {
  const [hoursAhead, setHoursAhead] = useState(24);
  const [minElevation, setMinElevation] = useState(10);
  const [tick, setTick] = useState(0);

  // Refresh current positions every 10 seconds
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  const { data: passData, isLoading } = useQuery({
    queryKey: ["satellite-passes", hoursAhead, minElevation],
    queryFn: () => getSatellitePasses(hoursAhead, minElevation),
    staleTime: 6 * 3600_000, // TLEs cached for 6h
  });

  const { data: stationCenter } = useQuery({
    queryKey: ["station-center"],
    queryFn: getStationCenter,
    staleTime: Infinity,
  });

  const stationLat = passData?.station?.latitude ?? stationCenter?.latitude ?? 39.0;
  const stationLng = passData?.station?.longitude ?? stationCenter?.longitude ?? -77.0;

  // Compute passes from TLE data
  const passes = useMemo(() => {
    if (!passData?.satellites?.length) return [];
    const allPasses: Pass[] = [];
    for (const tle of passData.satellites) {
      const satPasses = predictPasses(tle, stationLat, stationLng, hoursAhead, minElevation);
      allPasses.push(...satPasses);
    }
    allPasses.sort((a, b) => a.aos.getTime() - b.aos.getTime());
    return allPasses;
  }, [passData, stationLat, stationLng, hoursAhead, minElevation]);

  // Compute current positions (updates every 10s via tick)
  const positions = useMemo(() => {
    if (!passData?.satellites?.length) return [];
    // Use tick to force recomputation
    void tick;
    const pos: CurrentPosition[] = [];
    for (const tle of passData.satellites) {
      const p = computeCurrentPosition(tle, stationLat, stationLng);
      if (p) pos.push(p);
    }
    // Sort: in-range first, then by elevation desc
    pos.sort((a, b) => {
      if (a.in_range !== b.in_range) return a.in_range ? -1 : 1;
      return b.elevation - a.elevation;
    });
    return pos;
  }, [passData, stationLat, stationLng, tick]);

  const nextPass = passes.length > 0
    ? passes.find((p) => p.los.getTime() > Date.now()) ?? null
    : null;

  const inRangeCount = positions.filter((p) => p.in_range).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Satellite Passes</h1>
          <p className="text-sm text-gray-400 mt-1">
            Pass predictions for {stationLat.toFixed(2)}, {stationLng.toFixed(2)}
            {inRangeCount > 0 && (
              <span className="ml-2 text-green-400 font-semibold">
                {inRangeCount} in range now
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            Hours ahead:
            <select
              value={hoursAhead}
              onChange={(e) => setHoursAhead(Number(e.target.value))}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-green-400"
            >
              {[6, 12, 24, 48, 72].map((h) => (
                <option key={h} value={h}>{h}h</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            Min elevation:
            <select
              value={minElevation}
              onChange={(e) => setMinElevation(Number(e.target.value))}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-green-400"
            >
              {[0, 5, 10, 15, 20, 30, 45].map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading && (
        <div className="text-center py-16 text-gray-400">Loading TLE data...</div>
      )}

      {!isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Main: upcoming passes */}
          <div className="lg:col-span-3">
            {/* Next pass highlight */}
            {nextPass && (
              <div className={`rounded-lg border p-4 mb-4 ${elevationBgColor(nextPass.max_elevation)}`}>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-lg font-bold">Next Pass</span>
                  <PassQualityBadge maxEl={nextPass.max_elevation} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-gray-400 block text-xs">Satellite</span>
                    <span className="font-semibold" style={{ color: SAT_COLORS[nextPass.norad_id] ?? "#fff" }}>
                      {nextPass.satellite}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 block text-xs">AOS</span>
                    <span className="font-mono">{formatTime(nextPass.aos)}</span>
                    <span className="text-gray-500 text-xs ml-1">{formatDate(nextPass.aos)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400 block text-xs">Max Elevation</span>
                    <span className={`font-bold text-lg ${elevationColor(nextPass.max_elevation)}`}>
                      {nextPass.max_elevation.toFixed(1)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400 block text-xs">Duration / Direction</span>
                    <span>{formatDuration(nextPass.duration_minutes)}</span>
                    <span className="text-gray-500 ml-1">{nextPass.direction}</span>
                  </div>
                </div>
                {nextPass.frequencies.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {nextPass.frequencies.map((f, i) => (
                      <FrequencyPill key={i} freq={f} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Pass table */}
            <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="font-semibold">
                  Upcoming Passes
                  <span className="text-gray-400 text-sm font-normal ml-2">
                    ({passes.length} passes in next {hoursAhead}h)
                  </span>
                </h2>
              </div>
              {passes.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No passes found with current filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                        <th className="text-left px-4 py-2">Satellite</th>
                        <th className="text-left px-3 py-2">Date</th>
                        <th className="text-left px-3 py-2">AOS</th>
                        <th className="text-left px-3 py-2">LOS</th>
                        <th className="text-right px-3 py-2">Max El</th>
                        <th className="text-right px-3 py-2">Duration</th>
                        <th className="text-center px-3 py-2">Direction</th>
                        <th className="text-left px-3 py-2">Frequencies</th>
                      </tr>
                    </thead>
                    <tbody>
                      {passes.map((p, i) => {
                        const isActive = p.aos.getTime() <= Date.now() && p.los.getTime() >= Date.now();
                        return (
                          <tr
                            key={`${p.norad_id}-${i}`}
                            className={`border-b border-gray-700/50 hover:bg-gray-700/30 ${
                              isActive ? "bg-green-900/20" : ""
                            }`}
                          >
                            <td className="px-4 py-2 whitespace-nowrap">
                              <span
                                className="inline-block w-2 h-2 rounded-full mr-2"
                                style={{ backgroundColor: SAT_COLORS[p.norad_id] ?? "#888" }}
                              />
                              <span className="font-medium">{p.satellite}</span>
                              {isActive && (
                                <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-xs font-bold bg-green-700/60 text-green-300 animate-pulse">
                                  LIVE
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-400 whitespace-nowrap font-mono text-xs">
                              {formatDate(p.aos)}
                            </td>
                            <td className="px-3 py-2 font-mono whitespace-nowrap">
                              {formatTime(p.aos)}
                            </td>
                            <td className="px-3 py-2 font-mono whitespace-nowrap">
                              {formatTime(p.los)}
                            </td>
                            <td className={`px-3 py-2 text-right font-bold ${elevationColor(p.max_elevation)}`}>
                              {p.max_elevation.toFixed(1)}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {formatDuration(p.duration_minutes)}
                            </td>
                            <td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">
                              {p.direction}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {p.frequencies.slice(0, 2).map((f, fi) => (
                                  <FrequencyPill key={fi} freq={f} />
                                ))}
                                {p.frequencies.length > 2 && (
                                  <span className="text-gray-500 text-xs">+{p.frequencies.length - 2}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Current positions */}
            <div className="bg-gray-800/50 rounded-lg border border-gray-700">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="font-semibold text-sm">Current Positions</h2>
              </div>
              <div className="divide-y divide-gray-700/50">
                {positions.map((p) => (
                  <div key={p.norad_id} className={`px-4 py-3 ${p.in_range ? "bg-green-900/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm flex items-center gap-1.5">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ backgroundColor: SAT_COLORS[p.norad_id] ?? "#888" }}
                        />
                        {p.name}
                      </span>
                      {p.in_range && (
                        <span className="text-xs font-bold text-green-400 bg-green-900/40 px-1.5 py-0.5 rounded">
                          IN RANGE
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 text-xs text-gray-400">
                      <div>Lat: {p.latitude.toFixed(2)}</div>
                      <div>Lon: {p.longitude.toFixed(2)}</div>
                      <div>Alt: {p.altitude_km.toFixed(0)} km</div>
                      <div>Spd: {(p.velocity_kms * 3600).toFixed(0)} km/h</div>
                      <div>El: <span className={p.elevation > 0 ? "text-green-400" : "text-gray-500"}>{p.elevation.toFixed(1)}</span></div>
                      <div>Az: {p.azimuth.toFixed(1)} ({azimuthToCompass(p.azimuth)})</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Frequency reference */}
            <div className="bg-gray-800/50 rounded-lg border border-gray-700">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="font-semibold text-sm">Satellite Frequencies</h2>
              </div>
              <div className="divide-y divide-gray-700/50">
                {(passData?.satellites ?? []).map((s) => (
                  <div key={s.norad_id} className="px-4 py-3">
                    <div className="font-medium text-sm mb-1.5 flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ backgroundColor: SAT_COLORS[s.norad_id] ?? "#888" }}
                      />
                      {s.name}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {s.frequencies.map((f, i) => (
                        <FrequencyPill key={i} freq={f} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Legend */}
            <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
              <h2 className="font-semibold text-sm mb-3">Pass Quality</h2>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-green-400 font-bold">45+</span>
                  <span className="text-gray-300">Excellent - overhead pass, strong signals</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-yellow-400 font-bold">20-45</span>
                  <span className="text-gray-300">Good - usable for most modes</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 font-bold">&lt;20</span>
                  <span className="text-gray-300">Low - may be marginal, obstructions likely</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SatellitePage;
