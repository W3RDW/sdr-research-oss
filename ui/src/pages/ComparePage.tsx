import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useState, useRef, useCallback, useEffect } from "react";
import {
  getFile,
  getStreamUrl,
  getWaveform,
  browseFiles,
  Recording,
} from "../api/client";
import AudioPlayer from "../components/Player/AudioPlayer";
import { formatDateTime } from "../utils/time";

function formatFrequency(hz: number | null): string {
  if (!hz) return "Unknown";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

function formatDuration(s: number | null): string {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Modal to search/pick a recording by ID or frequency text */
function RecordingPicker({
  onPick,
  onClose,
  excludeId,
}: {
  onPick: (id: number) => void;
  onClose: () => void;
  excludeId?: number;
}) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"id" | "search">("search");
  const [idInput, setIdInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [searchMode]);

  const { data: results, isFetching } = useQuery({
    queryKey: ["compare-search", query],
    queryFn: () => browseFiles({ q: query, limit: 20, page: 1 }),
    enabled: searchMode === "search" && query.length >= 2,
    staleTime: 30_000,
  });

  const filteredItems = results?.items.filter((r) => r.id !== excludeId) ?? [];

  const handleIdSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(idInput, 10);
    if (!isNaN(parsed) && parsed > 0) {
      onPick(parsed);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col shadow-xl border border-gray-700">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-medium">Pick a recording to compare</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setSearchMode("search")}
            className={`flex-1 py-2 text-sm font-medium ${
              searchMode === "search"
                ? "text-green-400 border-b-2 border-green-400"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Search
          </button>
          <button
            onClick={() => setSearchMode("id")}
            className={`flex-1 py-2 text-sm font-medium ${
              searchMode === "id"
                ? "text-green-400 border-b-2 border-green-400"
                : "text-gray-400 hover:text-white"
            }`}
          >
            By ID
          </button>
        </div>

        <div className="p-4">
          {searchMode === "search" ? (
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by frequency, transcript, tag..."
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
              autoFocus
            />
          ) : (
            <form onSubmit={handleIdSubmit} className="flex gap-2">
              <input
                ref={inputRef}
                type="number"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="Recording ID"
                className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm"
                min={1}
                autoFocus
              />
              <button
                type="submit"
                disabled={!idInput.trim()}
                className="px-4 py-2 bg-green-700 hover:bg-green-600 rounded text-sm font-medium disabled:opacity-50"
              >
                Go
              </button>
            </form>
          )}
        </div>

        {/* Results */}
        {searchMode === "search" && (
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {isFetching && (
              <div className="text-gray-500 text-sm py-4 text-center">
                Searching...
              </div>
            )}
            {!isFetching && query.length >= 2 && filteredItems.length === 0 && (
              <div className="text-gray-500 text-sm py-4 text-center">
                No recordings found
              </div>
            )}
            {filteredItems.map((r) => (
              <button
                key={r.id}
                onClick={() => onPick(r.id)}
                className="w-full text-left px-3 py-2 hover:bg-gray-700 rounded flex items-center gap-3 text-sm border-b border-gray-700/50 last:border-0"
              >
                <span className="text-gray-500 font-mono text-xs w-10 shrink-0">
                  #{r.id}
                </span>
                <span
                  className={`shrink-0 px-1.5 py-0.5 text-xs rounded ${
                    r.mode === "cw"
                      ? "bg-yellow-900 text-yellow-200"
                      : "bg-blue-900 text-blue-200"
                  }`}
                >
                  {r.mode.toUpperCase()}
                </span>
                <span className="text-cyan-400 text-xs shrink-0">
                  {r.frequency_label ?? formatFrequency(r.frequency_hz)}
                </span>
                <span className="text-gray-400 text-xs truncate flex-1">
                  {r.timestamp ? formatDateTime(r.timestamp) : ""}
                </span>
                <span className="text-gray-500 text-xs shrink-0">
                  {formatDuration(r.duration_seconds)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One side of the comparison */
function ComparePanel({
  recording,
  waveformData,
  label,
  onSwap,
}: {
  recording: Recording;
  waveformData: { peaks: [number, number][]; duration: number } | undefined;
  label: string;
  onSwap?: () => void;
}) {
  const [currentTime, setCurrentTime] = useState(0);

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-bold px-2 py-1 rounded bg-gray-700 text-gray-300">
          {label}
        </span>
        <Link
          to={`/player/${recording.id}`}
          className="text-green-400 hover:text-green-300 text-xs"
        >
          #{recording.id}
        </Link>
        {onSwap && (
          <button
            onClick={onSwap}
            className="ml-auto text-xs text-gray-400 hover:text-white px-2 py-0.5 bg-gray-700 rounded"
            title="Swap sides"
          >
            Swap
          </button>
        )}
      </div>

      {/* Metadata */}
      <div className="mb-3 space-y-1">
        <h3 className="text-sm font-medium truncate" title={recording.filename}>
          {recording.filename}
        </h3>
        <div className="flex flex-wrap gap-2 text-xs text-gray-400">
          <span
            className={`inline-flex px-1.5 py-0.5 rounded font-medium ${
              recording.mode === "cw"
                ? "bg-yellow-900 text-yellow-200"
                : "bg-blue-900 text-blue-200"
            }`}
          >
            {recording.mode.toUpperCase()}
          </span>
          <span className="text-cyan-400">
            {recording.frequency_label ?? formatFrequency(recording.frequency_hz)}
          </span>
          {recording.timestamp && (
            <span>{formatDateTime(recording.timestamp)}</span>
          )}
          <span>{formatDuration(recording.duration_seconds)}</span>
        </div>
        {recording.tags && recording.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {recording.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex px-1.5 py-0.5 text-xs rounded bg-sky-900 text-sky-100"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Player */}
      <div className="bg-gray-900 rounded-lg p-3 mb-3">
        <AudioPlayer
          src={getStreamUrl(recording.id)}
          recordingId={recording.id}
          onTimeUpdate={setCurrentTime}
          peaks={waveformData?.peaks}
          audioDuration={waveformData?.duration}
        />
      </div>

      {/* Transcript excerpt */}
      <div className="bg-gray-900 rounded-lg p-3">
        <h4 className="text-xs font-medium text-gray-400 mb-1">Transcript</h4>
        {recording.transcript ? (
          <p className="text-sm text-gray-300 leading-relaxed line-clamp-6">
            {recording.transcript}
          </p>
        ) : recording.transcript_status === "pending" ? (
          <p className="text-sm text-yellow-500 italic">Pending transcription...</p>
        ) : (
          <p className="text-sm text-gray-500 italic">No transcript available</p>
        )}
        {recording.transcript && currentTime > 0 && (
          <div className="text-xs text-gray-500 mt-1">
            Playback: {formatDuration(currentTime)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Row for the metadata comparison table */
function CompareRow({
  label,
  leftVal,
  rightVal,
  highlight,
}: {
  label: string;
  leftVal: string;
  rightVal: string;
  highlight?: boolean;
}) {
  const isDifferent =
    highlight !== false && leftVal !== rightVal && leftVal !== "—" && rightVal !== "—";
  const cellCls = isDifferent
    ? "bg-yellow-900/30 text-yellow-200"
    : "text-gray-300";

  return (
    <tr className="border-b border-gray-700/50 last:border-0">
      <td className="py-1.5 px-3 text-xs text-gray-400 font-medium whitespace-nowrap">
        {label}
      </td>
      <td className={`py-1.5 px-3 text-xs ${cellCls}`}>{leftVal}</td>
      <td className={`py-1.5 px-3 text-xs ${cellCls}`}>{rightVal}</td>
    </tr>
  );
}

function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const leftId = searchParams.get("left");
  const rightId = searchParams.get("right");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickingSide, setPickingSide] = useState<"left" | "right">("right");

  // Fetch left recording
  const {
    data: leftRecording,
    isLoading: leftLoading,
    error: leftError,
  } = useQuery({
    queryKey: ["file", leftId],
    queryFn: () => getFile(Number(leftId)),
    enabled: !!leftId,
  });

  // Fetch right recording
  const {
    data: rightRecording,
    isLoading: rightLoading,
    error: rightError,
  } = useQuery({
    queryKey: ["file", rightId],
    queryFn: () => getFile(Number(rightId)),
    enabled: !!rightId,
  });

  // Waveforms
  const { data: leftWaveform } = useQuery({
    queryKey: ["waveform", leftId],
    queryFn: () => getWaveform(Number(leftId)),
    enabled: !!leftId,
    staleTime: 10 * 60 * 1000,
  });

  const { data: rightWaveform } = useQuery({
    queryKey: ["waveform", rightId],
    queryFn: () => getWaveform(Number(rightId)),
    enabled: !!rightId,
    staleTime: 10 * 60 * 1000,
  });

  const openPicker = useCallback(
    (side: "left" | "right") => {
      setPickingSide(side);
      setPickerOpen(true);
    },
    []
  );

  const handlePick = useCallback(
    (id: number) => {
      setPickerOpen(false);
      const params = new URLSearchParams(searchParams);
      params.set(pickingSide, String(id));
      setSearchParams(params);
    },
    [pickingSide, searchParams, setSearchParams]
  );

  const handleSwap = useCallback(() => {
    if (!leftId || !rightId) return;
    const params = new URLSearchParams();
    params.set("left", rightId);
    params.set("right", leftId);
    setSearchParams(params);
  }, [leftId, rightId, setSearchParams]);

  // If no recordings selected at all, show picker prompt
  if (!leftId && !rightId) {
    return (
      <div className="text-center py-16">
        <h1 className="text-2xl font-bold mb-4">Compare Recordings</h1>
        <p className="text-gray-400 mb-6">
          Select two recordings to compare side by side.
        </p>
        <div className="flex justify-center gap-4">
          <button
            onClick={() => openPicker("left")}
            className="px-6 py-3 bg-green-700 hover:bg-green-600 rounded-lg text-sm font-medium"
          >
            Pick Recording A
          </button>
        </div>
        {pickerOpen && (
          <RecordingPicker
            onPick={handlePick}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  const isLoading = (leftId && leftLoading) || (rightId && rightLoading);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/browse" className="text-gray-400 hover:text-white text-sm">
            &larr; Back to browse
          </Link>
          <h1 className="text-2xl font-bold mt-1">Compare Recordings</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => openPicker("left")}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm"
          >
            Change A
          </button>
          <button
            onClick={() => openPicker("right")}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm"
          >
            {rightId ? "Change B" : "Pick B"}
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="text-center py-8 text-gray-400">Loading recordings...</div>
      )}

      {leftError && (
        <div className="text-red-400 mb-4">
          Failed to load recording A (#{leftId}): {String(leftError)}
        </div>
      )}
      {rightError && (
        <div className="text-red-400 mb-4">
          Failed to load recording B (#{rightId}): {String(rightError)}
        </div>
      )}

      {/* Side-by-side panels */}
      <div className="flex gap-6 flex-col lg:flex-row">
        {/* Left panel */}
        {leftRecording ? (
          <ComparePanel
            recording={leftRecording}
            waveformData={leftWaveform}
            label="A"
            onSwap={rightRecording ? handleSwap : undefined}
          />
        ) : !leftId ? (
          <div className="flex-1 min-w-0 flex items-center justify-center bg-gray-800 rounded-lg p-8">
            <button
              onClick={() => openPicker("left")}
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-gray-300"
            >
              Pick Recording A
            </button>
          </div>
        ) : null}

        {/* Divider */}
        <div className="hidden lg:flex items-stretch">
          <div className="w-px bg-gray-700" />
        </div>
        <div className="lg:hidden border-t border-gray-700" />

        {/* Right panel */}
        {rightRecording ? (
          <ComparePanel
            recording={rightRecording}
            waveformData={rightWaveform}
            label="B"
          />
        ) : (
          <div className="flex-1 min-w-0 flex items-center justify-center bg-gray-800 rounded-lg p-8">
            <button
              onClick={() => openPicker("right")}
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-gray-300"
            >
              Pick Recording B
            </button>
          </div>
        )}
      </div>

      {/* Metadata comparison table */}
      {leftRecording && rightRecording && (
        <div className="mt-6 bg-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-medium mb-3">Metadata Comparison</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-600">
                  <th className="py-2 px-3 text-xs text-gray-500 font-medium w-32">
                    Field
                  </th>
                  <th className="py-2 px-3 text-xs text-gray-500 font-medium">
                    A (#{leftRecording.id})
                  </th>
                  <th className="py-2 px-3 text-xs text-gray-500 font-medium">
                    B (#{rightRecording.id})
                  </th>
                </tr>
              </thead>
              <tbody>
                <CompareRow
                  label="Mode"
                  leftVal={leftRecording.mode.toUpperCase()}
                  rightVal={rightRecording.mode.toUpperCase()}
                />
                <CompareRow
                  label="Frequency"
                  leftVal={
                    leftRecording.frequency_label ??
                    formatFrequency(leftRecording.frequency_hz)
                  }
                  rightVal={
                    rightRecording.frequency_label ??
                    formatFrequency(rightRecording.frequency_hz)
                  }
                />
                <CompareRow
                  label="Frequency (Hz)"
                  leftVal={
                    leftRecording.frequency_hz
                      ? leftRecording.frequency_hz.toLocaleString()
                      : "—"
                  }
                  rightVal={
                    rightRecording.frequency_hz
                      ? rightRecording.frequency_hz.toLocaleString()
                      : "—"
                  }
                />
                <CompareRow
                  label="Timestamp"
                  leftVal={
                    leftRecording.timestamp
                      ? formatDateTime(leftRecording.timestamp)
                      : "—"
                  }
                  rightVal={
                    rightRecording.timestamp
                      ? formatDateTime(rightRecording.timestamp)
                      : "—"
                  }
                  highlight={false}
                />
                <CompareRow
                  label="Duration"
                  leftVal={formatDuration(leftRecording.duration_seconds)}
                  rightVal={formatDuration(rightRecording.duration_seconds)}
                />
                <CompareRow
                  label="Signal (dB)"
                  leftVal={
                    leftRecording.signal_db != null
                      ? `${leftRecording.signal_db.toFixed(1)} dB`
                      : "—"
                  }
                  rightVal={
                    rightRecording.signal_db != null
                      ? `${rightRecording.signal_db.toFixed(1)} dB`
                      : "—"
                  }
                />
                <CompareRow
                  label="Transcript"
                  leftVal={
                    leftRecording.transcript_status === "yes"
                      ? "Yes"
                      : leftRecording.transcript_status === "pending"
                      ? "Pending"
                      : "No"
                  }
                  rightVal={
                    rightRecording.transcript_status === "yes"
                      ? "Yes"
                      : rightRecording.transcript_status === "pending"
                      ? "Pending"
                      : "No"
                  }
                />
                <CompareRow
                  label="Tags"
                  leftVal={
                    leftRecording.tags && leftRecording.tags.length > 0
                      ? leftRecording.tags.join(", ")
                      : "—"
                  }
                  rightVal={
                    rightRecording.tags && rightRecording.tags.length > 0
                      ? rightRecording.tags.join(", ")
                      : "—"
                  }
                />
                <CompareRow
                  label="Callsigns"
                  leftVal={
                    leftRecording.callsign_tags &&
                    leftRecording.callsign_tags.length > 0
                      ? leftRecording.callsign_tags.join(", ")
                      : "—"
                  }
                  rightVal={
                    rightRecording.callsign_tags &&
                    rightRecording.callsign_tags.length > 0
                      ? rightRecording.callsign_tags.join(", ")
                      : "—"
                  }
                />
                <CompareRow
                  label="DTMF"
                  leftVal={leftRecording.dtmf_tones ?? "—"}
                  rightVal={rightRecording.dtmf_tones ?? "—"}
                />
                <CompareRow
                  label="Source SDR"
                  leftVal={leftRecording.source_sdr ?? "—"}
                  rightVal={rightRecording.source_sdr ?? "—"}
                />
                <CompareRow
                  label="Repeater"
                  leftVal={
                    leftRecording.repeater
                      ? `${leftRecording.repeater.callsign} — ${leftRecording.repeater.location ?? ""}`
                      : "—"
                  }
                  rightVal={
                    rightRecording.repeater
                      ? `${rightRecording.repeater.callsign} — ${rightRecording.repeater.location ?? ""}`
                      : "—"
                  }
                />
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Picker modal */}
      {pickerOpen && (
        <RecordingPicker
          onPick={handlePick}
          onClose={() => setPickerOpen(false)}
          excludeId={
            pickingSide === "left"
              ? rightId
                ? Number(rightId)
                : undefined
              : leftId
              ? Number(leftId)
              : undefined
          }
        />
      )}
    </div>
  );
}

export default ComparePage;
