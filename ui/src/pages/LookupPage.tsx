import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { searchCallsign, CallsignSearchResult } from "../api/client";

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "active") return "text-green-400";
  if (s === "expired") return "text-red-400";
  return "text-gray-400";
}

export default function LookupPage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  const { data, isFetching, error } = useQuery({
    queryKey: ["callsign-search", query],
    queryFn: () => searchCallsign(query),
    enabled: query.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed) setQuery(trimmed);
  }

  const results: CallsignSearchResult[] = data?.results ?? [];

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Callsign Lookup</h1>
      <p className="text-sm text-gray-400 mb-5">
        Search by callsign (e.g. <span className="font-mono">K1ABC</span>) or operator name (e.g.{" "}
        <span className="font-mono">Robert White</span>). Data via FCC ULS.
      </p>

      <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Callsign or name…"
          className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-400"
          autoFocus
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded transition-colors"
        >
          Search
        </button>
      </form>

      {isFetching && (
        <div className="text-center py-10 text-gray-400 text-sm">Searching FCC ULS…</div>
      )}

      {error && (
        <div className="text-red-400 text-sm py-4">
          Lookup failed — FCC ULS may be unavailable. Try again shortly.
        </div>
      )}

      {!isFetching && data && results.length === 0 && (
        <div className="text-center py-10 text-gray-500 text-sm">
          No amateur radio licenses found for <span className="text-white font-mono">"{query}"</span>.
        </div>
      )}

      {!isFetching && results.length > 0 && (
        <>
          <div className="text-xs text-gray-500 mb-2">
            {data!.total} result{data!.total !== 1 ? "s" : ""} for{" "}
            <span className="text-gray-300 font-mono">"{query}"</span>
          </div>
          <div className="rounded-lg border border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">Callsign</th>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {results.map((r) => (
                  <tr key={r.callsign} className="hover:bg-gray-800 transition-colors">
                    <td className="px-4 py-3 font-mono font-semibold">
                      <Link
                        to={`/callsign/${r.callsign}`}
                        className="text-green-400 hover:underline"
                      >
                        {r.callsign}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-200">{r.name ?? "—"}</td>
                    <td className={`px-4 py-3 ${statusBadge(r.status)}`}>
                      {r.status || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                      {r.expired_date ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Click a callsign to see local activity. Data sourced from FCC ULS amateur radio license database.
          </p>
        </>
      )}
    </div>
  );
}
