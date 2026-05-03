import { useParams, Link, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getFile,
  getStreamUrl,
  getWaveform,
  updateRecordingTags,
  retagRecording,
  retranscribeRecording,
  reclassifyRecordingMode,
  getFileNeighbors,
  getRelatedRecordings,
  updateTranscript,
  updateNotes,
  getSimilarRecordings,
} from "../api/client";
import AudioPlayer from "../components/Player/AudioPlayer";
import TranscriptSync from "../components/Player/TranscriptSync";
import { CallsignLink } from "../components/CallsignLink";
import { formatDateTime, formatTime } from "../utils/time";
import { useState, useCallback } from "react";

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

function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const highlightQuery = searchParams.get("q") ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentTime, setCurrentTime] = useState(0);
  const [showSpectrogram, setShowSpectrogram] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [retagMsg, setRetagMsg] = useState<string | null>(null);
  const [retranscribeMsg, setRetranscribeMsg] = useState<string | null>(null);
  const [reclassifyMsg, setReclassifyMsg] = useState<string | null>(null);
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [editedTranscript, setEditedTranscript] = useState("");
  const [transcriptSaving, setTranscriptSaving] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);

  const copyTranscript = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const saveAiTags = useCallback(
    async (tags: string[]) => {
      if (!id) return;
      setTagBusy(true);
      try {
        await updateRecordingTags(Number(id), tags);
        queryClient.invalidateQueries({ queryKey: ["file", id] });
      } finally {
        setTagBusy(false);
      }
    },
    [id, queryClient]
  );

  const handleRetag = useCallback(async () => {
    if (!id) return;
    setTagBusy(true);
    setRetagMsg(null);
    try {
      await retagRecording(Number(id));
      setRetagMsg("AI tags cleared — will regenerate on next indexer cycle (~30s).");
      setTimeout(() => setRetagMsg(null), 6000);
    } catch {
      setRetagMsg("Retag request failed.");
    } finally {
      setTagBusy(false);
    }
  }, [id]);

  const handleRetranscribe = useCallback(async () => {
    if (!id) return;
    setTagBusy(true);
    setRetranscribeMsg(null);
    try {
      await retranscribeRecording(Number(id));
      setRetranscribeMsg("Transcript cleared — Whisper will re-transcribe on next cycle (~30s).");
      setTimeout(() => {
        setRetranscribeMsg(null);
        queryClient.invalidateQueries({ queryKey: ["file", id] });
      }, 6000);
    } catch {
      setRetranscribeMsg("Retranscribe request failed.");
    } finally {
      setTagBusy(false);
    }
  }, [id, queryClient]);

  const handleReclassify = useCallback(async (newMode: "voice" | "cw") => {
    if (!id) return;
    const label = newMode === "cw" ? "CW (Morse)" : "Voice (FM)";
    if (!window.confirm(`Reclassify as ${label}? The audio file will be moved and re-queued for ${newMode === "cw" ? "CW decoding" : "Whisper transcription"}.`)) return;
    setTagBusy(true);
    setReclassifyMsg(null);
    try {
      await reclassifyRecordingMode(Number(id), newMode);
      setReclassifyMsg(`Reclassified as ${label} — re-queued for decoding.`);
      setTimeout(() => {
        setReclassifyMsg(null);
        queryClient.invalidateQueries({ queryKey: ["file", id] });
      }, 4000);
    } catch {
      setReclassifyMsg("Reclassify failed.");
    } finally {
      setTagBusy(false);
    }
  }, [id, queryClient]);

  const handleSaveTranscript = useCallback(async () => {
    if (!id) return;
    setTranscriptSaving(true);
    try {
      await updateTranscript(Number(id), editedTranscript);
      queryClient.invalidateQueries({ queryKey: ["file", id] });
      setEditingTranscript(false);
    } catch {
      // keep editing state open on error
    } finally {
      setTranscriptSaving(false);
    }
  }, [id, editedTranscript, queryClient]);

  const handleSaveNotes = useCallback(async () => {
    if (!id) return;
    setNotesSaving(true);
    try {
      await updateNotes(Number(id), notesValue || null);
      queryClient.invalidateQueries({ queryKey: ["file", id] });
      setEditingNotes(false);
    } catch {
      // keep editing state open on error
    } finally {
      setNotesSaving(false);
    }
  }, [id, notesValue, queryClient]);

  const { data: recording, isLoading, error } = useQuery({
    queryKey: ["file", id],
    queryFn: () => getFile(Number(id)),
    enabled: !!id,
  });

  const { data: neighbors } = useQuery({
    queryKey: ["file-neighbors", id],
    queryFn: () => getFileNeighbors(Number(id)),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: related } = useQuery({
    queryKey: ["file-related", id],
    queryFn: () => getRelatedRecordings(Number(id)),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: similar } = useQuery({
    queryKey: ["file-similar", id],
    queryFn: () => getSimilarRecordings(Number(id)),
    enabled: !!id && !!(recording?.transcript),
    staleTime: 5 * 60 * 1000,
  });

  const { data: waveformData } = useQuery({
    queryKey: ["waveform", id],
    queryFn: () => getWaveform(Number(id)),
    enabled: !!id,
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="text-center py-8">Loading...</div>;
  }

  if (error || !recording) {
    return (
      <div className="text-red-400">
        Failed to load recording: {String(error)}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        {/* Navigation row */}
        <div className="flex items-center justify-between mb-2">
          <Link to="/" className="text-gray-400 hover:text-white text-sm">
            &larr; Back to recordings
          </Link>
          <div className="flex gap-2">
            <button
              onClick={() => neighbors?.prev_id && navigate(`/player/${neighbors.prev_id}`)}
              disabled={!neighbors?.prev_id}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-30 player-nav-btn"
              title="Previous recording"
            >
              ← Prev
            </button>
            <button
              onClick={() => neighbors?.next_id && navigate(`/player/${neighbors.next_id}`)}
              disabled={!neighbors?.next_id}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-30 player-nav-btn"
              title="Next recording"
            >
              Next →
            </button>
          </div>
        </div>

        <h1 className="text-2xl font-bold">{recording.filename}</h1>
        <div className="flex flex-wrap gap-4 text-sm text-gray-400 mt-1">
          <span
            className={`inline-flex px-2 py-1 text-xs font-medium rounded ${
              recording.mode === "cw"
                ? "bg-yellow-900 text-yellow-200"
                : "bg-blue-900 text-blue-200"
            }`}
          >
            {recording.mode.toUpperCase()}
          </span>
          <span>
            {formatFrequency(recording.frequency_hz)}
            {recording.frequency_label && (
              <span className="ml-2 text-cyan-400">{recording.frequency_label}</span>
            )}
          </span>
          {recording.timestamp && (
            <span>{formatDateTime(recording.timestamp)}</span>
          )}
        </div>
        {recording.tags && recording.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {recording.tags.map((tag) => {
              const isCallsign = recording.callsign_tags?.includes(tag);
              const cls = `inline-flex px-2 py-0.5 text-xs rounded ${isCallsign ? "bg-purple-900 text-purple-100" : "bg-sky-900 text-sky-100"}`;
              return isCallsign ? (
                <CallsignLink key={tag} callsign={tag} className={cls} />
              ) : (
                <span key={tag} className={cls}>{tag}</span>
              );
            })}
          </div>
        )}
        {recording.dtmf_tones && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-gray-400">DTMF:</span>
            <span className="font-mono text-sm bg-gray-700 px-2 py-0.5 rounded text-yellow-300 tracking-widest">
              {recording.dtmf_tones}
            </span>
          </div>
        )}
        {/* Retag / retranscribe */}
        <div className="flex gap-2 mt-3 flex-wrap">
          <button
            onClick={handleRetag}
            disabled={tagBusy}
            className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium disabled:opacity-50"
            title="Clear AI tags — indexer will re-tag on next cycle"
          >
            Re-tag
          </button>
          {recording.mode !== "aprs" && (
            <button
              onClick={handleRetranscribe}
              disabled={tagBusy}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium disabled:opacity-50"
              title="Delete transcript — Whisper will re-transcribe on next cycle"
            >
              Re-transcribe
            </button>
          )}
          {recording.mode === "voice" && (
            <button
              onClick={() => handleReclassify("cw")}
              disabled={tagBusy}
              className="px-3 py-1 bg-yellow-900 hover:bg-yellow-800 text-yellow-200 rounded text-xs font-medium disabled:opacity-50"
              title="Move to CW decoder — use if this is Morse code misclassified as voice"
            >
              Reclassify as CW
            </button>
          )}
          {recording.mode === "cw" && (
            <button
              onClick={() => handleReclassify("voice")}
              disabled={tagBusy}
              className="px-3 py-1 bg-blue-900 hover:bg-blue-800 text-blue-200 rounded text-xs font-medium disabled:opacity-50"
              title="Move to Whisper decoder — use if this is voice misclassified as CW"
            >
              Reclassify as Voice
            </button>
          )}
        </div>
        {retagMsg && <p className="text-xs text-green-300 mt-1">{retagMsg}</p>}
        {retranscribeMsg && <p className="text-xs text-green-300 mt-1">{retranscribeMsg}</p>}
        {reclassifyMsg && <p className="text-xs text-yellow-300 mt-1">{reclassifyMsg}</p>}

        {/* Tag editor */}
        <div className="mt-3">
          <div className="flex flex-wrap gap-1 mb-2">
            {(recording.ai_tags ?? []).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-900 text-sky-100 text-xs rounded"
              >
                {tag}
                <button
                  onClick={() =>
                    saveAiTags((recording.ai_tags ?? []).filter((t) => t !== tag))
                  }
                  disabled={tagBusy}
                  className="hover:text-red-300 disabled:opacity-50 leading-none"
                  title="Remove tag"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = newTag.trim().toLowerCase();
              if (!trimmed) return;
              if ((recording.ai_tags ?? []).includes(trimmed)) {
                setNewTag("");
                return;
              }
              saveAiTags([...(recording.ai_tags ?? []), trimmed]);
              setNewTag("");
            }}
          >
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value.toLowerCase())}
              placeholder="add tag…"
              className="w-36 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs"
              disabled={tagBusy}
            />
            <button
              type="submit"
              disabled={tagBusy || !newTag.trim()}
              className="px-3 py-1 bg-sky-800 hover:bg-sky-700 rounded text-xs font-medium disabled:opacity-50"
            >
              Add
            </button>
          </form>
        </div>

        <div className="flex gap-3 mt-3">
          <a
            href={getStreamUrl(recording.id)}
            download={recording.filename}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
          >
            Download audio
          </a>
          {recording.transcript_status === "yes" && recording.transcript && (
            <button
              onClick={() => copyTranscript(recording.transcript!)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
            >
              {copied ? "Copied!" : "Copy transcript"}
            </button>
          )}
          <button
            onClick={() => navigate(`/compare?left=${recording.id}`)}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
            title="Compare this recording side-by-side with another"
          >
            Compare with...
          </button>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-sm font-medium text-gray-300">Waveform</span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={showSpectrogram}
              onChange={(e) => setShowSpectrogram(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:bg-green-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
          </label>
          <span className={`text-sm ${showSpectrogram ? "text-green-400 font-medium" : "text-gray-500"}`}>
            Spectrogram
          </span>
          {showSpectrogram && (
            <span className="text-xs text-gray-500 ml-1">
              Frequency over time -- cursor synced with waveform
            </span>
          )}
        </div>

        <AudioPlayer
          src={getStreamUrl(recording.id)}
          recordingId={recording.id}
          onTimeUpdate={setCurrentTime}
          peaks={waveformData?.peaks}
          audioDuration={waveformData?.duration}
          showSpectrogram={showSpectrogram}
        />
      </div>

      {/* Transcript */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium">Transcript</h2>
          <div className="flex items-center gap-2">
            {highlightQuery && (
              <span className="text-xs text-yellow-300 bg-yellow-900/40 px-2 py-0.5 rounded">
                Highlighting: {highlightQuery}
              </span>
            )}
            {recording.mode !== "aprs" && recording.transcript_status !== "pending" && !editingTranscript && (
              <button
                onClick={() => {
                  setEditedTranscript(recording.transcript ?? "");
                  setEditingTranscript(true);
                }}
                className="text-xs text-gray-400 hover:text-white px-2 py-0.5 bg-gray-700 rounded"
              >
                Edit
              </button>
            )}
          </div>
        </div>
        {editingTranscript ? (
          <div>
            <textarea
              value={editedTranscript}
              onChange={(e) => setEditedTranscript(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-sm text-gray-200 font-mono min-h-[120px] resize-y"
              disabled={transcriptSaving}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleSaveTranscript}
                disabled={transcriptSaving}
                className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm font-medium disabled:opacity-50"
              >
                {transcriptSaving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => setEditingTranscript(false)}
                disabled={transcriptSaving}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : recording.transcript_status === "pending" ? (
          <div className="text-yellow-500 italic">Pending transcription…</div>
        ) : recording.transcript_status === "no" || !recording.transcript_status ? (
          <div className="text-gray-500 italic">No transcript available</div>
        ) : highlightQuery && recording.transcript ? (
          <HighlightedTranscript text={recording.transcript} query={highlightQuery} />
        ) : (
          <TranscriptSync
            transcript={recording.transcript || ""}
            currentTime={currentTime}
            duration={recording.duration_seconds || 0}
          />
        )}
      </div>

      {/* Notes */}
      <div className="bg-gray-800 rounded-lg p-4 mt-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-medium">Notes</h2>
          {!editingNotes && (
            <button
              onClick={() => { setNotesValue(recording.notes ?? ""); setEditingNotes(true); }}
              className="text-xs text-gray-400 hover:text-white px-2 py-0.5 bg-gray-700 rounded"
            >
              {recording.notes ? "Edit" : "Add note"}
            </button>
          )}
        </div>
        {editingNotes ? (
          <div>
            <textarea
              value={notesValue}
              onChange={(e) => setNotesValue(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded p-3 text-sm text-gray-200 min-h-[80px] resize-y"
              placeholder="Add notes about this recording…"
              disabled={notesSaving}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleSaveNotes}
                disabled={notesSaving}
                className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm font-medium disabled:opacity-50"
              >
                {notesSaving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => setEditingNotes(false)}
                disabled={notesSaving}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : recording.notes ? (
          <p className="text-sm text-gray-300 whitespace-pre-wrap">{recording.notes}</p>
        ) : (
          <p className="text-sm text-gray-500 italic">No notes yet.</p>
        )}
      </div>

      {recording.repeater && (
        <div className="bg-gray-800 rounded-lg p-4 mt-4">
          <h2 className="text-lg font-medium mb-3">Repeater</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="text-gray-400">Callsign</div>
            <div className="font-medium">
              <CallsignLink callsign={recording.repeater.callsign} className="text-purple-300 hover:underline font-mono" />
            </div>
            {recording.repeater.location && (
              <>
                <div className="text-gray-400">Location</div>
                <div>
                  {recording.repeater.location}
                  {recording.repeater.county ? `, ${recording.repeater.county}` : ""}
                  {recording.repeater.state ? ` ${recording.repeater.state}` : ""}
                </div>
              </>
            )}
            <div className="text-gray-400">Output</div>
            <div>{formatFrequency(recording.repeater.frequency_hz)}</div>
            {recording.repeater.input_hz && (
              <>
                <div className="text-gray-400">Input</div>
                <div>{formatFrequency(recording.repeater.input_hz)}</div>
              </>
            )}
            {recording.repeater.pl_tone && (
              <>
                <div className="text-gray-400">PL Tone</div>
                <div>{recording.repeater.pl_tone.toFixed(1)} Hz</div>
              </>
            )}
            {recording.repeater.digital_modes.length > 0 && (
              <>
                <div className="text-gray-400">Digital</div>
                <div className="flex flex-wrap gap-1">
                  {recording.repeater.digital_modes.map((m) => (
                    <span key={m} className="px-1.5 py-0.5 bg-indigo-900 text-indigo-200 text-xs rounded">
                      {m}
                    </span>
                  ))}
                </div>
              </>
            )}
            {recording.repeater.linked_nodes && (
              <>
                <div className="text-gray-400">Linked</div>
                <div className="text-xs font-mono">{recording.repeater.linked_nodes}</div>
              </>
            )}
          </div>
        </div>
      )}

      {recording.operators && recording.operators.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4 mt-4">
          <h2 className="text-lg font-medium mb-3">Operators</h2>
          <div className="space-y-3">
            {recording.operators.map((op) => (
              <div key={op.callsign} className="flex items-start gap-4 text-sm">
                <CallsignLink
                  callsign={op.callsign}
                  className="px-2 py-0.5 bg-purple-900 text-purple-100 rounded font-mono font-medium min-w-[70px] text-center hover:bg-purple-800"
                />
                <div>
                  {op.name && <div className="font-medium">{op.name}</div>}
                  {(op.qth_city || op.qth_state) && (
                    <div className="text-gray-400">
                      {[op.qth_city, op.qth_state].filter(Boolean).join(", ")}
                    </div>
                  )}
                  <div className="text-gray-500 text-xs">
                    {[
                      op.license_class && `Class: ${op.license_class}`,
                      op.grid && `Grid: ${op.grid}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related recordings */}
      {related && related.items.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4 mt-4">
          <h2 className="text-lg font-medium mb-3">
            Related Recordings
            <span className="ml-2 text-xs text-gray-400 font-normal">same frequency, ±1 hour</span>
          </h2>
          <div className="space-y-1">
            {related.items.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 py-1.5 border-b border-gray-700 last:border-0 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`shrink-0 px-1.5 py-0.5 text-xs rounded ${r.mode === "cw" ? "bg-yellow-900 text-yellow-200" : "bg-blue-900 text-blue-200"}`}>
                    {r.mode.toUpperCase()}
                  </span>
                  <span className="text-gray-400 text-xs shrink-0">
                    {r.timestamp ? formatTime(r.timestamp) : "—"}
                  </span>
                  {r.has_transcript && (
                    <span className="text-gray-300 truncate text-xs">
                      {/* transcript preview loaded on demand via player */}
                      {formatDuration(r.duration_seconds)}
                    </span>
                  )}
                </div>
                <Link
                  to={`/player/${r.id}`}
                  className="text-green-400 hover:text-green-300 text-xs shrink-0"
                >
                  Play →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Similar transcripts */}
      {similar && similar.items.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4 mt-4">
          <h2 className="text-lg font-medium mb-3">
            Similar Transcripts
            <span className="ml-2 text-xs text-gray-400 font-normal">matched by content</span>
          </h2>
          <div className="space-y-1">
            {similar.items.map((r) => (
              <div
                key={r.id}
                className="flex items-start gap-3 py-1.5 border-b border-gray-700 last:border-0 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={`shrink-0 px-1.5 py-0.5 text-xs rounded ${r.mode === "cw" ? "bg-yellow-900 text-yellow-200" : "bg-blue-900 text-blue-200"}`}>
                    {r.mode.toUpperCase()}
                  </span>
                  <span className="text-cyan-400 text-xs shrink-0">
                    {r.frequency_label ?? (r.frequency_hz ? formatFrequency(r.frequency_hz) : "—")}
                  </span>
                  <span className="text-gray-300 text-xs truncate">{r.transcript}</span>
                </div>
                <Link to={`/player/${r.id}`} className="text-green-400 hover:text-green-300 text-xs shrink-0">
                  Play →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HighlightedTranscript({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <p className="text-gray-300 leading-relaxed">{text}</p>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <p className="text-gray-300 leading-relaxed">
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-400 text-gray-900 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

export default PlayerPage;
