import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCallsignActivity, getCallsignInfo } from "../api/client";
import { formatDateTime, formatDate } from "../utils/time";
import { FrequencyLink } from "../components/FrequencyLink";

function formatFrequency(hz: number | null): string {
  if (!hz) return "—";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatDuration(s: number | null): string {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatAirtime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function CallsignPage() {
  const { callsign } = useParams<{ callsign: string }>();
  const cs = (callsign ?? "").toUpperCase();
  // Strip SSID suffix (e.g. W1AW-8 → W1AW) for external lookups
  const baseCs = cs.replace(/-\w+$/, "");

  const { data: info, isLoading: infoLoading } = useQuery({
    queryKey: ["callsign-info", cs],
    queryFn: () => getCallsignInfo(cs),
    enabled: !!cs,
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["callsign-activity", cs],
    queryFn: () => getCallsignActivity(cs, 1, 100),
    enabled: !!cs,
    staleTime: 2 * 60 * 1000,
  });

  return (
    <div>
      <div className="mb-6">
        <Link to="/" className="text-gray-400 hover:text-white text-sm mb-2 inline-block">
          &larr; Back to recordings
        </Link>
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-2xl font-bold font-mono">{cs}</h1>
          <a
            href={`https://www.qrz.com/db/${baseCs}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-400 hover:underline"
          >
            QRZ.com ↗
          </a>
          <a
            href={`https://hamdb.org/${baseCs.toLowerCase()}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-400 hover:underline"
          >
            HamDB ↗
          </a>
        </div>
      </div>

      {/* Operator info card */}
      {!infoLoading && info && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {/* Stats */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Activity</h2>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-400">Recordings</dt>
                <dd className="font-medium">{info.total_recordings.toLocaleString()}</dd>
              </div>
              {info.first_heard && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">First heard</dt>
                  <dd>{formatDate(info.first_heard)}</dd>
                </div>
              )}
              {info.last_heard && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Last heard</dt>
                  <dd>{formatDate(info.last_heard)}</dd>
                </div>
              )}
              {info.total_airtime_seconds > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Total air time</dt>
                  <dd className="font-medium text-green-300">
                    {formatAirtime(info.total_airtime_seconds)}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Operator info */}
          {info.operator ? (
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-3">Operator</h2>
              <dl className="space-y-1.5 text-sm">
                {info.operator.name && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Name</dt>
                    <dd className="font-medium">{info.operator.name}</dd>
                  </div>
                )}
                {(info.operator.qth_city || info.operator.qth_state) && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">QTH</dt>
                    <dd>
                      {[info.operator.qth_city, info.operator.qth_state]
                        .filter(Boolean)
                        .join(", ")}
                    </dd>
                  </div>
                )}
                {info.operator.license_class && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">License</dt>
                    <dd>
                      {{
                        T: "Technician",
                        G: "General",
                        A: "Advanced",
                        E: "Extra",
                      }[info.operator.license_class] ?? info.operator.license_class}
                    </dd>
                  </div>
                )}
                {info.operator.grid && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Grid</dt>
                    <dd className="font-mono">{info.operator.grid}</dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-center">
              <p className="text-sm text-gray-500 text-center">
                No operator info cached.
                <br />
                <span className="text-xs">
                  Operator data is fetched when recordings are indexed.
                </span>
              </p>
            </div>
          )}
        </div>
      )}

      {isLoading && <div className="text-center py-8 text-gray-400">Loading…</div>}
      {error && <div className="text-red-400">Failed to load: {String(error)}</div>}

      {data && data.items.length === 0 && (
        <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
          No recordings found mentioning <span className="font-mono">{cs}</span>.
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400 text-xs uppercase tracking-wide">
                <th className="text-left px-4 py-3">Time</th>
                <th className="text-left px-4 py-3">Mode</th>
                <th className="text-left px-4 py-3">Frequency</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Duration</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Transcript</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {data.items.map((rec) => (
                <tr
                  key={rec.id}
                  className="hover:bg-gray-750 transition-colors cursor-pointer"
                  onClick={() => (window.location.href = `/player/${rec.id}`)}
                >
                  <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                    {rec.timestamp
                      ? formatDateTime(rec.timestamp)
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-1.5 py-0.5 text-xs rounded ${
                        rec.mode === "cw"
                          ? "bg-yellow-900 text-yellow-200"
                          : rec.mode === "aprs"
                          ? "bg-green-900 text-green-200"
                          : "bg-blue-900 text-blue-200"
                      }`}
                    >
                      {rec.mode.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-300">
                    {rec.frequency_hz ? (
                      <FrequencyLink hz={rec.frequency_hz} label={rec.frequency_label ?? formatFrequency(rec.frequency_hz)} />
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-400 hidden sm:table-cell">
                    {formatDuration(rec.duration_seconds)}
                  </td>
                  <td className="px-4 py-3 text-gray-400 hidden md:table-cell max-w-xs truncate">
                    {(() => {
                      const s = rec.transcript_status ?? (rec.has_transcript ? "yes" : "no");
                      return s === "yes" ? (
                        <span className="text-gray-300">{rec.transcript?.slice(0, 80)}</span>
                      ) : s === "pending" ? (
                        <span className="italic text-yellow-600">pending</span>
                      ) : (
                        <span className="italic text-gray-600">no transcript</span>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default CallsignPage;
