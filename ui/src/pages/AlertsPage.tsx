import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  listAlerts,
  resendAlert,
  listAlertRules,
  createAlertRule,
  deleteAlertRule,
  toggleAlertRule,
  AlertHistoryEntry,
} from "../api/client";
import { formatDateTime, TZ } from "../utils/time";

// ── Constants ────────────────────────────────────────────────────────

const EMERGENCY_KEYWORDS = [
  "emergency", "mayday", "sos", "fire", "medical", "law_enforcement",
  "accident", "hazmat", "missing_person", "severe_weather", "pan-pan",
  "distress", "911",
];

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

// ── Helpers ──────────────────────────────────────────────────────────

function formatFrequency(hz: number | null): string {
  if (!hz) return "";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function toUtcDate(ts: string): Date {
  return new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
}

function startOfDayET(d: Date): Date {
  const s = d.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  // s = "MM/DD/YYYY"
  const [m, day, y] = s.split("/");
  return new Date(`${y}-${m}-${day}T00:00:00`);
}

/** Classify a match string */
function matchType(m: string): "callsign" | "emergency" | "keyword" {
  if (m.startsWith("callsign:")) return "callsign";
  const val = m.replace(/^keyword:/, "").toLowerCase();
  if (EMERGENCY_KEYWORDS.includes(val)) return "emergency";
  return "keyword";
}

function matchBadgeClass(m: string): string {
  const t = matchType(m);
  if (t === "emergency") return "bg-red-900 text-red-200 border border-red-700";
  if (t === "callsign") return "bg-green-900 text-green-200";
  return "bg-orange-900 text-orange-200";
}

/** Does any match in the alert qualify as an emergency? */
function isEmergencyAlert(alert: AlertHistoryEntry): boolean {
  return alert.matched.some((m) => matchType(m) === "emergency");
}

function hasCallsignMatch(alert: AlertHistoryEntry): boolean {
  return alert.matched.some((m) => matchType(m) === "callsign");
}

/** Extract mode from filename (e.g. "voice_144390000_..." -> "voice") */
function modeFromFilename(filename: string | null): string | null {
  if (!filename) return null;
  const base = filename.split("/").pop() ?? filename;
  const first = base.split("_")[0]?.toLowerCase();
  if (first && MODE_COLORS[first]) return first;
  if (base.includes("aprs")) return "aprs";
  if (base.includes("cw")) return "cw";
  return null;
}

type TimeGroup = "today" | "yesterday" | "this_week" | "older";

function getTimeGroup(ts: string | null): TimeGroup {
  if (!ts) return "older";
  const d = toUtcDate(ts);
  const now = new Date();
  const todayStart = startOfDayET(now);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);
  if (d >= todayStart) return "today";
  if (d >= yesterdayStart) return "yesterday";
  if (d >= weekStart) return "this_week";
  return "older";
}

const TIME_GROUP_LABELS: Record<TimeGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This Week",
  older: "Older",
};

const TIME_GROUP_ORDER: TimeGroup[] = ["today", "yesterday", "this_week", "older"];

type ResendState = "idle" | "sending" | "ok" | "err";
type FilterType = "all" | "keyword" | "callsign";

// ── Components ───────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, accent }: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 flex flex-col min-w-0">
      <span className="text-xs text-gray-400 uppercase tracking-wide mb-1">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${accent ?? "text-white"}`}>{value}</span>
      {sub && <span className="text-xs text-gray-500 mt-1 truncate">{sub}</span>}
    </div>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const cls = MODE_COLORS[mode] ?? "bg-gray-700 text-gray-300";
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded uppercase tracking-wide ${cls}`}>
      {mode}
    </span>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

