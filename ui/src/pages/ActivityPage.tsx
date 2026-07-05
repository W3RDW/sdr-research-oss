import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import api from "../api/client";

// ── Types ──────────────────────────────────────────────────────────

interface PotaSpot {
  callsign: string;
  reference: string | null;
  name: string | null;
  frequency_khz: number | null;
  mode: string | null;
  location: string | null;
  spotted_at: string | null;
  comments: string | null;
}

interface SotaSpot {
  callsign: string;
  reference: string | null;
  name: string | null;
  frequency_khz: number | null;
  mode: string | null;
  spotted_at: string | null;
  comments: string | null;
}

interface ContestEntry {
  title: string;
  dates: string | null;
  url: string;
}

interface ActivityFeedsResponse {
  fetched_at: string;
  pota: PotaSpot[];
  sota: SotaSpot[];
  contests: ContestEntry[];
}

async function getActivityFeeds(): Promise<ActivityFeedsResponse> {
  const { data } = await api.get("/stats/activity/feeds");
  return data;
}

// ── Helpers ────────────────────────────────────────────────────────

function formatMhz(khz: number | null): string {
  if (khz == null) return "—";
  return (khz / 1000).toFixed(3);
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ts = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z";
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

// ── Components ─────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700">
        <h2 className="font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export default function ActivityPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["activity-feeds"],
    queryFn: getActivityFeeds,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const pota = data?.pota ?? [];
  const sota = data?.sota ?? [];
  const contests = data?.contests ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">On-Air Activity</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Live POTA / SOTA spots and upcoming contests
          </p>
        </div>
        {data && (
          <div className="text-xs text-gray-500">
            updated {relTime(data.fetched_at)}
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
        <div className="space-y-6">
          <Section title={`POTA Activations (${pota.length})`}>
            {pota.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No POTA activations right now.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                      <th className="text-left px-4 py-2">Callsign</th>
                      <th className="text-left px-3 py-2">Reference</th>
                      <th className="text-left px-3 py-2">Name</th>
                      <th className="text-left px-3 py-2">Location</th>
                      <th className="text-right px-3 py-2">Freq (MHz)</th>
                      <th className="text-left px-3 py-2">Mode</th>
                      <th className="text-left px-3 py-2">Spotted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pota.map((s, i) => (
                      <tr
                        key={`${s.callsign}-${i}`}
                        className="border-b border-gray-700/50 hover:bg-gray-700/30"
                      >
                        <td className="px-4 py-2 whitespace-nowrap">
                          <Link
                            to={`/callsign/${s.callsign}`}
                            className="text-cyan-300 hover:underline font-mono"
                          >
                            {s.callsign}
                          </Link>
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {s.reference ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-gray-300">{s.name ?? "—"}</td>
                        <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                          {s.location ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-cyan-400 whitespace-nowrap">
                          {formatMhz(s.frequency_khz)}
                        </td>
                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                          {s.mode ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                          {relTime(s.spotted_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`SOTA Activations (${sota.length})`}>
            {sota.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No SOTA activations right now.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                      <th className="text-left px-4 py-2">Callsign</th>
                      <th className="text-left px-3 py-2">Reference</th>
                      <th className="text-left px-3 py-2">Name</th>
                      <th className="text-right px-3 py-2">Freq (MHz)</th>
                      <th className="text-left px-3 py-2">Mode</th>
                      <th className="text-left px-3 py-2">Spotted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sota.map((s, i) => (
                      <tr
                        key={`${s.callsign}-${i}`}
                        className="border-b border-gray-700/50 hover:bg-gray-700/30"
                      >
                        <td className="px-4 py-2 whitespace-nowrap">
                          <Link
                            to={`/callsign/${s.callsign}`}
                            className="text-cyan-300 hover:underline font-mono"
                          >
                            {s.callsign}
                          </Link>
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {s.reference ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-gray-300">{s.name ?? "—"}</td>
                        <td className="px-3 py-2 text-right font-mono text-cyan-400 whitespace-nowrap">
                          {formatMhz(s.frequency_khz)}
                        </td>
                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                          {s.mode ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                          {relTime(s.spotted_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`Contest Calendar (${contests.length})`}>
            {contests.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No contests right now.
              </div>
            ) : (
              <ul className="divide-y divide-gray-700/50">
                {contests.map((c, i) => (
                  <li key={i} className="px-4 py-2.5 text-sm">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                    >
                      {c.title}
                    </a>
                    {c.dates && (
                      <span className="text-gray-400 text-xs ml-2">{c.dates}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
