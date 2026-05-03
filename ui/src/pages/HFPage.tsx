import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { browseFiles } from "../api/client";
import { formatDateTime } from "../utils/time";

function formatFrequency(hz: number | null): string {
  if (hz == null) return "—";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

const HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "All", value: 0 },
];

export default function HFPage() {
  const [hours, setHours] = useState(24);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const limit = 50;

  const now = new Date();
  const dateFrom =
    hours > 0
      ? new Date(now.getTime() - hours * 3_600_000).toISOString().slice(0, 19)
      : undefined;

  const { data, isLoading, error } = useQuery({
    queryKey: ["hfdl-messages", hours, page, search],
    queryFn: () =>
      browseFiles({
        mode: "hfdl",
        date_from: dateFrom,
        q: search.trim() || undefined,
        page,
        limit,
      }),
    staleTime: 30_000,
  });

  const messages = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">HF / HFDL</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Aviation HF Datalink decoded via RX888 MkII + dumphfdl
          </p>
        </div>
        {!isLoading && (
          <div className="text-sm text-gray-400">
            {total.toLocaleString()} frame{total !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search messages…"
          className="bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-400 w-56"
        />
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
      </div>

      {isLoading && (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      )}
      {error && (
        <div className="text-red-400 py-8">
          Failed to load: {String(error)}
        </div>
      )}

      {!isLoading && !error && messages.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <p className="text-lg mb-2">No HFDL frames found.</p>
          <p className="text-sm">
            Scale the <code className="font-mono bg-gray-800 px-1 rounded">hfdl-decoder</code>{" "}
            deployment to 1 replica (and <code className="font-mono bg-gray-800 px-1 rounded">openwebrxplus</code> to 0)
            to start collecting data.
          </p>
          <p className="text-xs text-gray-600 mt-2">
            kubectl scale deploy hfdl-decoder -n sdr-research --replicas=1
          </p>
        </div>
      )}

      {!isLoading && messages.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-800 text-gray-400 text-left">
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Time</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Frequency</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Label</th>
                  <th className="px-3 py-2 font-medium">Decoded Data</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((msg, i) => (
                  <tr
                    key={`${msg.id}-${i}`}
                    className="border-t border-gray-700 hover:bg-gray-800/40"
                  >
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap font-mono text-xs">
                      {formatDateTime(msg.timestamp)}
                    </td>
                    <td className="px-3 py-2 text-cyan-400 whitespace-nowrap font-mono text-xs">
                      {formatFrequency(msg.frequency_hz)}
                    </td>
                    <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">
                      {msg.frequency_label ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-gray-200 text-xs font-mono break-all max-w-xl">
                      {msg.transcript ? (
                        <HfdlMessageRow text={msg.transcript} />
                      ) : (
                        <span className="text-gray-600">—</span>
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
                Page {page} of {totalPages} ({total.toLocaleString()} frames)
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
    </div>
  );
}

function HfdlMessageRow({ text }: { text: string }) {
  const parts = text.split(" | ");
  return (
    <span>
      {parts.map((part, i) => {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) return <span key={i}>{part}{i < parts.length - 1 ? " | " : ""}</span>;
        const key = part.slice(0, colonIdx);
        const val = part.slice(colonIdx + 1);
        let keyColor = "text-gray-500";
        if (key === "GS") keyColor = "text-blue-400";
        else if (key === "FLT") keyColor = "text-yellow-400";
        else if (key === "REG") keyColor = "text-orange-400";
        else if (key === "MSG") keyColor = "text-green-300";
        else if (key === "AC") keyColor = "text-purple-400";
        return (
          <span key={i}>
            <span className={keyColor}>{key}</span>
            <span className="text-gray-600">:</span>
            <span className="text-gray-200">{val}</span>
            {i < parts.length - 1 && <span className="text-gray-600"> | </span>}
          </span>
        );
      })}
    </span>
  );
}
