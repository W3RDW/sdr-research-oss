import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listBookmarks,
  createBookmark,
  updateBookmark,
  deleteBookmark,
  FrequencyBookmark,
} from "../api/client";

function freqLabel(hz: number): string {
  return `${(hz / 1_000_000).toFixed(4)} MHz`;
}

function BookmarkRow({
  bm,
  onDelete,
  onToggleAlert,
}: {
  bm: FrequencyBookmark;
  onDelete: (id: number) => void;
  onToggleAlert: (id: number, val: boolean) => void;
}) {
  return (
    <tr className="border-b border-gray-700 hover:bg-gray-700/30">
      <td className="py-2 pr-4 font-mono text-green-300 whitespace-nowrap">
        {freqLabel(bm.frequency_hz)}
      </td>
      <td className="py-2 pr-4 font-mono text-gray-400 text-xs">
        ±{(bm.bandwidth_hz / 1000).toFixed(1)} kHz
      </td>
      <td className="py-2 pr-4 text-gray-100">{bm.label}</td>
      <td className="py-2 pr-4 text-gray-400 text-sm max-w-xs truncate">
        {bm.notes || "—"}
      </td>
      <td className="py-2 pr-4">
        <button
          onClick={() => onToggleAlert(bm.id, !bm.alert_on_activity)}
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            bm.alert_on_activity
              ? "bg-orange-800 text-orange-200"
              : "bg-gray-700 text-gray-400"
          }`}
          title="Toggle activity webhook alert"
        >
          {bm.alert_on_activity ? "Alert ON" : "Alert OFF"}
        </button>
      </td>
      <td className="py-2">
        <button
          onClick={() => onDelete(bm.id)}
          className="px-2 py-0.5 rounded text-xs bg-red-900/50 text-red-300 hover:bg-red-800"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

export default function BookmarksPage() {
  const qc = useQueryClient();
  const [freqInput, setFreqInput] = useState("");
  const [bwInput, setBwInput] = useState("5");
  const [labelInput, setLabelInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [alertInput, setAlertInput] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["bookmarks"],
    queryFn: listBookmarks,
    staleTime: 30_000,
  });

  const createMut = useMutation({
    mutationFn: createBookmark,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookmarks"] });
      setFreqInput("");
      setLabelInput("");
      setNotesInput("");
      setAlertInput(false);
      setFormError(null);
    },
    onError: (e: any) => setFormError(e?.response?.data?.detail ?? String(e)),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<FrequencyBookmark> }) =>
      updateBookmark(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookmarks"] }),
  });

  const deleteMut = useMutation({
    mutationFn: deleteBookmark,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookmarks"] }),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const hz = parseFloat(freqInput) * 1_000_000;
    if (isNaN(hz) || hz <= 0) {
      setFormError("Enter a valid frequency in MHz");
      return;
    }
    if (!labelInput.trim()) {
      setFormError("Label is required");
      return;
    }
    createMut.mutate({
      frequency_hz: hz,
      bandwidth_hz: parseFloat(bwInput) * 1000 || 5000,
      label: labelInput.trim(),
      notes: notesInput.trim() || undefined,
      alert_on_activity: alertInput,
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Frequency Bookmarks</h1>
        <span className="text-sm text-gray-400">
          {data?.items.length ?? 0} saved
        </span>
      </div>

      {/* Add form */}
      <div className="bg-gray-800 rounded-lg p-4 mb-6">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Add Bookmark</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Frequency (MHz)</label>
            <input
              type="number"
              step="0.0001"
              placeholder="145.2300"
              value={freqInput}
              onChange={(e) => setFreqInput(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm w-36 font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Tolerance (kHz)</label>
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="100"
              value={bwInput}
              onChange={(e) => setBwInput(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm w-24 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-48">
            <label className="text-xs text-gray-400">Label</label>
            <input
              type="text"
              placeholder="2m Repeater W1ABC"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm"
              required
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-48">
            <label className="text-xs text-gray-400">Notes (optional)</label>
            <input
              type="text"
              placeholder="PL 100 Hz, linked to AllStar"
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">Alert on Activity</label>
            <label className="flex items-center gap-2 h-8 cursor-pointer">
              <input
                type="checkbox"
                checked={alertInput}
                onChange={(e) => setAlertInput(e.target.checked)}
                className="accent-orange-500"
              />
              <span className="text-sm text-gray-300">Webhook</span>
            </label>
          </div>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="px-4 py-2 rounded bg-green-700 hover:bg-green-600 text-sm font-medium disabled:opacity-50"
          >
            {createMut.isPending ? "Saving…" : "Add"}
          </button>
        </form>
        {formError && (
          <p className="text-red-400 text-xs mt-2">{formError}</p>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-gray-400 text-sm">Loading…</div>
      ) : !data?.items.length ? (
        <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400 text-sm">
          No bookmarks yet. Add a frequency above to get started.
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 uppercase border-b border-gray-700">
                <th className="text-left py-2 pr-4 pl-4">Frequency</th>
                <th className="text-left py-2 pr-4">Tolerance</th>
                <th className="text-left py-2 pr-4">Label</th>
                <th className="text-left py-2 pr-4">Notes</th>
                <th className="text-left py-2 pr-4">Alert</th>
                <th className="text-left py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((bm) => (
                <BookmarkRow
                  key={bm.id}
                  bm={bm}
                  onDelete={(id) => deleteMut.mutate(id)}
                  onToggleAlert={(id, val) =>
                    updateMut.mutate({ id, body: { alert_on_activity: val } })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500 mt-4">
        Bookmarks with "Alert ON" fire the configured webhook whenever a
        recording is indexed on that frequency.
      </p>
    </div>
  );
}
