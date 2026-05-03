import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import {
  browseFiles,
  deleteFile,
  bulkDeleteFiles,
  bulkDeleteFilteredFiles,
  listTags,
  searchText,
  Recording,
  SearchResult,
  BrowseParams,
} from "../api/client";
import { formatDateTime } from "../utils/time";
import { CallsignLink } from "../components/CallsignLink";
import { TagLink } from "../components/TagLink";
import {
  FREQUENCY_GROUP_ORDER,
  getFrequencyGroupLabel,
  getFrequencyGroupTheme,
} from "../utils/frequencyGroups";

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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

const PRESETS_KEY = "sdr-browse-presets";

interface FilterPreset {
  name: string;
  mode: string;
  frequencyMinInput: string;
  frequencyMaxInput: string;
  transcriptQuery: string;
  callsignQuery: string;
  tagQuery: string;
  repeaterQuery: string;
  durationMinInput: string;
  durationMaxInput: string;
  transcriptFilter: "" | "yes" | "no" | "pending";
  dateFrom: string;
  dateTo: string;
}

interface RecordingSection {
  key: string;
  label: string;
  count: number;
  description: string;
  items: Recording[];
  group?: string | null;
}

function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: FilterPreset[]) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

function BrowsePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<"browse" | "search">(
    searchParams.get("view") === "search" ? "search" : "browse",
  );
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") ?? "");
  const [submittedSearch, setSubmittedSearch] = useState(searchParams.get("q") ?? "");
  const [mode, setMode] = useState<string>("");
  const [repeaterQuery, setRepeaterQuery] = useState(searchParams.get("repeater") ?? "");
  const [frequencyMinInput, setFrequencyMinInput] = useState("");
  const [frequencyMaxInput, setFrequencyMaxInput] = useState("");
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [callsignQuery, setCallsignQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [durationMinInput, setDurationMinInput] = useState("");
  const [durationMaxInput, setDurationMaxInput] = useState("");
  const [transcriptFilter, setTranscriptFilter] = useState<"" | "yes" | "no" | "pending">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<
    "single" | "bulk" | "filtered" | null
  >(null);
  const [singleDeleteId, setSingleDeleteId] = useState<number | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [listView, setListView] = useState<"grouped" | "time">("grouped");
  const [presets, setPresets] = useState<FilterPreset[]>(loadPresets);
  const [presetName, setPresetName] = useState("");
  const [showPresets, setShowPresets] = useState(false);
  const queryClient = useQueryClient();

  const { data: tagList } = useQuery({
    queryKey: ["tags"],
    queryFn: listTags,
    staleTime: 120_000,
  });

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const params: BrowseParams = {
        mode: mode || undefined,
        frequency_min: frequencyMin,
        frequency_max: frequencyMax,
        q: transcriptSearch,
        callsign,
        tag,
        duration_min: durationMin,
        duration_max: durationMax,
        has_transcript: hasTranscript,
        transcript_pending: transcriptPending,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        page: 1,
        limit: 5000,
      };
      const result = await browseFiles(params);
      const rows = result.items;

      const header = [
        "id", "mode", "frequency_hz", "frequency_label",
        "timestamp", "duration_seconds", "has_transcript",
        "tags", "filename",
      ].join(",");

      const escape = (v: string | number | boolean | null | undefined) => {
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      };

      const lines = rows.map((r: Recording) =>
        [
          r.id,
          r.mode,
          r.frequency_hz ?? "",
          r.frequency_label ?? "",
          r.timestamp ?? "",
          r.duration_seconds ?? "",
          r.has_transcript ? "true" : "false",
          (r.tags ?? []).join("|"),
          r.filename,
        ]
          .map(escape)
          .join(",")
      );

      const csv = [header, ...lines].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sdr-recordings-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const frequencyMin = parseFrequencyInput(frequencyMinInput);
  const frequencyMax = parseFrequencyInput(frequencyMaxInput);
  const durationMin = parseNonNegativeNumber(durationMinInput);
  const durationMax = parseNonNegativeNumber(durationMaxInput);
  const transcriptSearch = transcriptQuery.trim() || undefined;
  const callsign = callsignQuery.trim() || undefined;
  const tag = tagQuery.trim() || undefined;
  const repeater = repeaterQuery.trim() || undefined;
  const hasTranscript =
    transcriptFilter === "yes" ? true : transcriptFilter === "no" ? false : undefined;
  const transcriptPending = transcriptFilter === "pending" ? true : undefined;
  const hasActiveFilters =
    mode !== "" ||
    frequencyMin !== undefined ||
    frequencyMax !== undefined ||
    transcriptSearch !== undefined ||
    callsign !== undefined ||
    tag !== undefined ||
    repeater !== undefined ||
    durationMin !== undefined ||
    durationMax !== undefined ||
    hasTranscript !== undefined ||
    dateFrom !== "" ||
    dateTo !== "";

  const getCurrentFilters = (): Omit<FilterPreset, "name"> => ({
    mode,
    frequencyMinInput,
    frequencyMaxInput,
    transcriptQuery,
    callsignQuery,
    tagQuery,
    repeaterQuery,
    durationMinInput,
    durationMaxInput,
    transcriptFilter,
    dateFrom,
    dateTo,
  });

  const applyPreset = (preset: FilterPreset) => {
    setMode(preset.mode);
    setFrequencyMinInput(preset.frequencyMinInput);
    setFrequencyMaxInput(preset.frequencyMaxInput);
    setTranscriptQuery(preset.transcriptQuery);
    setCallsignQuery(preset.callsignQuery);
    setTagQuery(preset.tagQuery);
    setRepeaterQuery(preset.repeaterQuery);
    setDurationMinInput(preset.durationMinInput);
    setDurationMaxInput(preset.durationMaxInput);
    setTranscriptFilter(preset.transcriptFilter);
    setDateFrom(preset.dateFrom);
    setDateTo(preset.dateTo);
    setPage(1);
    setShowPresets(false);
  };

  const handleSavePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const newPreset: FilterPreset = { name, ...getCurrentFilters() };
    const updated = [...presets.filter((p) => p.name !== name), newPreset];
    setPresets(updated);
    savePresets(updated);
    setPresetName("");
  };

  const handleDeletePreset = (name: string) => {
    const updated = presets.filter((p) => p.name !== name);
    setPresets(updated);
    savePresets(updated);
  };

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "files",
      mode,
      frequencyMinInput,
      frequencyMaxInput,
      transcriptQuery,
      callsignQuery,
      tagQuery,
      repeaterQuery,
      durationMinInput,
      durationMaxInput,
      transcriptFilter,
      dateFrom,
      dateTo,
      page,
    ],
    queryFn: () =>
      browseFiles({
        mode: mode || undefined,
        frequency_min: frequencyMin,
        frequency_max: frequencyMax,
        q: transcriptSearch,
        callsign,
        tag,
        repeater,
        duration_min: durationMin,
        duration_max: durationMax,
        has_transcript: hasTranscript,
        transcript_pending: transcriptPending,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        page,
        limit: 50,
      }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  // Text search query (for search mode)
  const searchResults = useQuery({
    queryKey: ["text-search", submittedSearch, mode],
    queryFn: () =>
      searchText({
        q: submittedSearch,
        mode: mode || undefined,
      }),
    enabled: viewMode === "search" && submittedSearch.length > 0,
    placeholderData: keepPreviousData,
  });

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!data) return;
    const pageIds = data.items.map((r) => r.id);
    const allSelected = pageIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      pageIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const handleSingleDelete = async () => {
    if (singleDeleteId === null) return;
    setDeleting(true);
    setActionMessage(null);
    try {
      await deleteFile(singleDeleteId);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(singleDeleteId);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setActionMessage("Deleted 1 recording.");
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
      setSingleDeleteId(null);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    setActionMessage(null);
    try {
      await bulkDeleteFiles(Array.from(selected));
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setActionMessage(`Deleted ${selected.size} selected recordings.`);
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  const handleFilteredDelete = async () => {
    if (!hasActiveFilters) return;
    setDeleting(true);
    setActionMessage(null);
    try {
      const result = await bulkDeleteFilteredFiles({
        mode: mode ? (mode as "cw" | "voice") : undefined,
        frequency_min: frequencyMin,
        frequency_max: frequencyMax,
        q: transcriptSearch,
        callsign,
        duration_min: durationMin,
        duration_max: durationMax,
        has_transcript: hasTranscript,
        transcript_pending: transcriptPending,
      });
      setSelected(new Set());
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setActionMessage(`Deleted ${result.deleted} filtered recordings.`);
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };


  const pageItems = data?.items ?? [];
  const pageIds = pageItems.map((r) => r.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const filteredTotal = data?.total ?? 0;

  const groupSummaries = useMemo(() => {
    return FREQUENCY_GROUP_ORDER.map((group) => {
      const count = pageItems.filter(
        (recording) => (recording.frequency_group ?? "other") === group,
      ).length;
      return {
        group,
        count,
        label: getFrequencyGroupLabel(
          group,
          pageItems.find(
            (recording) => (recording.frequency_group ?? "other") === group,
          )?.frequency_group_label,
        ),
      };
    }).filter((entry) => entry.count > 0);
  }, [pageItems]);

  const tableSections = useMemo<RecordingSection[]>(() => {
    if (pageItems.length === 0) return [];
    if (listView === "time") {
      return [
        {
          key: "latest",
          label: "Latest First",
          count: pageItems.length,
          description: "Newest recordings across all frequency groups.",
          items: pageItems,
        },
      ];
    }

    const sections: RecordingSection[] = [];
    for (const group of FREQUENCY_GROUP_ORDER) {
      const items = pageItems.filter(
        (recording) => (recording.frequency_group ?? "other") === group,
      );
      if (items.length === 0) continue;
      sections.push({
        key: group,
        label: getFrequencyGroupLabel(
          group,
          items[0]?.frequency_group_label,
        ),
        count: items.length,
        description:
          group === "ham"
            ? "Ham traffic is kept together so it is easier to scan."
            : group === "emergency"
              ? "Emergency and public-safety traffic is split out from ham."
              : "Everything else on this page.",
        items,
        group,
      });
    }
    return sections;
  }, [pageItems, listView]);

  const renderRecordingRow = (recording: Recording) => {
    const theme = getFrequencyGroupTheme(recording.frequency_group);
    return (
      <tr
        key={recording.id}
        className={`${theme.rowClassName} hover:bg-black/20 transition-colors`}
      >
        <td className="px-4 py-3">
          <input
            type="checkbox"
            checked={selected.has(recording.id)}
            onChange={() => toggleSelect(recording.id)}
            className="rounded bg-gray-600 border-gray-500"
          />
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-col gap-1">
            <span
              className={`inline-flex px-2 py-1 text-xs font-medium rounded ${
                ({
                  cw: "bg-yellow-900 text-yellow-200",
                  aprs: "bg-green-900 text-green-200",
                  hfdl: "bg-cyan-900 text-cyan-200",
                  acars: "bg-cyan-900 text-cyan-200",
                  vdl2: "bg-cyan-900 text-cyan-200",
                  pager: "bg-red-900 text-red-200",
                  eas: "bg-red-900 text-red-200",
                  sstv: "bg-purple-900 text-purple-200",
                } as Record<string, string>)[recording.mode] ??
                "bg-blue-900 text-blue-200"
              }`}
            >
              {recording.mode.toUpperCase()}
            </span>
            {recording.signal_db != null && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                  recording.signal_db > -20
                    ? "bg-green-900 text-green-300"
                    : recording.signal_db > -40
                      ? "bg-yellow-900 text-yellow-300"
                      : "bg-red-900 text-red-300"
                }`}
              >
                {recording.signal_db.toFixed(0)} dB
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-sm">
          <button
            onClick={() =>
              recording.frequency_hz != null &&
              navigate(`/frequency/${recording.frequency_hz}`)
            }
            className="text-left hover:text-cyan-300 transition-colors disabled:hover:text-inherit"
            disabled={recording.frequency_hz == null}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span>{formatFrequency(recording.frequency_hz)}</span>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${theme.badgeClassName}`}
              >
                {getFrequencyGroupLabel(
                  recording.frequency_group,
                  recording.frequency_group_label,
                )}
              </span>
            </div>
            {recording.frequency_label && (
              <div className="text-xs text-cyan-400 mt-0.5">
                {recording.frequency_label}
              </div>
            )}
          </button>
        </td>
        <td className="px-4 py-3 text-sm text-gray-400">
          {recording.timestamp
            ? formatDateTime(recording.timestamp)
            : "Unknown"}
        </td>
        <td className="px-4 py-3 text-sm text-gray-400">
          {formatDuration(recording.duration_seconds)}
        </td>
        <td className="px-4 py-3 text-sm">
          {(() => {
            const s =
              recording.transcript_status ??
              (recording.has_transcript ? "yes" : "no");
            return s === "yes" ? (
              <span className="text-green-400">Yes</span>
            ) : s === "pending" ? (
              <span className="text-yellow-400">Pending</span>
            ) : (
              <span className="text-gray-500">No</span>
            );
          })()}
        </td>
        <td className="px-4 py-3 text-sm text-gray-300">
          {recording.tags && recording.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {recording.tags.slice(0, 5).map((tag) => {
                const isCallsign = recording.callsign_tags?.includes(tag);
                const isEmergency = [
                  "emergency",
                  "fire",
                  "medical",
                  "law_enforcement",
                  "accident",
                  "hazmat",
                  "missing_person",
                  "severe_weather",
                ].includes(tag);
                if (isCallsign) {
                  return (
                    <CallsignLink
                      key={tag}
                      callsign={tag}
                      className="inline-flex px-2 py-0.5 text-xs rounded bg-purple-900 text-purple-100 hover:bg-purple-800 transition-colors"
                    />
                  );
                }
                const cls = `inline-flex px-2 py-0.5 text-xs rounded transition-colors ${
                  isEmergency
                    ? "bg-red-900 text-red-100 hover:bg-red-800"
                    : "bg-sky-900 text-sky-100 hover:bg-sky-800"
                }`;
                return (
                  <TagLink
                    key={tag}
                    tag={tag}
                    className={cls}
                  />
                );
              })}
            </div>
          ) : (
            <span className="text-gray-500">-</span>
          )}
        </td>
        <td className="px-4 py-3 text-right flex justify-end gap-3">
          <Link
            to={`/player/${recording.id}`}
            className="text-green-400 hover:text-green-300 text-sm font-medium"
          >
            Play
          </Link>
          <button
            onClick={() => {
              setSingleDeleteId(recording.id);
              setConfirmDelete("single");
            }}
            className="text-red-400 hover:text-red-300 text-sm font-medium"
          >
            Delete
          </button>
        </td>
      </tr>
    );
  };

  if (error) {
    return (
      <div className="text-red-400">Failed to load recordings: {String(error)}</div>
    );
  }

  return (
    <div>
      {/* Confirm dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Confirm Delete</h3>
            <p className="text-gray-400 mb-4">
              {confirmDelete === "single"
                ? "Delete this recording? This cannot be undone."
                : confirmDelete === "bulk"
                  ? `Delete ${selected.size} selected recording${selected.size !== 1 ? "s" : ""}? This cannot be undone.`
                  : `Delete all ${filteredTotal} recordings matching the current filters? This cannot be undone.`}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setConfirmDelete(null);
                  setSingleDeleteId(null);
                }}
                className="px-4 py-2 bg-gray-700 rounded hover:bg-gray-600"
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (confirmDelete === "single") {
                    handleSingleDelete();
                    return;
                  }
                  if (confirmDelete === "bulk") {
                    handleBulkDelete();
                    return;
                  }
                  handleFilteredDelete();
                }}
                className="px-4 py-2 bg-red-600 rounded hover:bg-red-500 disabled:opacity-50"
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View mode toggle: Browse / Search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
          <button
            onClick={() => setViewMode("browse")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              viewMode === "browse"
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            }`}
          >
            Browse
          </button>
          <button
            onClick={() => setViewMode("search")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              viewMode === "search"
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            }`}
          >
            Search Transcripts
          </button>
        </div>
      </div>

      {/* Search mode */}
      {viewMode === "search" && (
        <div className="mb-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedSearch(searchQuery);
            }}
            className="mb-4"
          >
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search decoded text..."
                className="flex-1 bg-gray-800 border border-gray-600 rounded px-4 py-2"
                autoFocus
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
              <button
                type="submit"
                className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded font-medium"
              >
                Search
              </button>
            </div>
          </form>

          {searchResults.isLoading && (
            <div className="text-center py-8">Searching...</div>
          )}

          {searchResults.error && (
            <div className="text-red-400 mb-4">
              Search failed: {String(searchResults.error)}
            </div>
          )}

          {searchResults.data && (
            <div>
              <div className="text-sm text-gray-400 mb-4">
                Found {searchResults.data.total} result
                {searchResults.data.total !== 1 ? "s" : ""} for "
                {searchResults.data.query}"
              </div>
              <div className="space-y-4">
                {searchResults.data.items.map((result: SearchResult) => (
                  <div
                    key={result.id}
                    className="bg-gray-800 rounded-lg p-4 hover:bg-gray-750"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <Link
                          to={`/player/${result.id}?q=${encodeURIComponent(submittedSearch)}`}
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
                              <span className="ml-1.5 text-cyan-400">
                                {result.frequency_label}
                              </span>
                            )}
                          </span>
                          {result.timestamp && (
                            <span>{formatDateTime(result.timestamp)}</span>
                          )}
                        </div>
                      </div>
                      <Link
                        to={`/player/${result.id}?q=${encodeURIComponent(submittedSearch)}`}
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
              {searchResults.data.items.length === 0 && (
                <div className="text-center py-8 text-gray-400">
                  No results found for "{searchResults.data.query}"
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Browse mode */}
      {viewMode === "browse" && (<>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Recordings</h1>
        <div className="flex gap-2 items-center">
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="px-3 py-2 bg-gray-700 rounded text-sm font-medium hover:bg-gray-600 disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          {selected.size > 0 && (
            <button
              onClick={() => setConfirmDelete("bulk")}
              className="px-3 py-2 bg-red-600 rounded text-sm font-medium hover:bg-red-500"
            >
              Delete {selected.size} selected
            </button>
          )}
          {hasActiveFilters && filteredTotal > 0 && (
            <button
              onClick={() => setConfirmDelete("filtered")}
              className="px-3 py-2 bg-red-700 rounded text-sm font-medium hover:bg-red-600"
            >
              Delete filtered ({filteredTotal})
            </button>
          )}
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 mb-3 overflow-x-auto pb-1">
        {[
          { value: "", label: "All" },
          { value: "voice", label: "Voice", color: "blue" },
          { value: "cw", label: "CW", color: "yellow" },
          { value: "aprs", label: "APRS", color: "green" },
          { value: "pager", label: "Pager", color: "red" },
          { value: "hfdl", label: "HFDL", color: "cyan" },
          { value: "acars", label: "ACARS", color: "cyan" },
          { value: "vdl2", label: "VDL2", color: "cyan" },
          { value: "eas", label: "EAS", color: "red" },
          { value: "sstv", label: "SSTV", color: "purple" },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setMode(tab.value); setPage(1); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              mode === tab.value
                ? "bg-gray-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Min Freq (Hz or MHz)</label>
            <input
              type="number"
              min={0}
              value={frequencyMinInput}
              onChange={(e) => {
                setFrequencyMinInput(e.target.value);
                setPage(1);
              }}
              placeholder="144.39 or 144390000"
              className="w-36 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Max Freq (Hz or MHz)</label>
            <input
              type="number"
              min={0}
              value={frequencyMaxInput}
              onChange={(e) => {
                setFrequencyMaxInput(e.target.value);
                setPage(1);
              }}
              placeholder="148.00 or 148000000"
              className="w-36 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Transcript Search</label>
            <input
              type="text"
              value={transcriptQuery}
              onChange={(e) => {
                setTranscriptQuery(e.target.value);
                setPage(1);
              }}
              placeholder="e.g. repeater check in"
              className="w-56 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Callsign</label>
            <input
              type="text"
              value={callsignQuery}
              onChange={(e) => {
                setCallsignQuery(e.target.value);
                setPage(1);
              }}
              placeholder="N0CALL"
              className="w-32 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm uppercase"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Tag</label>
            <input
              type="text"
              list="tag-suggestions"
              value={tagQuery}
              onChange={(e) => {
                setTagQuery(e.target.value.toLowerCase());
                setPage(1);
              }}
              placeholder="e.g. repeater"
              className="w-36 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
            <datalist id="tag-suggestions">
              {tagList?.map((t) => (
                <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
              ))}
            </datalist>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Repeater</label>
            <input
              type="text"
              value={repeaterQuery}
              onChange={(e) => {
                setRepeaterQuery(e.target.value.toUpperCase());
                setPage(1);
              }}
              placeholder="W8ABC"
              className="w-28 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm uppercase"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Min Duration (s)</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={durationMinInput}
              onChange={(e) => {
                setDurationMinInput(e.target.value);
                setPage(1);
              }}
              placeholder="e.g. 2"
              className="w-36 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Max Duration (s)</label>
            <input
              type="number"
              min={0}
              step="0.1"
              value={durationMaxInput}
              onChange={(e) => {
                setDurationMaxInput(e.target.value);
                setPage(1);
              }}
              placeholder="e.g. 2"
              className="w-36 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Transcript</label>
            <select
              value={transcriptFilter}
              onChange={(e) => {
                setTranscriptFilter(e.target.value as "" | "yes" | "no" | "pending");
                setPage(1);
              }}
              className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            >
              <option value="">Any</option>
              <option value="yes">With transcript</option>
              <option value="pending">Pending</option>
              <option value="no">No transcript</option>
            </select>
          </div>
          <button
            onClick={() => {
              setDurationMinInput("");
              setDurationMaxInput("2");
              setPage(1);
            }}
            className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
          >
            Short clips (≤2s)
          </button>
          <button
            onClick={() => {
              setCallsignQuery("N0CALL");
              setPage(1);
            }}
            className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
          >
            My callsign
          </button>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Date From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Date To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => {
              setMode("");
              setFrequencyMinInput("");
              setFrequencyMaxInput("");
              setTranscriptQuery("");
              setCallsignQuery("");
              setTagQuery("");
              setRepeaterQuery("");
              setDurationMinInput("");
              setDurationMaxInput("");
              setTranscriptFilter("");
              setDateFrom("");
              setDateTo("");
              setPage(1);
            }}
            className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
          >
            Clear filters
          </button>
        </div>
        {/* Saved presets */}
        <div className="flex flex-wrap gap-2 mt-3 items-center border-t border-gray-700 pt-3">
          <span className="text-xs text-gray-500">Presets:</span>
          {presets.map((p) => (
            <div key={p.name} className="flex items-center gap-1">
              <button
                onClick={() => applyPreset(p)}
                className="px-2 py-1 bg-indigo-900 hover:bg-indigo-800 text-indigo-200 rounded text-xs"
              >
                {p.name}
              </button>
              <button
                onClick={() => handleDeletePreset(p.name)}
                className="text-gray-600 hover:text-red-400 text-xs"
                title="Delete preset"
              >
                ×
              </button>
            </div>
          ))}
          {showPresets ? (
            <div className="flex gap-1 items-center">
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name…"
                className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs w-32"
                onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); }}
              />
              <button
                onClick={handleSavePreset}
                disabled={!presetName.trim()}
                className="px-2 py-1 bg-green-800 hover:bg-green-700 rounded text-xs disabled:opacity-40"
              >
                Save
              </button>
              <button
                onClick={() => setShowPresets(false)}
                className="px-2 py-1 bg-gray-700 rounded text-xs"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowPresets(true)}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
            >
              + Save current filters
            </button>
          )}
        </div>
      </div>

      {actionMessage && (
        <div className="mb-4 text-sm text-green-300 bg-green-900/30 border border-green-800 rounded px-3 py-2">
          {actionMessage}
        </div>
      )}

      {pageItems.length > 0 && (
        <div className="mb-4 rounded-lg border border-gray-700 bg-gray-800/80 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-gray-500">
                Current Page Mix
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {groupSummaries.map((entry) => {
                  const theme = getFrequencyGroupTheme(entry.group);
                  return (
                    <div
                      key={entry.group}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${theme.panelClassName}`}
                    >
                      <span className="text-gray-100">{entry.label}</span>
                      <span className="ml-2 font-mono text-gray-400">
                        {entry.count}
                      </span>
                    </div>
                  );
                })}
              </div>
              {listView === "grouped" && (
                <div className="mt-2 text-[11px] text-gray-500">
                  Grouped view keeps the newest items inside each section so ham is easier to scan.
                </div>
              )}
            </div>
            <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
              <button
                type="button"
                onClick={() => setListView("grouped")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  listView === "grouped"
                    ? "bg-emerald-700 text-emerald-50"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                Split by type
              </button>
              <button
                type="button"
                onClick={() => setListView("time")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  listView === "time"
                    ? "bg-blue-700 text-blue-50"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                Time order
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8">Loading...</div>
      ) : (
        <>
          <div className="bg-gray-800 rounded-lg overflow-hidden sticky-table">
            <table className="w-full">
              <thead className="bg-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="rounded bg-gray-600 border-gray-500"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Mode</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Frequency</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Date/Time</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Duration</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Transcript</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Tags</th>
                  <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {tableSections.map((section) => {
                  const theme = getFrequencyGroupTheme(section.group);
                  return (
                    <Fragment key={section.key}>
                      {listView === "grouped" && (
                        <tr className="bg-gray-900/80">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                {section.group ? (
                                  <span
                                    className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${theme.badgeClassName}`}
                                  >
                                    {theme.icon}
                                  </span>
                                ) : null}
                                <div>
                                  <div className="text-sm font-semibold text-gray-100">
                                    {section.label}
                                  </div>
                                  <div className="text-[11px] text-gray-500">
                                    {section.description}
                                  </div>
                                </div>
                              </div>
                              <span className="font-mono text-xs text-gray-400">
                                {section.count} on this page
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                      {section.items.map((recording) => renderRecordingRow(recording))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data && data.total > data.limit && (
            <div className="flex items-center justify-between mt-4 pagination">
              <div className="text-sm text-gray-400">
                Showing {(page - 1) * data.limit + 1} -{" "}
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
      </>)}
    </div>
  );
}

export default BrowsePage;
