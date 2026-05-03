import { useState, useMemo, lazy, Suspense } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  listFrequencyLabels,
  listRepeaters,
  createFrequencyLabel,
  browseFiles,
} from "../api/client";

const RepeaterPage = lazy(() => import("./RepeaterPage"));
const BookmarksPage = lazy(() => import("./BookmarksPage"));

/* ── helpers ─────────────────────────────────────────────────────────── */

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(4)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function hzToMhz(hz: number): number {
  return hz / 1_000_000;
}

type BandKey = "all" | "hf" | "vhf" | "uhf";

function getBand(hz: number): "HF" | "VHF" | "UHF" {
  if (hz < 30_000_000) return "HF";
  if (hz < 300_000_000) return "VHF";
  return "UHF";
}

function matchesBand(hz: number, band: BandKey): boolean {
  if (band === "all") return true;
  if (band === "hf") return hz < 30_000_000;
  if (band === "vhf") return hz >= 30_000_000 && hz < 300_000_000;
  return hz >= 300_000_000; // uhf
}

function normalizeMode(mode: string | null | undefined): string {
  if (!mode) return "Unknown";
  const m = mode.toLowerCase().trim();
  if (m === "fm" || m === "am" || m === "ssb" || m === "voice" || m === "nbfm") return "Voice";
  if (m === "cw" || m === "morse") return "CW";
  if (m === "digital" || m === "dmr" || m === "d-star" || m === "p25" || m === "system fusion" || m === "nxdn" || m === "m17" || m === "tetra") return "Digital";
  if (m === "aprs") return "APRS";
  if (m === "pager" || m === "pocsag" || m === "flex") return "Pager";
  return mode;
}

type ModeFilter = "all" | "Voice" | "CW" | "Digital" | "APRS" | "Pager";

/* ── unified row type ────────────────────────────────────────────────── */

interface UnifiedFrequency {
  key: string;
  frequency_hz: number;
  label: string;
  mode: string;
  band: "HF" | "VHF" | "UHF";
  source: "Known" | "Repeater" | "User";
  notes: string | null;
  bandwidth_hz: number | null;
  repeaterCallsign?: string;
  repeaterLocation?: string;
}

/* ── component ───────────────────────────────────────────────────────── */

type FreqTab = "freqdb" | "repeaters" | "bookmarks";

function FrequencyBrowserPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as FreqTab) || "freqdb";
  const setActiveTab = (tab: FreqTab) => {
    setSearchParams(tab === "freqdb" ? {} : { tab });
  };

  // Filter state
  const [bandFilter, setBandFilter] = useState<BandKey>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  // Add form state
  const [formOpen, setFormOpen] = useState(false);
  const [formFreq, setFormFreq] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formMode, setFormMode] = useState("");
  const [formBandwidth, setFormBandwidth] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Data queries
  const labelsQuery = useQuery({
    queryKey: ["frequency-labels"],
    queryFn: listFrequencyLabels,
  });

  const repeatersQuery = useQuery({
    queryKey: ["repeaters-all-for-freqdb"],
    queryFn: () => listRepeaters({ limit: 2000, page: 1 }),
  });

  // Get recent activity (last 24h recordings) to determine active frequencies
  const now24h = useMemo(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return d.toISOString().slice(0, 19);
  }, []);

  const activityQuery = useQuery({
    queryKey: ["freq-activity-24h"],
    queryFn: () => browseFiles({ date_from: now24h, limit: 1000 }),
    staleTime: 60_000,
  });

  // Build activity map: frequency_hz -> count in last 24h
  const activityMap = useMemo(() => {
    const map = new Map<number, number>();
    if (!activityQuery.data) return map;
    for (const rec of activityQuery.data.items) {
      if (rec.frequency_hz) {
        const key = rec.frequency_hz;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
    return map;
  }, [activityQuery.data]);

  // Find activity for a frequency (with ~6kHz tolerance like repeater matching)
  function getActivity(hz: number): number {
    let count = 0;
    for (const [freq, c] of activityMap) {
      if (Math.abs(freq - hz) <= 6000) {
        count += c;
      }
    }
    return count;
  }

  // Merge data sources into unified list
  const allFrequencies = useMemo<UnifiedFrequency[]>(() => {
    const items: UnifiedFrequency[] = [];

    // User-defined frequency labels
    if (labelsQuery.data?.items) {
      for (const fl of labelsQuery.data.items) {
        items.push({
          key: `label-${fl.id}`,
          frequency_hz: fl.frequency_hz,
          label: fl.label,
          mode: normalizeMode(fl.mode),
          band: getBand(fl.frequency_hz),
          source: "User",
          notes: fl.notes,
          bandwidth_hz: fl.bandwidth_hz,
        });
      }
    }

    // Repeaters
    if (repeatersQuery.data?.items) {
      for (const r of repeatersQuery.data.items) {
        const mode =
          r.digital_modes.length > 0
            ? "Digital"
            : "Voice";
        items.push({
          key: `repeater-${r.id}`,
          frequency_hz: r.frequency_hz,
          label: `${r.callsign}${r.location ? ` - ${r.location}` : ""}`,
          mode,
          band: getBand(r.frequency_hz),
          source: "Repeater",
          notes: [
            r.pl_tone ? `PL ${r.pl_tone.toFixed(1)}` : null,
            r.use,
            r.digital_modes.length > 0 ? r.digital_modes.join(", ") : null,
          ]
            .filter(Boolean)
            .join(" | ") || null,
          bandwidth_hz: null,
          repeaterCallsign: r.callsign,
          repeaterLocation: [r.location, r.county, r.state].filter(Boolean).join(", "),
        });
      }
    }

    // Sort by frequency ascending
    items.sort((a, b) => a.frequency_hz - b.frequency_hz);
    return items;
  }, [labelsQuery.data, repeatersQuery.data]);

  // Filter
  const filtered = useMemo(() => {
    let items = allFrequencies;

    if (bandFilter !== "all") {
      items = items.filter((f) => matchesBand(f.frequency_hz, bandFilter));
    }

    if (modeFilter !== "all") {
      items = items.filter((f) => f.mode === modeFilter);
    }

    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      // Try parsing as a number for frequency search
      const asNum = parseFloat(q);
      items = items.filter((f) => {
        const labelMatch = f.label.toLowerCase().includes(q);
        const notesMatch = f.notes?.toLowerCase().includes(q);
        // Match against MHz display value or raw Hz
        let freqMatch = false;
        if (!isNaN(asNum)) {
          const mhz = hzToMhz(f.frequency_hz);
          freqMatch =
            mhz.toFixed(4).includes(q) ||
            f.frequency_hz.toString().includes(q);
        }
        return labelMatch || notesMatch || freqMatch;
      });
    }

    if (activeOnly) {
      items = items.filter((f) => getActivity(f.frequency_hz) > 0);
    }

    return items;
  }, [allFrequencies, bandFilter, modeFilter, searchText, activeOnly, activityMap]);

  // Create frequency label mutation
  const createMutation = useMutation({
    mutationFn: createFrequencyLabel,
    onSuccess: (newLabel) => {
      queryClient.invalidateQueries({ queryKey: ["frequency-labels"] });
      setFormFreq("");
      setFormLabel("");
      setFormMode("");
      setFormBandwidth("");
      setFormNotes("");
      setFormOpen(false);
      setToastMessage(`Added "${newLabel.label}" at ${formatFrequency(newLabel.frequency_hz)}`);
      setTimeout(() => setToastMessage(null), 4000);
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const rawFreq = formFreq.trim();
    if (!rawFreq || !formLabel.trim()) return;

    let hz = parseFloat(rawFreq);
    if (isNaN(hz) || hz <= 0) return;

    // If the value looks like MHz (less than 1,000,000), convert
    if (hz > 0 && hz < 1_000_000) {
      hz = hz * 1_000_000;
    }
    hz = Math.round(hz);

    createMutation.mutate({
      frequency_hz: hz,
      label: formLabel.trim(),
      mode: formMode.trim() || undefined,
      bandwidth_hz: formBandwidth.trim() ? Math.round(parseFloat(formBandwidth) * 1000) : undefined,
      notes: formNotes.trim() || undefined,
    });
  }

  const isLoading = labelsQuery.isLoading || repeatersQuery.isLoading;
  const hasError = labelsQuery.error || repeatersQuery.error;

  // Source badge colors
  function sourceBadge(source: string) {
    switch (source) {
      case "User":
        return "bg-green-900 text-green-200";
      case "Repeater":
        return "bg-purple-900 text-purple-200";
      case "Known":
        return "bg-sky-900 text-sky-200";
      default:
        return "bg-gray-700 text-gray-300";
    }
  }

  function modeBadge(mode: string) {
    switch (mode) {
      case "Voice":
        return "bg-blue-900 text-blue-200";
      case "CW":
        return "bg-amber-900 text-amber-200";
      case "Digital":
        return "bg-indigo-900 text-indigo-200";
      case "APRS":
        return "bg-cyan-900 text-cyan-200";
      case "Pager":
        return "bg-rose-900 text-rose-200";
      default:
        return "bg-gray-700 text-gray-300";
    }
  }

  return (
    <div>
      {/* Frequency section tabs */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
          {([
            { key: "freqdb", label: "Freq DB" },
            { key: "repeaters", label: "Repeaters" },
            { key: "bookmarks", label: "Bookmarks" },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                activeTab === t.key
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Repeaters tab */}
      {activeTab === "repeaters" && (
        <Suspense fallback={<div className="text-center py-8 text-gray-400">Loading...</div>}>
          <RepeaterPage />
        </Suspense>
      )}

      {/* Bookmarks tab */}
      {activeTab === "bookmarks" && (
        <Suspense fallback={<div className="text-center py-8 text-gray-400">Loading...</div>}>
          <BookmarksPage />
        </Suspense>
      )}

      {/* Freq DB tab */}
      {activeTab === "freqdb" && (<>
      {/* Toast notification */}
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 bg-green-800 border border-green-600 text-green-100 px-4 py-3 rounded-lg shadow-lg text-sm animate-pulse">
          {toastMessage}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Frequency Database</h1>
        <span className="text-sm text-gray-400">
          {filtered.length} of {allFrequencies.length} frequencies
        </span>
      </div>

      {/* ── Add Frequency Label (collapsible) ──────────────────────────── */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg mb-4">
        <button
          onClick={() => setFormOpen((o) => !o)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-750 transition-colors rounded-lg"
        >
          <span className="text-sm font-medium text-green-400">
            + Add Frequency Label
          </span>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${formOpen ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {formOpen && (
          <form onSubmit={handleCreate} className="px-4 pb-4 pt-2 border-t border-gray-700">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Frequency (MHz or Hz)
                </label>
                <input
                  type="text"
                  value={formFreq}
                  onChange={(e) => setFormFreq(e.target.value)}
                  placeholder="146.520 or 146520000"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm font-mono"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Label</label>
                <input
                  type="text"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder="2m FM Simplex"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Mode</label>
                <select
                  value={formMode}
                  onChange={(e) => setFormMode(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  <option value="FM">FM</option>
                  <option value="AM">AM</option>
                  <option value="SSB">SSB</option>
                  <option value="CW">CW</option>
                  <option value="Digital">Digital</option>
                  <option value="APRS">APRS</option>
                  <option value="Pager">Pager</option>
                  <option value="NBFM">NBFM</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Bandwidth (kHz)
                </label>
                <input
                  type="text"
                  value={formBandwidth}
                  onChange={(e) => setFormBandwidth(e.target.value)}
                  placeholder="12.5"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Notes</label>
                <input
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Optional notes"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {createMutation.isPending ? "Adding..." : "Add Label"}
              </button>
              {createMutation.isError && (
                <span className="text-red-400 text-sm">
                  {String((createMutation.error as Error)?.message ?? "Failed to add")}
                </span>
              )}
            </div>
          </form>
        )}
      </div>

      {/* ── Filter Bar ──────────────────────────────────────────────────── */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Band</label>
            <select
              value={bandFilter}
              onChange={(e) => setBandFilter(e.target.value as BandKey)}
              className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            >
              <option value="all">All Bands</option>
              <option value="hf">HF (0-30 MHz)</option>
              <option value="vhf">VHF (30-300 MHz)</option>
              <option value="uhf">UHF (300+ MHz)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Mode</label>
            <select
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value as ModeFilter)}
              className="bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            >
              <option value="all">All Modes</option>
              <option value="Voice">Voice</option>
              <option value="CW">CW</option>
              <option value="Digital">Digital</option>
              <option value="APRS">APRS</option>
              <option value="Pager">Pager</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Search</label>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Label or frequency..."
              className="w-48 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-700 rounded-full peer peer-checked:bg-green-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all" />
            </label>
            <span className="text-xs text-gray-400">Active only (24h)</span>
          </div>
          <button
            onClick={() => {
              setBandFilter("all");
              setModeFilter("all");
              setSearchText("");
              setActiveOnly(false);
            }}
            className="px-3 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────────────── */}
      {hasError && (
        <div className="text-red-400 mb-4">
          Failed to load frequency data: {String(labelsQuery.error ?? repeatersQuery.error)}
        </div>
      )}

      {/* ── Loading state ───────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="text-center py-8 text-gray-400">Loading frequency database...</div>
      ) : (
        <>
          {/* ── Frequency Table ───────────────────────────────────────── */}
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Frequency</th>
                    <th className="px-4 py-3 text-left font-medium">Label</th>
                    <th className="px-4 py-3 text-left font-medium">Mode</th>
                    <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Band</th>
                    <th className="px-4 py-3 text-left font-medium">Source</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Notes</th>
                    <th className="px-4 py-3 text-right font-medium">Activity (24h)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                        No frequencies match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((f) => {
                      const activity = getActivity(f.frequency_hz);
                      return (
                        <tr
                          key={f.key}
                          onClick={() => navigate(`/frequency/${f.frequency_hz}`)}
                          className="hover:bg-gray-750 cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-2 font-mono text-green-300 tabular-nums whitespace-nowrap">
                            {formatFrequency(f.frequency_hz)}
                          </td>
                          <td className="px-4 py-2 text-gray-200 max-w-xs truncate">
                            {f.label}
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`inline-block px-1.5 py-0.5 text-xs rounded ${modeBadge(f.mode)}`}
                            >
                              {f.mode}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-400 hidden sm:table-cell">
                            {f.band}
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`inline-block px-1.5 py-0.5 text-xs rounded ${sourceBadge(f.source)}`}
                            >
                              {f.source}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-500 text-xs max-w-xs truncate hidden md:table-cell">
                            {f.notes || "—"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {activity > 0 ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
                                <span className="text-green-300">{activity}</span>
                              </span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Summary ───────────────────────────────────────────────── */}
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-gray-500">
            <span>
              User labels: {labelsQuery.data?.items?.length ?? 0}
            </span>
            <span>
              Repeaters: {repeatersQuery.data?.items?.length ?? 0}
            </span>
            <span>
              Active in 24h: {[...new Set(
                filtered.filter((f) => getActivity(f.frequency_hz) > 0).map((f) => f.frequency_hz)
              )].length} frequencies
            </span>
          </div>
        </>
      )}
      </>)}
    </div>
  );
}

export default FrequencyBrowserPage;