function AlertsPage() {
  // Data queries
  const {
    data: alertData,
    isLoading: alertsLoading,
    error: alertsError,
    refetch: refetchAlerts,
  } = useQuery({
    queryKey: ["alerts"],
    queryFn: () => listAlerts(500),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const {
    data: rulesData,
    isLoading: rulesLoading,
    refetch: refetchRules,
  } = useQuery({
    queryKey: ["alert-rules"],
    queryFn: listAlertRules,
    staleTime: 30_000,
  });

  // State
  const [resendStates, setResendStates] = useState<Record<number, ResendState>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // Filters
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterFreq, setFilterFreq] = useState("");

  // New rule form
  const [newRuleType, setNewRuleType] = useState<"keyword" | "callsign">("keyword");
  const [newRuleValue, setNewRuleValue] = useState("");
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Collapsible sections
  const [rulesExpanded, setRulesExpanded] = useState(true);

  // ── Computed data ──────────────────────────────────────────────────

  const alerts = alertData?.items ?? [];

  // Summary stats
  const stats = useMemo(() => {
    const now = new Date();
    const todayStart = startOfDayET(now);
    const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);

    let alertsToday = 0;
    let alertsThisWeek = 0;
    const ruleCounts: Record<string, number> = {};

    for (const a of alerts) {
      if (a.timestamp) {
        const d = toUtcDate(a.timestamp);
        if (d >= todayStart) alertsToday++;
        if (d >= weekStart) alertsThisWeek++;
      }
      for (const m of a.matched) {
        ruleCounts[m] = (ruleCounts[m] ?? 0) + 1;
      }
    }

    let topRule = "";
    let topCount = 0;
    for (const [rule, count] of Object.entries(ruleCounts)) {
      if (count > topCount) {
        topRule = rule;
        topCount = count;
      }
    }

    return {
      total: alertData?.total ?? 0,
      alertsToday,
      alertsThisWeek,
      topRule: topRule || "None",
      topCount,
    };
  }, [alerts, alertData?.total]);

  // Filtered alerts
  const filteredAlerts = useMemo(() => {
    let filtered = alerts;

    // Type filter
    if (filterType === "keyword") {
      filtered = filtered.filter((a) =>
        a.matched.some((m) => !m.startsWith("callsign:"))
      );
    } else if (filterType === "callsign") {
      filtered = filtered.filter((a) =>
        a.matched.some((m) => m.startsWith("callsign:"))
      );
    }

    // Date range
    if (filterDateFrom) {
      const from = new Date(filterDateFrom + "T00:00:00Z");
      filtered = filtered.filter(
        (a) => a.timestamp && toUtcDate(a.timestamp) >= from
      );
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo + "T23:59:59Z");
      filtered = filtered.filter(
        (a) => a.timestamp && toUtcDate(a.timestamp) <= to
      );
    }

    // Frequency filter
    if (filterFreq.trim()) {
      const q = filterFreq.trim().toLowerCase();
      filtered = filtered.filter(
        (a) =>
          (a.frequency_label && a.frequency_label.toLowerCase().includes(q)) ||
          (a.frequency_hz && formatFrequency(a.frequency_hz).toLowerCase().includes(q))
      );
    }

    // Search within transcripts / matched
    if (filterSearch.trim()) {
      const q = filterSearch.trim().toLowerCase();
      filtered = filtered.filter(
        (a) =>
          (a.transcript_excerpt && a.transcript_excerpt.toLowerCase().includes(q)) ||
          a.matched.some((m) => m.toLowerCase().includes(q)) ||
          (a.filename && a.filename.toLowerCase().includes(q))
      );
    }

    return filtered;
  }, [alerts, filterType, filterSearch, filterDateFrom, filterDateTo, filterFreq]);

  // Group by time
  const grouped = useMemo(() => {
    const groups: Record<TimeGroup, AlertHistoryEntry[]> = {
      today: [],
      yesterday: [],
      this_week: [],
      older: [],
    };
    for (const a of filteredAlerts) {
      groups[getTimeGroup(a.timestamp)].push(a);
    }
    return groups;
  }, [filteredAlerts]);

  // Available frequencies for filter dropdown
  const availableFreqs = useMemo(() => {
    const freqs = new Set<string>();
    for (const a of alerts) {
      if (a.frequency_label) freqs.add(a.frequency_label);
    }
    return Array.from(freqs).sort();
  }, [alerts]);

  // ── Handlers ───────────────────────────────────────────────────────

  const handleResend = useCallback(async (id: number) => {
    setResendStates((s) => ({ ...s, [id]: "sending" }));
    try {
      await resendAlert(id);
      setResendStates((s) => ({ ...s, [id]: "ok" }));
      setTimeout(() => setResendStates((s) => ({ ...s, [id]: "idle" })), 3000);
    } catch {
      setResendStates((s) => ({ ...s, [id]: "err" }));
      setTimeout(() => setResendStates((s) => ({ ...s, [id]: "idle" })), 4000);
    }
  }, []);

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRuleValue.trim()) return;
    setBusy("rule-add");
    setRuleMsg(null);
    try {
      await createAlertRule({ rule_type: newRuleType, value: newRuleValue.trim() });
      setNewRuleValue("");
      setRuleMsg("Rule added.");
      setShowRuleForm(false);
      refetchRules();
    } catch {
      setRuleMsg("Failed to add rule.");
    } finally {
      setBusy(null);
    }
  };

  const handleToggleRule = async (id: number, enabled: boolean) => {
    setBusy(`rule-toggle-${id}`);
    try {
      await toggleAlertRule(id, enabled);
      refetchRules();
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteRule = async (id: number) => {
    setBusy(`rule-del-${id}`);
    try {
      await deleteAlertRule(id);
      setConfirmDeleteId(null);
      refetchRules();
    } finally {
      setBusy(null);
    }
  };

  const clearFilters = () => {
    setFilterType("all");
    setFilterSearch("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterFreq("");
  };

  const hasActiveFilters =
    filterType !== "all" || filterSearch || filterDateFrom || filterDateTo || filterFreq;

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Alert Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">
            Monitor emergency and activity alerts across all frequencies
          </p>
        </div>
        <button
          onClick={() => { refetchAlerts(); refetchRules(); }}
          className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded border border-gray-600 hover:border-gray-500 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* ── Summary Cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard
          label="Total Alerts"
          value={stats.total}
          accent="text-white"
        />
        <SummaryCard
          label="Today"
          value={stats.alertsToday}
          accent={stats.alertsToday > 0 ? "text-yellow-400" : "text-gray-500"}
        />
        <SummaryCard
          label="This Week"
          value={stats.alertsThisWeek}
          accent={stats.alertsThisWeek > 0 ? "text-cyan-400" : "text-gray-500"}
        />
        <SummaryCard
          label="Most Triggered"
          value={stats.topCount > 0 ? stats.topCount.toString() : "--"}
          sub={stats.topRule}
          accent={stats.topCount > 0 ? "text-orange-400" : "text-gray-500"}
        />
      </div>

      {/* ── Active Alert Rules ─────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setRulesExpanded(!rulesExpanded)}
            className="flex items-center gap-2 text-base font-semibold hover:text-gray-300 transition-colors"
          >
            <span className={`text-xs text-gray-400 transition-transform ${rulesExpanded ? "rotate-90" : ""}`}>
              &#9654;
            </span>
            Active Alert Rules
            {rulesData && (
              <span className="text-xs font-normal text-gray-500 ml-1">
                ({rulesData.items.length} rules)
              </span>
            )}
          </button>
          <button
            onClick={() => setShowRuleForm(!showRuleForm)}
            className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-xs font-medium transition-colors"
          >
            {showRuleForm ? "Cancel" : "+ Add Rule"}
          </button>
        </div>

        {/* Inline add form */}
        {showRuleForm && (
          <form onSubmit={handleAddRule} className="flex flex-wrap gap-2 mb-4 items-end bg-gray-900 rounded-lg p-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Type</label>
              <select
                value={newRuleType}
                onChange={(e) => setNewRuleType(e.target.value as "keyword" | "callsign")}
                className="bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-yellow-600"
              >
                <option value="keyword">Keyword</option>
                <option value="callsign">Callsign</option>
              </select>
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs text-gray-400 mb-1">Pattern</label>
              <input
                type="text"
                value={newRuleValue}
                onChange={(e) => setNewRuleValue(e.target.value)}
                placeholder={newRuleType === "callsign" ? "N0CALL" : "emergency"}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-yellow-600"
                required
              />
            </div>
            <button
              type="submit"
              disabled={busy === "rule-add" || !newRuleValue.trim()}
              className="px-4 py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {busy === "rule-add" ? "Adding..." : "Create"}
            </button>
          </form>
        )}
        {ruleMsg && <p className="text-sm text-yellow-300 mb-3">{ruleMsg}</p>}

        {/* Rules list */}
        {rulesExpanded && (
          <>
            {rulesLoading && <p className="text-sm text-gray-400">Loading rules...</p>}
            {rulesData && rulesData.items.length > 0 ? (
              <div className="grid gap-2">
                {rulesData.items.map((rule) => (
                  <div
                    key={rule.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                      rule.enabled
                        ? "bg-gray-900 border-gray-700"
                        : "bg-gray-900/50 border-gray-800 opacity-60"
                    }`}
                  >
                    {/* Type badge */}
                    <span
                      className={`px-2 py-0.5 text-xs rounded font-medium shrink-0 ${
                        rule.rule_type === "callsign"
                          ? "bg-green-900 text-green-200"
                          : "bg-orange-900 text-orange-200"
                      }`}
                    >
                      {rule.rule_type}
                    </span>

                    {/* Value */}
                    <span className="font-mono text-sm text-white flex-1 min-w-0 truncate">
                      {rule.value}
                    </span>

                    {/* Notes */}
                    {rule.notes && (
                      <span className="text-xs text-gray-500 hidden sm:inline truncate max-w-[150px]">
                        {rule.notes}
                      </span>
                    )}

                    {/* Toggle */}
                    <button
                      onClick={() => handleToggleRule(rule.id, !rule.enabled)}
                      disabled={busy === `rule-toggle-${rule.id}`}
                      className={`text-xs px-2.5 py-1 rounded font-medium transition-colors shrink-0 ${
                        rule.enabled
                          ? "bg-green-900 text-green-300 hover:bg-green-800"
                          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                      } disabled:opacity-50`}
                    >
                      {rule.enabled ? "ON" : "OFF"}
                    </button>

                    {/* Delete */}
                    {confirmDeleteId === rule.id ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleDeleteRule(rule.id)}
                          disabled={busy === `rule-del-${rule.id}`}
                          className="text-xs px-2 py-1 bg-red-800 hover:bg-red-700 text-red-100 rounded disabled:opacity-50 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(rule.id)}
                        className="text-red-500 hover:text-red-400 text-xs shrink-0 transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : rulesData ? (
              <p className="text-sm text-gray-500">
                No DB rules configured. Using env var ALERT_KEYWORDS / ALERT_CALLSIGNS if set.
              </p>
            ) : null}
          </>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Filters
          </h2>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-xs text-gray-400 hover:text-white transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          {/* Type filter */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Match Type</label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as FilterType)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-700"
            >
              <option value="all">All types</option>
              <option value="keyword">Keywords only</option>
              <option value="callsign">Callsigns only</option>
            </select>
          </div>

          {/* Date from */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-700"
            />
          </div>

          {/* Date to */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">To</label>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-700"
            />
          </div>

          {/* Frequency */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Frequency</label>
            {availableFreqs.length > 0 ? (
              <select
                value={filterFreq}
                onChange={(e) => setFilterFreq(e.target.value)}
                className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-700"
              >
                <option value="">All frequencies</option>
                {availableFreqs.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={filterFreq}
                onChange={(e) => setFilterFreq(e.target.value)}
                placeholder="e.g. 146.520"
                className="w-32 bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-700"
              />
            )}
          </div>

          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-400 mb-1">Search transcripts</label>
            <input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Search in matched rules, transcripts, filenames..."
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-700"
            />
          </div>
        </div>

        {hasActiveFilters && (
          <div className="mt-2 text-xs text-gray-400">
            Showing {filteredAlerts.length} of {alerts.length} alerts
          </div>
        )}
      </div>

      {/* ── Alert Timeline ─────────────────────────────────────────── */}
      {alertsLoading && (
        <div className="text-center py-8 text-gray-400">Loading alerts...</div>
      )}
      {alertsError && (
        <div className="text-red-400 mb-4">
          Failed to load alerts: {String(alertsError)}
        </div>
      )}

      {alertData && filteredAlerts.length === 0 && (
        <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
          {hasActiveFilters
            ? "No alerts match the current filters."
            : "No alerts yet. Configure alert rules above or set ALERT_KEYWORDS / ALERT_CALLSIGNS to start receiving alerts."}
        </div>
      )}

      {alertData && filteredAlerts.length > 0 && (
        <div className="space-y-6">
          {TIME_GROUP_ORDER.map((groupKey) => {
            const items = grouped[groupKey];
            if (items.length === 0) return null;

            return (
              <div key={groupKey}>
                {/* Group header */}
                <div className="flex items-center gap-3 mb-3">
                  <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
                    {TIME_GROUP_LABELS[groupKey]}
                  </h3>
                  <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
                    {items.length}
                  </span>
                  <div className="flex-1 border-t border-gray-700" />
                </div>

                {/* Alert items */}
                <div className="space-y-2">
                  {items.map((alert) => {
                    const rs = resendStates[alert.id] ?? "idle";
                    const emergency = isEmergencyAlert(alert);
                    const mode = modeFromFilename(alert.filename);

                    return (
                      <div
                        key={alert.id}
                        className={`rounded-lg p-4 transition-colors ${
                          emergency
                            ? "bg-red-950/60 border border-red-900/50"
                            : hasCallsignMatch(alert)
                            ? "bg-gray-800 border-l-2 border-l-green-700"
                            : "bg-gray-800"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="flex-1 min-w-0">
                            {/* Top meta row */}
                            <div className="flex items-center gap-2 flex-wrap mb-2">
                              <span className="text-sm text-gray-400">
                                {alert.timestamp
                                  ? formatDateTime(alert.timestamp)
                                  : "--"}
                              </span>

                              {/* Mode badge */}
                              {mode && <ModeBadge mode={mode} />}

                              {/* Frequency label */}
                              {alert.frequency_label && (
                                <span className="text-sm text-cyan-400 font-medium">
                                  {alert.frequency_label}
                                </span>
                              )}
                              {!alert.frequency_label && alert.frequency_hz && (
                                <span className="text-sm text-gray-400">
                                  {formatFrequency(alert.frequency_hz)}
                                </span>
                              )}

                              {/* Emergency indicator */}
                              {emergency && (
                                <span className="text-xs px-2 py-0.5 bg-red-800 text-red-100 rounded font-bold uppercase tracking-wide animate-pulse">
                                  EMERGENCY
                                </span>
                              )}
                            </div>

                            {/* Matched rules */}
                            <div className="flex flex-wrap gap-1 mb-2">
                              {alert.matched.map((m) => (
                                <span
                                  key={m}
                                  className={`px-2 py-0.5 text-xs rounded font-mono ${matchBadgeClass(m)}`}
                                >
                                  {m}
                                </span>
                              ))}
                            </div>

                            {/* Transcript */}
                            {alert.transcript_excerpt && (
                              <p className="text-sm text-gray-300 line-clamp-2">
                                {alert.transcript_excerpt}
                              </p>
                            )}
                          </div>

                          {/* Action buttons */}
                          <div className="flex items-center gap-2 shrink-0">
                            {alert.recording_id && (
                              <Link
                                to={`/player/${alert.recording_id}`}
                                className="px-3 py-1.5 bg-blue-800 hover:bg-blue-700 rounded text-sm font-medium transition-colors flex items-center gap-1.5"
                              >
                                <svg
                                  className="w-3.5 h-3.5"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
                                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                                </svg>
                                Play
                              </Link>
                            )}
                            <button
                              onClick={() => handleResend(alert.id)}
                              disabled={rs === "sending"}
                              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                                rs === "ok"
                                  ? "bg-green-700 text-green-100"
                                  : rs === "err"
                                  ? "bg-red-800 text-red-200"
                                  : rs === "sending"
                                  ? "bg-gray-700 text-gray-400 cursor-wait"
                                  : "bg-gray-700 hover:bg-gray-600 text-gray-200"
                              }`}
                            >
                              {rs === "sending"
                                ? "Sending..."
                                : rs === "ok"
                                ? "Sent"
                                : rs === "err"
                                ? "Failed"
                                : "Resend"}
                            </button>
                          </div>
                        </div>

                        {/* Filename footer */}
                        {alert.filename && (
                          <div className="text-xs text-gray-600 mt-2 font-mono truncate">
                            {alert.filename}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default AlertsPage;
