import { useState } from "react";
import { formatDateTime, formatDate } from "../utils/time";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAdminStatus,
  syncRepeaters,
  backfillFrequency,
  getStorageStats,
  runRetention,
  listFrequencyLabels,
  createFrequencyLabel,
  deleteFrequencyLabel,
  getSdrHealth,
  bulkRetranscribe,
  listAlertRules,
  createAlertRule,
  deleteAlertRule,
  toggleAlertRule,
  testWebhook,
  getAlertDryRun,
  getDigestStatus,
  sendDigestNow,
  SdrHealth,
} from "../api/client";

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatFrequency(hz: number): string {
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(4)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function normalizeStateLabel(state: string): string {
  return state
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function AdminPage() {
  const queryClient = useQueryClient();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Retention
  const [retentionDays, setRetentionDays] = useState("90");
  const [retentionMode, setRetentionMode] = useState<"" | "voice" | "cw" | "aprs">("");
  const [retentionMsg, setRetentionMsg] = useState<string | null>(null);

  // Webhook test
  const [webhookTestMsg, setWebhookTestMsg] = useState<string | null>(null);

  // Alert dry-run
  const [dryRunResults, setDryRunResults] = useState<{ id: number; filename: string; matched_rule: string; timestamp: string | null }[] | null>(null);
  const [dryRunMsg, setDryRunMsg] = useState<string | null>(null);

  // Daily digest
  const [digestMsg, setDigestMsg] = useState<string | null>(null);
  const { data: digestStatus, refetch: refetchDigest } = useQuery({
    queryKey: ["digest-status"],
    queryFn: getDigestStatus,
    staleTime: 60_000,
  });

  // Frequency label form
  const [labelHz, setLabelHz] = useState("");
  const [labelBw, setLabelBw] = useState("5000");
  const [labelText, setLabelText] = useState("");
  const [labelMode, setLabelMode] = useState("");
  const [labelMsg, setLabelMsg] = useState<string | null>(null);

  const { data: status, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-status"],
    queryFn: getAdminStatus,
    refetchInterval: 30_000,
  });

  const { data: storage, refetch: refetchStorage } = useQuery({
    queryKey: ["admin-storage"],
    queryFn: getStorageStats,
    staleTime: 60_000,
  });

  const { data: freqLabels, refetch: refetchLabels } = useQuery({
    queryKey: ["freq-labels"],
    queryFn: listFrequencyLabels,
    staleTime: 30_000,
  });

  const { data: sdrHealth2m, refetch: refetchHealth2m } = useQuery({
    queryKey: ["sdr-health", "2m"],
    queryFn: () => getSdrHealth("2m"),
    refetchInterval: 60_000,
  });

  const { data: sdrHealth70cm, refetch: refetchHealth70cm } = useQuery({
    queryKey: ["sdr-health", "70cm"],
    queryFn: () => getSdrHealth("70cm"),
    refetchInterval: 60_000,
  });

  const [bulkRetranscribeMsg, setBulkRetranscribeMsg] = useState<string | null>(null);

  // Alert rules
  const [newRuleType, setNewRuleType] = useState<"keyword" | "callsign">("keyword");
  const [newRuleValue, setNewRuleValue] = useState("");
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);

  const { data: alertRules, refetch: refetchAlertRules } = useQuery({
    queryKey: ["alert-rules"],
    queryFn: listAlertRules,
    staleTime: 30_000,
  });

  const repeaterByStateRows = Object.entries(status?.repeaters_by_state ?? {}).reduce<
    { key: string; state: string; count: number }[]
  >((rows, [rawState, count]) => {
    const trimmed = rawState.trim();
    if (!trimmed) return rows;
    const key = trimmed.toLowerCase();
    const existing = rows.find((row) => row.key === key);
    if (existing) {
      existing.count += count;
      return rows;
    }
    rows.push({
      key,
      state: normalizeStateLabel(trimmed),
      count,
    });
    return rows;
  }, [])
    .sort((a, b) => b.count - a.count);
  const maxRepeatersByState = Math.max(...repeaterByStateRows.map((row) => row.count), 1);

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRuleValue.trim()) return;
    setBusy("rule-add");
    setRuleMsg(null);
    try {
      await createAlertRule({ rule_type: newRuleType, value: newRuleValue.trim() });
      setNewRuleValue("");
      setRuleMsg("Rule added.");
      refetchAlertRules();
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
      refetchAlertRules();
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteRule = async (id: number) => {
    setBusy(`rule-del-${id}`);
    try {
      await deleteAlertRule(id);
      refetchAlertRules();
    } finally {
      setBusy(null);
    }
  };

  const handleSendDigest = async () => {
    setBusy("digest");
    setDigestMsg(null);
    try {
      const res = await sendDigestNow();
      setDigestMsg(`Digest sent at ${formatDateTime(res.sent_at)}.`);
      refetchDigest();
    } catch {
      setDigestMsg("Failed to send digest — check that ALERT_WEBHOOK_URL is configured.");
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    setBusy("sync");
    setSyncMsg(null);
    try {
      const res = await syncRepeaters();
      setSyncMsg(`Sync ${res.status} — check back in a minute.`);
      setTimeout(() => {
        refetch();
        queryClient.invalidateQueries({ queryKey: ["stats"] });
      }, 5000);
    } catch {
      setSyncMsg("Sync request failed.");
    } finally {
      setBusy(null);
    }
  };

  const handleBackfill = async () => {
    setBusy("backfill");
    setBackfillMsg(null);
    try {
      const res = await backfillFrequency(1000);
      setBackfillMsg(`Scanned ${res.scanned} recordings, updated ${res.updated}.`);
      refetch();
    } catch {
      setBackfillMsg("Backfill request failed.");
    } finally {
      setBusy(null);
    }
  };

  const handleRetentionDryRun = async () => {
    const days = parseInt(retentionDays, 10);
    if (!days || days <= 0) return;
    setBusy("retention-dry");
    setRetentionMsg(null);
    try {
      const res = await runRetention(days, true, retentionMode || undefined);
      const modeStr = retentionMode ? ` (${retentionMode} only)` : "";
      setRetentionMsg(`Dry run: ${res.matched} recordings${modeStr} would be deleted (older than ${res.days} days, before ${formatDate(res.cutoff)}).`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRetentionMsg(`Failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRetentionRun = async () => {
    const days = parseInt(retentionDays, 10);
    if (!days || days <= 0) return;
    const modeStr = retentionMode ? ` ${retentionMode}` : "";
    if (!confirm(`Delete all${modeStr} recordings older than ${days} days? This cannot be undone.`)) return;
    setBusy("retention-run");
    setRetentionMsg(null);
    try {
      const res = await runRetention(days, false, retentionMode || undefined);
      setRetentionMsg(`Deleted ${res.deleted} recordings older than ${res.days} days.`);
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      refetchStorage();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRetentionMsg(`Failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const handleWebhookTest = async () => {
    setBusy("webhook-test");
    setWebhookTestMsg(null);
    try {
      const res = await testWebhook();
      setWebhookTestMsg(res.message ?? "Test sent successfully.");
    } catch {
      setWebhookTestMsg("Webhook test failed — check that ALERT_WEBHOOK_URL is configured.");
    } finally {
      setBusy(null);
    }
  };

  const handleAlertDryRun = async () => {
    setBusy("alert-dryrun");
    setDryRunMsg(null);
    setDryRunResults(null);
    try {
      const res = await getAlertDryRun();
      setDryRunResults(res.matches ?? []);
      setDryRunMsg(`${res.matches?.length ?? 0} recent recording(s) would trigger an alert.`);
    } catch {
      setDryRunMsg("Dry-run failed.");
    } finally {
      setBusy(null);
    }
  };

  const handleAddLabel = async (e: React.FormEvent) => {
    e.preventDefault();
    const hz = parseFloat(labelHz);
    if (!hz || !labelText.trim()) return;
    const hzFinal = hz < 1_000_000 ? hz * 1_000_000 : hz;
    setBusy("label-add");
    setLabelMsg(null);
    try {
      await createFrequencyLabel({
        frequency_hz: hzFinal,
        bandwidth_hz: parseFloat(labelBw) || 5000,
        label: labelText.trim(),
        mode: labelMode || undefined,
      });
      setLabelHz("");
      setLabelText("");
      setLabelMode("");
      setLabelMsg("Label added.");
      refetchLabels();
    } catch {
      setLabelMsg("Failed to add label.");
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteLabel = async (id: number) => {
    setBusy(`label-del-${id}`);
    try {
      await deleteFrequencyLabel(id);
      refetchLabels();
    } finally {
      setBusy(null);
    }
  };

  const handleBulkRetranscribe = async (noSpeechOnly: boolean) => {
    const msg = noSpeechOnly
      ? "Clear all [no speech detected] transcripts and re-queue for Whisper?"
      : "Clear ALL voice/CW transcripts and re-queue? This cannot be undone.";
    if (!confirm(msg)) return;
    setBusy("bulk-retranscribe");
    setBulkRetranscribeMsg(null);
    try {
      const res = await bulkRetranscribe(noSpeechOnly);
      setBulkRetranscribeMsg(
        `Cleared ${res.cleared} transcript${res.cleared !== 1 ? "s" : ""} — Whisper will re-process on next cycle.`
      );
      setTimeout(() => setBulkRetranscribeMsg(null), 8000);
      refetch();
    } catch {
      setBulkRetranscribeMsg("Bulk re-transcribe failed.");
    } finally {
      setBusy(null);
    }
  };

  const renderSdrHealth = (label: string, health?: SdrHealth) => (
    <div className="bg-gray-900 rounded-md p-3">
      <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">{label}</div>
      {health ? (
        <div className="flex items-center gap-3 text-sm flex-wrap">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              health.healthy
                ? "bg-green-900 text-green-300"
                : health.status === "no_files"
                ? "bg-gray-700 text-gray-400"
                : "bg-red-900 text-red-300"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                health.healthy
                  ? "bg-green-400 animate-pulse"
                  : health.status === "no_files"
                  ? "bg-gray-500"
                  : "bg-red-400"
              }`}
            />
            {health.healthy ? "Healthy" : health.status === "no_files" ? "No files" : "Stale"}
          </span>
          {health.last_seen_seconds != null && (
            <span className="text-gray-400">
              Last capture:{" "}
              <span className={health.healthy ? "text-green-300" : "text-yellow-300"}>
                {health.last_seen_seconds < 60
                  ? `${health.last_seen_seconds}s ago`
                  : health.last_seen_seconds < 3600
                  ? `${Math.round(health.last_seen_seconds / 60)}m ago`
                  : `${Math.round(health.last_seen_seconds / 3600)}h ago`}
              </span>
            </span>
          )}
          {health.last_seen_at && (
            <span className="text-gray-500 text-xs">{formatDateTime(health.last_seen_at)}</span>
          )}
        </div>
      ) : (
        <div className="text-gray-500 text-sm">Loading…</div>
      )}
    </div>
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Admin</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Repeater Sync */}
        <div className="bg-gray-800 rounded-lg p-5">
          <h2 className="text-base font-semibold mb-1">RepeaterBook Sync</h2>
          <p className="text-sm text-gray-400 mb-4">
            Fetch fresh repeater data for configured states. Runs automatically every 24 h.
          </p>
          <button
            onClick={handleSync}
            disabled={busy !== null}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-sm font-medium disabled:opacity-50"
          >
            {busy === "sync" ? "Starting…" : "Sync Repeaters Now"}
          </button>
          {syncMsg && <p className="mt-3 text-sm text-green-300">{syncMsg}</p>}
        </div>

        {/* Frequency Backfill */}
        <div className="bg-gray-800 rounded-lg p-5">
          <h2 className="text-base font-semibold mb-1">Backfill Frequency Labels</h2>
          <p className="text-sm text-gray-400 mb-4">
            Re-run frequency lookup on recordings missing a label. Run after a repeater sync.
          </p>
          <button
            onClick={handleBackfill}
            disabled={busy !== null}
            className="px-4 py-2 bg-indigo-700 hover:bg-indigo-600 rounded text-sm font-medium disabled:opacity-50"
          >
            {busy === "backfill" ? "Running…" : "Backfill Frequency Labels"}
          </button>
          {backfillMsg && <p className="mt-3 text-sm text-indigo-300">{backfillMsg}</p>}
        </div>
      </div>

      {/* Storage */}
      {storage && (
        <div className="bg-gray-800 rounded-lg p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold">Disk Usage</h2>
            <button onClick={() => refetchStorage()} className="text-xs text-gray-400 hover:text-white">Refresh</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-gray-400 text-xs mb-0.5">Audio</div>
              <div className="font-medium">{formatBytes(storage.audio_bytes)}</div>
              <div className="text-xs text-gray-500">{storage.audio_files.toLocaleString()} files</div>
            </div>
            <div>
              <div className="text-gray-400 text-xs mb-0.5">Cache</div>
              <div className="font-medium">{formatBytes(storage.cache_bytes)}</div>
            </div>
            <div>
              <div className="text-gray-400 text-xs mb-0.5">Free</div>
              <div className="font-medium">{formatBytes(storage.free_bytes)}</div>
            </div>
            <div>
              <div className="text-gray-400 text-xs mb-0.5">Total disk</div>
              <div className="font-medium">{formatBytes(storage.total_bytes)}</div>
            </div>
          </div>
          {storage.total_bytes > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Used: {formatBytes(storage.total_bytes - storage.free_bytes)}</span>
                <span>{Math.round(((storage.total_bytes - storage.free_bytes) / storage.total_bytes) * 100)}%</span>
              </div>
              <div className="h-2 bg-gray-700 rounded">
                <div
                  className="h-2 bg-sky-600 rounded"
                  style={{ width: `${Math.round(((storage.total_bytes - storage.free_bytes) / storage.total_bytes) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Retention */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Recording Retention</h2>
        <p className="text-sm text-gray-400 mb-4">
          Delete recordings older than N days to free up disk space.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">Days:</label>
            <input
              type="number"
              min="1"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              className="w-20 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">Mode:</label>
            <select
              value={retentionMode}
              onChange={(e) => setRetentionMode(e.target.value as typeof retentionMode)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="voice">Voice</option>
              <option value="cw">CW</option>
              <option value="aprs">APRS</option>
            </select>
          </div>
          <button
            onClick={handleRetentionDryRun}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium disabled:opacity-50"
          >
            {busy === "retention-dry" ? "Checking…" : "Dry Run"}
          </button>
          <button
            onClick={handleRetentionRun}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm font-medium disabled:opacity-50"
          >
            {busy === "retention-run" ? "Deleting…" : "Delete Old Recordings"}
          </button>
        </div>
        {retentionMsg && (
          <p className="mt-3 text-sm text-yellow-300">{retentionMsg}</p>
        )}
      </div>

      {/* Frequency Labels */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Custom Frequency Labels</h2>
        <p className="text-sm text-gray-400 mb-4">
          Override or supplement known_freqs.py with custom labels stored in the database.
        </p>

        <form onSubmit={handleAddLabel} className="flex flex-wrap gap-2 mb-4 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Frequency (Hz or MHz)</label>
            <input
              type="number"
              step="any"
              value={labelHz}
              onChange={(e) => setLabelHz(e.target.value)}
              placeholder="146.52 or 146520000"
              className="w-40 bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Tolerance (Hz)</label>
            <input
              type="number"
              value={labelBw}
              onChange={(e) => setLabelBw(e.target.value)}
              className="w-24 bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Label</label>
            <input
              type="text"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              placeholder="e.g. 2m Simplex Calling"
              className="w-52 bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Mode</label>
            <select
              value={labelMode}
              onChange={(e) => setLabelMode(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm"
            >
              <option value="">Any</option>
              <option value="voice">Voice</option>
              <option value="cw">CW</option>
              <option value="aprs">APRS</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={busy !== null}
            className="px-3 py-1.5 bg-sky-700 hover:bg-sky-600 rounded text-sm font-medium disabled:opacity-50"
          >
            Add Label
          </button>
        </form>
        {labelMsg && <p className="text-sm text-sky-300 mb-3">{labelMsg}</p>}

        {freqLabels && freqLabels.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                  <th className="text-left py-2 pr-4">Frequency</th>
                  <th className="text-left py-2 pr-4">Tolerance</th>
                  <th className="text-left py-2 pr-4">Label</th>
                  <th className="text-left py-2 pr-4">Mode</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {freqLabels.items.map((fl) => (
                  <tr key={fl.id}>
                    <td className="py-2 pr-4 tabular-nums">{formatFrequency(fl.frequency_hz)}</td>
                    <td className="py-2 pr-4 text-gray-400">±{fl.bandwidth_hz ?? 5000} Hz</td>
                    <td className="py-2 pr-4 text-cyan-300">{fl.label}</td>
                    <td className="py-2 pr-4 text-gray-400">{fl.mode ?? "any"}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleDeleteLabel(fl.id)}
                        disabled={busy === `label-del-${fl.id}`}
                        className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {freqLabels && freqLabels.items.length === 0 && (
          <p className="text-sm text-gray-500">No custom labels yet.</p>
        )}
      </div>

      {/* SDR Health */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">SDR Capture Health</h2>
          <button
            onClick={() => {
              refetchHealth2m();
              refetchHealth70cm();
            }}
            className="text-xs text-gray-400 hover:text-white"
          >
            Refresh
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {renderSdrHealth("2m", sdrHealth2m)}
          {renderSdrHealth("70cm", sdrHealth70cm)}
        </div>
      </div>

      {/* Bulk Re-transcribe */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Bulk Re-transcribe</h2>
        <p className="text-sm text-gray-400 mb-4">
          Re-queue recordings for Whisper transcription. Use "No speech only" to retry
          recordings that returned [no speech detected].
        </p>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => handleBulkRetranscribe(true)}
            disabled={busy !== null}
            className="px-4 py-2 bg-yellow-700 hover:bg-yellow-600 rounded text-sm font-medium disabled:opacity-50"
          >
            {busy === "bulk-retranscribe" ? "Running…" : "Re-transcribe [no speech] only"}
          </button>
          <button
            onClick={() => handleBulkRetranscribe(false)}
            disabled={busy !== null}
            className="px-4 py-2 bg-orange-700 hover:bg-orange-600 rounded text-sm font-medium disabled:opacity-50"
          >
            Re-transcribe ALL voice/CW
          </button>
        </div>
        {bulkRetranscribeMsg && (
          <p className="mt-3 text-sm text-green-300">{bulkRetranscribeMsg}</p>
        )}
      </div>

      {/* Alert Rules */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Alert Rules</h2>
        <p className="text-sm text-gray-400 mb-4">
          Watch for keywords or callsigns in transcripts. DB rules override env vars.
          Matches fire the configured webhook.
        </p>

        <form onSubmit={handleAddRule} className="flex flex-wrap gap-2 mb-4 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Type</label>
            <select
              value={newRuleType}
              onChange={(e) => setNewRuleType(e.target.value as "keyword" | "callsign")}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm"
            >
              <option value="keyword">Keyword</option>
              <option value="callsign">Callsign</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Value</label>
            <input
              type="text"
              value={newRuleValue}
              onChange={(e) => setNewRuleValue(e.target.value)}
              placeholder={newRuleType === "callsign" ? "N0CALL" : "emergency"}
              className="w-44 bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm"
              required
            />
          </div>
          <button
            type="submit"
            disabled={busy !== null || !newRuleValue.trim()}
            className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 rounded text-sm font-medium disabled:opacity-50"
          >
            Add Rule
          </button>
        </form>
        {ruleMsg && <p className="text-sm text-yellow-300 mb-3">{ruleMsg}</p>}

        {alertRules && alertRules.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                  <th className="text-left py-2 pr-4">Type</th>
                  <th className="text-left py-2 pr-4">Value</th>
                  <th className="text-left py-2 pr-4">Enabled</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {alertRules.items.map((rule) => (
                  <tr key={rule.id}>
                    <td className="py-2 pr-4">
                      <span className={`px-1.5 py-0.5 text-xs rounded ${
                        rule.rule_type === "callsign"
                          ? "bg-purple-900 text-purple-200"
                          : "bg-yellow-900 text-yellow-200"
                      }`}>
                        {rule.rule_type}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-white">{rule.value}</td>
                    <td className="py-2 pr-4">
                      <button
                        onClick={() => handleToggleRule(rule.id, !rule.enabled)}
                        disabled={busy === `rule-toggle-${rule.id}`}
                        className={`text-xs px-2 py-0.5 rounded ${
                          rule.enabled
                            ? "bg-green-900 text-green-300 hover:bg-green-800"
                            : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                        } disabled:opacity-50`}
                      >
                        {rule.enabled ? "On" : "Off"}
                      </button>
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        disabled={busy === `rule-del-${rule.id}`}
                        className="text-red-400 hover:text-red-300 text-xs disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No DB rules — using env var ALERT_KEYWORDS / ALERT_CALLSIGNS.
          </p>
        )}
      </div>

      {/* Webhook Test */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Webhook Test</h2>
        <p className="text-sm text-gray-400 mb-4">
          Send a test alert to the configured webhook URL to verify delivery.
        </p>
        <button
          onClick={handleWebhookTest}
          disabled={busy !== null}
          className="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded text-sm font-medium disabled:opacity-50"
        >
          {busy === "webhook-test" ? "Sending…" : "Send Test Alert"}
        </button>
        {webhookTestMsg && (
          <p className="mt-3 text-sm text-purple-300">{webhookTestMsg}</p>
        )}
      </div>

      {/* Alert Dry-Run */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Alert Dry-Run</h2>
        <p className="text-sm text-gray-400 mb-4">
          Check the last 500 recordings against current alert rules — without firing any webhooks.
        </p>
        <button
          onClick={handleAlertDryRun}
          disabled={busy !== null}
          className="px-4 py-2 bg-yellow-800 hover:bg-yellow-700 rounded text-sm font-medium disabled:opacity-50"
        >
          {busy === "alert-dryrun" ? "Checking…" : "Run Dry-Run"}
        </button>
        {dryRunMsg && <p className="mt-3 text-sm text-yellow-300">{dryRunMsg}</p>}
        {dryRunResults && dryRunResults.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                  <th className="text-left py-2 pr-4">File</th>
                  <th className="text-left py-2 pr-4">Matched Rule</th>
                  <th className="text-left py-2">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {dryRunResults.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-4 font-mono text-xs text-green-300">{r.filename}</td>
                    <td className="py-1.5 pr-4 text-yellow-200 text-xs">{r.matched_rule}</td>
                    <td className="py-1.5 text-gray-400 text-xs">{r.timestamp ? formatDateTime(r.timestamp) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Daily Digest */}
      <div className="bg-gray-800 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Daily Digest</h2>
        <p className="text-sm text-gray-400 mb-4">
          Send the daily summary webhook immediately. Normally fires automatically once per 24 h.
        </p>
        <div className="flex items-center gap-4 mb-4">
          {digestStatus?.last_sent ? (
            <span className="text-sm text-gray-300">
              Last sent:{" "}
              <span className="text-green-300">{formatDateTime(digestStatus.last_sent)}</span>
            </span>
          ) : (
            <span className="text-sm text-gray-500">Never sent this session.</span>
          )}
        </div>
        <button
          onClick={handleSendDigest}
          disabled={busy !== null}
          className="px-4 py-2 bg-teal-700 hover:bg-teal-600 rounded text-sm font-medium disabled:opacity-50"
        >
          {busy === "digest" ? "Sending…" : "Send Digest Now"}
        </button>
        {digestMsg && <p className="mt-3 text-sm text-teal-300">{digestMsg}</p>}
      </div>

      {/* Status */}
      <div className="bg-gray-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">System Status</h2>
          <button onClick={() => refetch()} className="text-xs text-gray-400 hover:text-white">
            Refresh
          </button>
        </div>

        {isLoading && <div className="text-gray-400 text-sm">Loading…</div>}
        {error && <div className="text-red-400 text-sm">Failed: {String(error)}</div>}

        {status && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total recordings</span>
                  <span>{status.total_recordings.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Pending freq label</span>
                  <span className={status.pending_freq_label > 0 ? "text-yellow-400" : "text-green-400"}>
                    {status.pending_freq_label}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Pending AI tags</span>
                  <span className={status.pending_ai_tags > 0 ? "text-yellow-400" : "text-green-400"}>
                    {status.pending_ai_tags}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Pending transcripts</span>
                  <span className={status.pending_transcripts > 0 ? "text-yellow-400" : "text-green-400"}>
                    {status.pending_transcripts ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Known repeaters</span>
                  <span>{status.total_repeaters.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Last repeater sync</span>
                  <span className="text-right">
                    {status.last_repeater_sync
                      ? formatDateTime(status.last_repeater_sync)
                      : "Never"}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs text-gray-400 mb-2">Repeaters by state</div>
              <div className="space-y-1">
                {repeaterByStateRows.length === 0 ? (
                  <div className="text-gray-500 text-sm">No repeater state data</div>
                ) : (
                  repeaterByStateRows.map(({ key, state, count }) => (
                    <div key={key} className="flex items-center gap-2 text-sm min-w-0">
                      <span className="w-24 sm:w-28 shrink-0 truncate text-gray-300 font-mono" title={state}>
                        {state}
                      </span>
                      <div className="flex-1 bg-gray-700 rounded h-2">
                        <div
                          className="bg-green-700 h-2 rounded"
                          style={{
                            width: `${Math.round((count / maxRepeatersByState) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="text-gray-400 text-xs w-12 text-right shrink-0">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminPage;
