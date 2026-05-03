import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDateTime } from "../utils/time";
import { Link } from "react-router-dom";
import { searchText, SearchResult } from "../api/client";

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function parseNonNegativeNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseFrequencyInput(value: string): number | undefined {
  const parsed = parseNonNegativeNumber(value);
  if (parsed === undefined) return undefined;
  if (parsed > 0 && parsed < 1_000_000) {
    return parsed * 1_000_000;
  }
  return parsed;
}

function buildSearchExportUrl(params: {
  q: string;
  mode?: string;
  frequency_min?: number;
  frequency_max?: number;
  callsign?: string;
}): string {
  const p = new URLSearchParams({ q: params.q, format: "csv" });
  if (params.mode) p.set("mode", params.mode);
  if (params.frequency_min != null) p.set("frequency_min", String(params.frequency_min));
  if (params.frequency_max != null) p.set("frequency_max", String(params.frequency_max));
  if (params.callsign) p.set("callsign", params.callsign);
  return `/api/v1/search/text?${p.toString()}`;
}

function SearchPage() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [mode, setMode] = useState<string>("");
  const [frequencyMinInput, setFrequencyMinInput] = useState("");
  const [frequencyMaxInput, setFrequencyMaxInput] = useState("");
  const [callsign, setCallsign] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [transcriptFilter, setTranscriptFilter] = useState<"" | "yes" | "no">("");
  const [tagInput, setTagInput] = useState("");

  const frequencyMin = parseFrequencyInput(frequencyMinInput);
  const frequencyMax = parseFrequencyInput(frequencyMaxInput);
  const hasTranscript =
    transcriptFilter === "" ? undefined : transcriptFilter === "yes";

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "search",
      submittedQuery,
      mode,
      frequencyMinInput,
      frequencyMaxInput,
      callsign,
      dateFrom,
      dateTo,
      transcriptFilter,
      tagInput,
    ],
    queryFn: () =>
      searchText({
        q: submittedQuery,
        mode: mode || undefined,
        frequency_min: frequencyMin,
        frequency_max: frequencyMax,
        callsign: callsign.trim() || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        has_transcript: hasTranscript,
        tag: tagInput.trim() || undefined,
      }),
    enabled: submittedQuery.length > 0,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedQuery(query);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Search Transcripts</h1>

      <form onSubmit={handleSubmit} className="mb-6">
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search decoded text..."
            className="flex-1 bg-gray-800 border border-gray-600 rounded px-4 py-2"
          />
          <input
            type="number"
            min={0}
            value={frequencyMinInput}
            onChange={(e) => setFrequencyMinInput(e.target.value)}
            placeholder="Min Hz or MHz"
            className="w-32 bg-gray-800 border border-gray-600 rounded px-3 py-2"
          />
          <input
            type="number"
            min={0}
            value={frequencyMaxInput}
            onChange={(e) => setFrequencyMaxInput(e.target.value)}
            placeholder="Max Hz or MHz"
            className="w-32 bg-gray-800 border border-gray-600 rounded px-3 py-2"
          />
          <input
            type="text"
            value={callsign}
            onChange={(e) => setCallsign(e.target.value.toUpperCase())}
            placeholder="Callsign (e.g. N0CALL)"
            className="w-44 bg-gray-800 border border-gray-600 rounded px-3 py-2 uppercase"
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-3 py-2"
          >
            <option value="">All Modes</option>
            <option value="voice">Voice</option>
            <option value="cw">CW</option>
            <option value="aprs">APRS</option>
          </select>
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value.toLowerCase())}
            placeholder="Tag filter"
            className="w-32 bg-gray-800 border border-gray-600 rounded px-3 py-2"
          />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm"
            title="From date"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm"
            title="To date"
          />
          <select
            value={transcriptFilter}
            onChange={(e) => setTranscriptFilter(e.target.value as "" | "yes" | "no")}
            className="bg-gray-800 border border-gray-600 rounded px-3 py-2"
          >
            <option value="">Any transcript</option>
            <option value="yes">With transcript</option>
            <option value="no">No transcript</option>
          </select>
          <button
            type="submit"
            className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded font-medium"
          >
            Search
          </button>
          {submittedQuery && data && data.total > 0 && (
            <a
              href={buildSearchExportUrl({
                q: submittedQuery,
                mode: mode || undefined,
                frequency_min: parseFrequencyInput(frequencyMinInput),
                frequency_max: parseFrequencyInput(frequencyMaxInput),
                callsign: callsign.trim() || undefined,
              })}
              download={`search-${submittedQuery.slice(0, 20)}.csv`}
              className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded font-medium text-sm"
            >
              Export CSV
            </a>
          )}
        </div>
      </form>

      {error && (
        <div className="text-red-400 mb-4">Search failed: {String(error)}</div>
      )}

      {isLoading && <div className="text-center py-8">Searching...</div>}

      {data && (
        <div>
          <div className="text-sm text-gray-400 mb-4">
            Found {data.total} result{data.total !== 1 ? "s" : ""} for "{data.query}"
          </div>

          <div className="space-y-4">
            {data.items.map((result: SearchResult) => (
              <div
                key={result.id}
                className="bg-gray-800 rounded-lg p-4 hover:bg-gray-750"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <Link
                      to={`/player/${result.id}?q=${encodeURIComponent(submittedQuery)}`}
                      className="text-green-400 hover:text-green-300 font-medium"
                    >
                      {result.filename}
                    </Link>
                    <div className="flex gap-3 text-sm text-gray-400 mt-1">
                      <span
                        className={`inline-flex px-2 py-0.5 text-xs font-medium rounded ${
                          result.mode === "cw"
                            ? "bg-yellow-900 text-yellow-200"
                            : "bg-blue-900 text-blue-200"
                        }`}
                      >
                        {result.mode.toUpperCase()}
                      </span>
                      <span>
                        {formatFrequency(result.frequency_hz)}
                        {result.frequency_label && (
                          <span className="ml-1.5 text-cyan-400">{result.frequency_label}</span>
                        )}
                      </span>
                      {result.timestamp && (
                        <span>
                          {formatDateTime(result.timestamp)}
                        </span>
                      )}
                      {result.tags && result.tags.length > 0 && (
                        <span className="text-sky-300">
                          Tags: {result.tags.join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <Link
                    to={`/player/${result.id}?q=${encodeURIComponent(submittedQuery)}`}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    Play &rarr;
                  </Link>
                </div>
                <div
                  className="text-sm text-gray-300 bg-gray-900 rounded p-3 font-mono"
                  dangerouslySetInnerHTML={{ __html: result.headline }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="text-center py-8 text-gray-400">
          No results found for "{data.query}"
        </div>
      )}
    </div>
  );
}

export default SearchPage;
