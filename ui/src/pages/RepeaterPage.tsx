import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listRepeaters, RepeaterEntry } from "../api/client";
import { CallsignLink } from "../components/CallsignLink";

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(4)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function RepeaterPage() {
  const [stateFilter, setStateFilter] = useState("");
  const [callsignFilter, setCallsignFilter] = useState("");
  const [digitalMode, setDigitalMode] = useState("");
  const [page, setPage] = useState(1);

  const DIGITAL_MODES = ["DMR", "D-Star", "APCO P-25", "System Fusion", "NXDN", "Tetra", "M17"];

  const { data, isLoading, error } = useQuery({
    queryKey: ["repeaters", stateFilter, callsignFilter, digitalMode, page],
    queryFn: () =>
      listRepeaters({
        state: stateFilter.trim() || undefined,
        callsign: callsignFilter.trim() || undefined,
        digital_only: digitalMode === "__any__" ? true : undefined,
        digital_mode: digitalMode && digitalMode !== "__any__" ? digitalMode : undefined,
        page,
        limit: 100,
      }),
    placeholderData: keepPreviousData,
  });

  if (error) {
    return (
      <div className="text-red-400">Failed to load repeaters: {String(error)}</div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Repeaters</h1>
        {data && (
          <span className="text-sm text-gray-400">{data.total} total</span>
        )}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">State</label>
            <input
              type="text"
              value={stateFilter}
              onChange={(e) => { setStateFilter(e.target.value.toUpperCase()); setPage(1); }}
              placeholder="MD"
              maxLength={4}
              className="w-20 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm uppercase"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Callsign</label>
            <input
              type="text"
              value={callsignFilter}
              onChange={(e) => { setCallsignFilter(e.target.value.toUpperCase()); setPage(1); }}
              placeholder="W3..."
              className="w-28 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm uppercase"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Digital Mode</label>
            <select
              value={digitalMode}
              onChange={(e) => { setDigitalMode(e.target.value); setPage(1); }}
              className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            >
              <option value="">All</option>
              <option value="__any__">Digital (any)</option>
              {DIGITAL_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => { setStateFilter(""); setCallsignFilter(""); setDigitalMode(""); setPage(1); }}
            className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
          >
            Clear
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-8">Loading...</div>
      ) : (
        <>
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Callsign</th>
                  <th className="px-4 py-3 text-left font-medium">Output</th>
                  <th className="px-4 py-3 text-left font-medium">Input</th>
                  <th className="px-4 py-3 text-left font-medium">PL</th>
                  <th className="px-4 py-3 text-left font-medium">Location</th>
                  <th className="px-4 py-3 text-left font-medium">State</th>
                  <th className="px-4 py-3 text-left font-medium">Digital</th>
                  <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Linked</th>
                  <th className="px-4 py-3 text-left font-medium">Recordings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {data?.items.map((r: RepeaterEntry) => (
                  <tr key={r.id} className="hover:bg-gray-750">
                    <td className="px-4 py-2 font-mono font-medium text-purple-300">
                      <CallsignLink callsign={r.callsign} className="hover:underline" />
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {formatFrequency(r.frequency_hz)}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-gray-400">
                      {r.input_hz ? formatFrequency(r.input_hz) : "—"}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-gray-400">
                      {r.pl_tone ? `${r.pl_tone.toFixed(1)}` : "—"}
                    </td>
                    <td className="px-4 py-2 text-gray-300">
                      {[r.location, r.county].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-gray-400">{r.state || "—"}</td>
                    <td className="px-4 py-2">
                      {r.digital_modes.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {r.digital_modes.map((m) => (
                            <span
                              key={m}
                              className="px-1.5 py-0.5 bg-indigo-900 text-indigo-200 text-xs rounded"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 hidden lg:table-cell text-xs text-gray-400 font-mono">
                      {r.linked_nodes ? (
                        <span title={r.linked_nodes}>{r.linked_nodes.replace(/:/g, " ")}</span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        to={`/?repeater=${r.callsign}`}
                        className="text-sky-400 hover:underline text-xs"
                      >
                        Heard on →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data && data.total > data.limit && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-gray-400">
                Showing {(page - 1) * data.limit + 1}–
                {Math.min(page * data.limit, data.total)} of {data.total}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 bg-gray-700 rounded disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page * data.limit >= data.total}
                  className="px-3 py-1 bg-gray-700 rounded disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default RepeaterPage;
