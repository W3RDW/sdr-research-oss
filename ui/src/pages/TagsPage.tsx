import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  listTags,
  browseFiles,
  getStats,
  Recording,
} from "../api/client";
import { formatDateTime } from "../utils/time";
import { CallsignLink } from "../components/CallsignLink";
import { TagLink } from "../components/TagLink";

// ── Helpers ──────────────────────────────────────────────────────────

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const MODE_COLORS: Record<string, string> = {
  voice: "bg-blue-900 text-blue-200",
  cw: "bg-yellow-900 text-yellow-200",
  aprs: "bg-green-900 text-green-200",
  hfdl: "bg-cyan-900 text-cyan-200",
  acars: "bg-cyan-900 text-cyan-200",
  vdl2: "bg-cyan-900 text-cyan-200",
  pager: "bg-red-900 text-red-200",
  eas: "bg-red-900 text-red-200",
  sstv: "bg-purple-900 text-purple-200",
  ft8: "bg-orange-900 text-orange-200",
  wspr: "bg-amber-900 text-amber-200",
};

function ModeBadge({ mode }: { mode: string }) {
  const cls = MODE_COLORS[mode] ?? "bg-gray-700 text-gray-300";
  return (
    <span
      className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wide ${cls}`}
    >
      {mode}
    </span>
  );
}

// ── Tag classification ───────────────────────────────────────────────

type TagCategory = "callsign" | "emergency" | "mode" | "other";

const EMERGENCY_KEYWORDS = [
  "emergency",
  "mayday",
  "sos",
  "distress",
  "rescue",
  "fire",
  "accident",
  "hazmat",
  "evacuation",
  "911",
  "pan-pan",
  "panpan",
  "alert",
  "warning",
  "severe",
  "tornado",
  "hurricane",
];

const MODE_KEYWORDS = [
  "voice",
  "cw",
  "morse",
  "aprs",
  "fm",
  "am",
  "ssb",
  "dmr",
  "p25",
  "dstar",
  "d-star",
  "fusion",
  "nxdn",
  "analog",
  "digital",
  "nbfm",
  "wbfm",
  "ft8",
  "wspr",
  "hfdl",
  "acars",
  "vdl2",
  "sstv",
  "pager",
  "eas",
];

// Matches common ham callsign patterns: 1-2 letter prefix, digit, 1-4 letter suffix
const CALLSIGN_RE = /^[A-Z]{1,2}\d[A-Z]{1,4}$/i;

function classifyTag(tag: string): TagCategory {
  const lower = tag.toLowerCase();
  if (EMERGENCY_KEYWORDS.some((kw) => lower.includes(kw))) return "emergency";
  if (CALLSIGN_RE.test(tag)) return "callsign";
  if (MODE_KEYWORDS.some((kw) => lower === kw)) return "mode";
  return "other";
}

const CATEGORY_STYLES: Record<
  TagCategory,
  { bg: string; text: string; border: string; ring: string }
> = {
  callsign: {
    bg: "bg-green-900/40",
    text: "text-green-300",
    border: "border-green-700/50",
    ring: "ring-green-500/40",
  },
  emergency: {
    bg: "bg-red-900/40",
    text: "text-red-300",
    border: "border-red-700/50",
    ring: "ring-red-500/40",
  },
  mode: {
    bg: "bg-blue-900/40",
    text: "text-blue-300",
    border: "border-blue-700/50",
    ring: "ring-blue-500/40",
  },
  other: {
    bg: "bg-gray-800/60",
    text: "text-gray-300",
    border: "border-gray-700/50",
    ring: "ring-gray-500/40",
  },
};

// ── Components ───────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function TagBadge({
  tag,
  count,
  maxCount,
  selected,
  onClick,
}: {
  tag: string;
  count: number;
  maxCount: number;
  selected: boolean;
  onClick: () => void;
}) {
  const category = classifyTag(tag);
  const style = CATEGORY_STYLES[category];

  // Scale font size between 0.75rem and 1.25rem based on relative frequency
  const ratio = maxCount > 1 ? Math.log(count + 1) / Math.log(maxCount + 1) : 0.5;
  const fontSize = 0.75 + ratio * 0.5; // rem
  const fontWeight = ratio > 0.6 ? 700 : ratio > 0.3 ? 600 : 400;

  return (
    <button
      onClick={onClick}
      className={`
        inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border
        transition-all duration-150 cursor-pointer
        ${style.bg} ${style.text} ${style.border}
        ${selected ? `ring-2 ${style.ring} border-opacity-100` : "hover:brightness-125"}
      `}
      style={{ fontSize: `${fontSize}rem`, fontWeight }}
      title={`${tag} (${count} recording${count !== 1 ? "s" : ""})`}
    >
      {category === "emergency" && (
        <span className="text-red-400 text-xs">!</span>
      )}
      {tag}
      <span className="text-[0.65em] opacity-60 font-normal ml-0.5">
        {count}
      </span>
    </button>
  );
}

// ── Main page ────────────────────────────────────────────────────────

function TagsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedTag = searchParams.get("tag") || null;
  const [searchText, setSearchText] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<TagCategory | "all">(
    "all"
  );
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Fetch all tags
  const {
    data: tags,
    isLoading: tagsLoading,
    error: tagsError,
  } = useQuery({
    queryKey: ["tags-list"],
    queryFn: listTags,
    staleTime: 30_000,
  });

  // Fetch overall stats for the "recordings without tags" count
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    staleTime: 60_000,
  });

  // Fetch recordings for selected tag
  const { data: recordings, isLoading: recordingsLoading } = useQuery({
    queryKey: ["tag-recordings", selectedTag, page],
    queryFn: () =>
      browseFiles({ tag: selectedTag!, page, limit: pageSize }),
    enabled: !!selectedTag,
    staleTime: 15_000,
  });

  // ── Derived data ──────────────────────────────────────────────────

  const filteredTags = useMemo(() => {
    if (!tags) return [];
    let result = tags;
    // Text search
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((t) => t.tag.toLowerCase().includes(lower));
    }
    // Category filter
    if (categoryFilter !== "all") {
      result = result.filter((t) => classifyTag(t.tag) === categoryFilter);
    }
    // Sort by count descending
    return [...result].sort((a, b) => b.count - a.count);
  }, [tags, searchText, categoryFilter]);

  const maxCount = useMemo(
    () => (filteredTags.length > 0 ? filteredTags[0].count : 1),
    [filteredTags]
  );

  const totalUniqueTags = tags?.length ?? 0;
  const mostCommonTag =
    tags && tags.length > 0
      ? [...tags].sort((a, b) => b.count - a.count)[0]
      : null;

  // Count tags that appear to have been added today
  // We approximate this from stats.daily_last_30 — most recent day's activity
  const tagsToday = stats?.daily_last_30?.length
    ? stats.daily_last_30[stats.daily_last_30.length - 1]?.count ?? 0
    : 0;

  const totalTaggedRecordings = tags
    ? tags.reduce((sum, t) => sum + t.count, 0)
    : 0;

  // Category counts
  const categoryCounts = useMemo(() => {
    if (!tags) return { callsign: 0, emergency: 0, mode: 0, other: 0 };
    const counts = { callsign: 0, emergency: 0, mode: 0, other: 0 };
    for (const t of tags) {
      counts[classifyTag(t.tag)]++;
    }
    return counts;
  }, [tags]);

  function handleTagClick(tag: string) {
    if (selectedTag === tag) {
      // Deselect
      searchParams.delete("tag");
      setSearchParams(searchParams);
    } else {
      setSearchParams({ tag });
    }
    setPage(1);
  }

  const totalPages = recordings ? Math.ceil(recordings.total / pageSize) : 0;

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Tag Management</h1>
        <div className="text-sm text-gray-400">
          AI-generated tags from Ollama analysis
        </div>
      </div>

      {/* ── Statistics cards ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Unique Tags"
          value={totalUniqueTags}
          sub={`${categoryCounts.callsign} callsigns, ${categoryCounts.emergency} emergency`}
        />
        <StatCard
          label="Most Common"
          value={mostCommonTag?.tag ?? "--"}
          sub={
            mostCommonTag
              ? `${mostCommonTag.count} recording${mostCommonTag.count !== 1 ? "s" : ""}`
              : undefined
          }
        />
        <StatCard
          label="Recordings Today"
          value={tagsToday}
          sub="based on latest daily count"
        />
        <StatCard
          label="Total Tag Uses"
          value={totalTaggedRecordings.toLocaleString()}
          sub={`across ${totalUniqueTags} unique tags`}
        />
      </div>

      {/* ── Search and category filter ────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search tags..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500/40 focus:border-green-600"
          />
          {searchText && (
            <button
              onClick={() => setSearchText("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              x
            </button>
          )}
        </div>
        <div className="flex gap-1.5">
          {(
            [
              { key: "all", label: "All" },
              { key: "callsign", label: "Callsigns" },
              { key: "emergency", label: "Emergency" },
              { key: "mode", label: "Modes" },
              { key: "other", label: "Other" },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setCategoryFilter(key)}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                categoryFilter === key
                  ? "bg-green-700 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 border border-gray-700"
              }`}
            >
              {label}
              {key !== "all" && tags && (
                <span className="ml-1 opacity-60">
                  ({categoryCounts[key as TagCategory]})
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tag cloud / grid ──────────────────────────────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Tag Cloud
          </h2>
          <span className="text-xs text-gray-500">
            {filteredTags.length} tag{filteredTags.length !== 1 ? "s" : ""}
            {searchText && " matching"}
          </span>
        </div>

        {tagsLoading && (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-green-400" />
          </div>
        )}

        {tagsError && (
          <div className="text-red-400 text-sm p-4">
            Failed to load tags. Is the API running?
          </div>
        )}

        {!tagsLoading && !tagsError && filteredTags.length === 0 && (
          <div className="text-gray-500 text-sm text-center py-8">
            {searchText
              ? "No tags match your search."
              : "No tags found. Recordings need to be processed by Ollama first."}
          </div>
        )}

        {!tagsLoading && filteredTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {filteredTags.map((t) => (
              <TagBadge
                key={t.tag}
                tag={t.tag}
                count={t.count}
                maxCount={maxCount}
                selected={selectedTag === t.tag}
                onClick={() => handleTagClick(t.tag)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Category legend ───────────────────────────────────────── */}
      <div className="flex flex-wrap gap-4 text-xs text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-green-700/60 border border-green-600/40" />
          Callsign
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-red-700/60 border border-red-600/40" />
          Emergency
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-blue-700/60 border border-blue-600/40" />
          Mode
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-gray-700/60 border border-gray-600/40" />
          Other
        </span>
      </div>

      {/* ── Selected tag: recording list ──────────────────────────── */}
      {selectedTag && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg">
          <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-white">
                Recordings tagged &ldquo;{selectedTag}&rdquo;
              </h2>
              <span className="text-sm text-gray-400">
                {recordings?.total ?? "..."} result
                {recordings?.total !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to={`/browse?tag=${encodeURIComponent(selectedTag)}`}
                className="text-xs text-green-400 hover:text-green-300 underline"
              >
                Open in Browse
              </Link>
              <button
                onClick={() => {
                  searchParams.delete("tag");
                  setSearchParams(searchParams);
                }}
                className="text-gray-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-gray-700"
              >
                Clear
              </button>
            </div>
          </div>

          {recordingsLoading && (
            <div className="flex items-center justify-center h-24">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-400" />
            </div>
          )}

          {!recordingsLoading &&
            recordings &&
            recordings.items.length === 0 && (
              <div className="text-gray-500 text-sm text-center py-8">
                No recordings found with this tag.
              </div>
            )}

          {!recordingsLoading &&
            recordings &&
            recordings.items.length > 0 && (
              <>
                <div className="divide-y divide-gray-700/50">
                  {recordings.items.map((rec: Recording) => (
                    <Link
                      key={rec.id}
                      to={`/player/${rec.id}`}
                      className="flex items-center gap-4 px-5 py-3 hover:bg-gray-700/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <ModeBadge mode={rec.mode} />
                          <span className="text-sm text-white truncate">
                            {formatFrequency(rec.frequency_hz)}
                          </span>
                          {rec.frequency_label && (
                            <span className="text-xs text-gray-500 truncate">
                              {rec.frequency_label}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-400">
                          <span>{formatDateTime(rec.timestamp)}</span>
                          <span>{formatDuration(rec.duration_seconds)}</span>
                          {rec.signal_db != null && (
                            <span
                              className={
                                rec.signal_db > -20
                                  ? "text-green-400"
                                  : rec.signal_db > -40
                                    ? "text-yellow-400"
                                    : "text-red-400"
                              }
                            >
                              {rec.signal_db.toFixed(0)} dB
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Show other tags on this recording */}
                      <div className="hidden sm:flex flex-wrap gap-1 max-w-[200px]">
                        {(rec.tags ?? rec.ai_tags ?? [])
                          .filter((t) => t !== selectedTag)
                          .slice(0, 4)
                          .map((t) => {
                            const cat = classifyTag(t);
                            const isCs = cat === "callsign";
                            const s = CATEGORY_STYLES[cat];
                            if (isCs) {
                              return (
                                <CallsignLink
                                  key={t}
                                  callsign={t}
                                  className={`inline-flex px-1.5 py-0.5 text-[10px] rounded ${s.bg} ${s.text} ${s.border} border hover:brightness-125`}
                                />
                              );
                            }
                            return (
                              <TagLink
                                key={t}
                                tag={t}
                                className={`inline-flex px-1.5 py-0.5 text-[10px] rounded ${s.bg} ${s.text} ${s.border} border hover:brightness-125`}
                              />
                            );
                          })}
                      </div>
                      <svg
                        className="w-4 h-4 text-gray-600 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </Link>
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700">
                    <button
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="px-3 py-1.5 text-sm rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="text-xs text-gray-400">
                      Page {page} of {totalPages}
                    </span>
                    <button
                      disabled={page >= totalPages}
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                      className="px-3 py-1.5 text-sm rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
}

export default TagsPage;
