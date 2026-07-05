import { useQuery } from "@tanstack/react-query";
import api from "../api/client";
import { formatDateTime } from "../utils/time";

// ── Types ──────────────────────────────────────────────────────────

interface BandDayNight {
  day?: string;
  night?: string;
}

interface BandConditions {
  a_index?: string;
  sunspots?: string;
  xray?: string;
  signal_noise?: string;
  geomag_field?: string;
  aurora?: string;
  muf?: string;
  bands: Record<string, BandDayNight>;
  vhf: Record<string, Record<string, string>>;
}

interface PropagationImagery {
  muf_map: string;
  fof2_map: string;
  sdo_304: string;
  sdo_hmi: string;
  drap: string;
}

interface PropagationResponse {
  solar_flux_index: number | null;
  k_index: number | null;
  k_index_forecast: number[];
  bz: number | null;
  bt: number | null;
  hf_conditions: Record<string, string>;
  band_conditions: BandConditions | null;
  imagery: PropagationImagery;
  fetched_at: string;
  cached: boolean;
}

async function getPropagation(): Promise<PropagationResponse> {
  const { data } = await api.get("/admin/propagation");
  return data;
}

// ── Helpers ────────────────────────────────────────────────────────

function ratingColor(rating: string | undefined): string {
  if (!rating) return "text-gray-500";
  const r = rating.toLowerCase();
  if (r === "good") return "text-green-400";
  if (r === "fair") return "text-yellow-400";
  if (r === "poor") return "text-red-400";
  return "text-gray-400";
}

function kChipClass(k: number): string {
  if (k >= 5) return "bg-red-900/50 text-red-300";
  if (k >= 3) return "bg-yellow-900/50 text-yellow-300";
  return "bg-green-900/50 text-green-300";
}

const IMAGERY: { key: keyof PropagationImagery; caption: string }[] = [
  { key: "muf_map", caption: "Maximum Usable Frequency (MUF)" },
  { key: "fof2_map", caption: "Critical Frequency (foF2)" },
  { key: "sdo_304", caption: "SDO AIA 304 (Solar Chromosphere)" },
  { key: "sdo_hmi", caption: "SDO HMI Intensitygram (Sunspots)" },
  { key: "drap", caption: "D-Region Absorption (DRAP)" },
];

// ── Components ─────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold text-gray-100">{value}</div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export default function PropagationPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["propagation"],
    queryFn: getPropagation,
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
  });

  const bc = data?.band_conditions ?? null;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Propagation</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Solar indices, HF band conditions, and space-weather imagery
          </p>
        </div>
        {data && (
          <div className="text-xs text-gray-500">
            updated {formatDateTime(data.fetched_at)}
            {data.cached && " (cached)"}
          </div>
        )}
      </div>

      {isLoading && (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      )}
      {error && (
        <div className="text-red-400 py-8">
          Failed to load: {String(error)}
        </div>
      )}

      {!isLoading && !error && data && (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
            <StatTile
              label="SFI"
              value={data.solar_flux_index != null ? String(data.solar_flux_index) : "—"}
            />
            <StatTile
              label="K-index"
              value={data.k_index != null ? String(data.k_index) : "—"}
            />
            <StatTile label="A-index" value={bc?.a_index ?? "—"} />
            <StatTile label="Sunspots" value={bc?.sunspots ?? "—"} />
            <StatTile label="X-ray" value={bc?.xray ?? "—"} />
            <StatTile label="MUF" value={bc?.muf ?? "—"} />
            <StatTile label="Geomag Field" value={bc?.geomag_field ?? "—"} />
            <StatTile label="Aurora" value={bc?.aurora ?? "—"} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Band conditions */}
            <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="font-semibold">HF Band Conditions</h2>
              </div>
              {bc ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                        <th className="text-left px-4 py-2">Band</th>
                        <th className="text-left px-3 py-2">Day</th>
                        <th className="text-left px-3 py-2">Night</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(bc.bands).map(([band, cond]) => (
                        <tr
                          key={band}
                          className="border-b border-gray-700/50 hover:bg-gray-700/30"
                        >
                          <td className="px-4 py-2 font-mono whitespace-nowrap">{band}</td>
                          <td className={`px-3 py-2 font-semibold ${ratingColor(cond.day)}`}>
                            {cond.day ?? "—"}
                          </td>
                          <td className={`px-3 py-2 font-semibold ${ratingColor(cond.night)}`}>
                            {cond.night ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 text-sm px-4">
                  Band conditions unavailable — hamqsl.com was unreachable.
                </div>
              )}
            </div>

            {/* K-index forecast */}
            <div className="bg-gray-800/50 rounded-lg border border-gray-700">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="font-semibold">K-index Forecast</h2>
              </div>
              <div className="p-4">
                {data.k_index_forecast.length === 0 ? (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    No forecast data available.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {data.k_index_forecast.slice(0, 8).map((k, i) => (
                      <span
                        key={i}
                        className={`px-2.5 py-1 rounded text-sm font-mono font-semibold ${kChipClass(k)}`}
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-3">
                  Next 3-hour periods. Green &lt;3, yellow 3–4, red ≥5 (storm).
                </p>
              </div>
            </div>
          </div>

          {/* Imagery */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {IMAGERY.map(({ key, caption }) => (
              <div key={key} className="bg-gray-800/50 rounded-lg border border-gray-700 p-3">
                <img
                  src={data.imagery[key]}
                  alt={caption}
                  loading="lazy"
                  className="w-full rounded"
                />
                <div className="text-xs text-gray-400 mt-2 text-center">{caption}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
