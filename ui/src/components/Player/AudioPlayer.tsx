import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram";

interface AudioPlayerProps {
  src: string;
  recordingId: number;
  onTimeUpdate?: (time: number) => void;
  peaks?: [number, number][];
  audioDuration?: number;
  showSpectrogram?: boolean;
}

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const LOAD_TIMEOUT_MS = 30_000;

function AudioPlayer({ src, recordingId, onTimeUpdate, peaks, audioDuration, showSpectrogram }: AudioPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spectrogramRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const spectrogramPluginRef = useRef<SpectrogramPlugin | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [error, setError] = useState<string | null>(null);

  // Register / destroy the spectrogram plugin when the toggle changes
  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws || !isReady) return;

    if (showSpectrogram && spectrogramRef.current) {
      // Only register if not already active
      if (!spectrogramPluginRef.current) {
        const sp = ws.registerPlugin(
          SpectrogramPlugin.create({
            container: spectrogramRef.current,
            labels: true,
            labelsColor: "#9ca3af",
            labelsHzColor: "#6b7280",
            labelsBackground: "rgba(17,24,39,0.75)",
            height: 150,
            fftSamples: 512,
            windowFunc: "hann",
            colorMap: "roseus",
            splitChannels: false,
          })
        );
        spectrogramPluginRef.current = sp;
      }
    } else {
      // Destroy if active
      if (spectrogramPluginRef.current) {
        spectrogramPluginRef.current.destroy();
        spectrogramPluginRef.current = null;
      }
    }
  }, [showSpectrogram, isReady]);

  useEffect(() => {
    if (!containerRef.current) return;

    setError(null);
    setIsReady(false);
    spectrogramPluginRef.current = null;

    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#4ade80",
      progressColor: "#22c55e",
      cursorColor: "#ffffff",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 100,
      normalize: true,
      backend: "WebAudio",
    });

    // Load timeout — if audio doesn't load within 30s, show error
    const timeout = setTimeout(() => {
      if (!wavesurferRef.current || wavesurfer.getDuration() === 0) {
        setError("Audio loading timed out. The file may be unavailable.");
      }
    }, LOAD_TIMEOUT_MS);

    // Pre-render waveform shape from peaks if available (renders instantly before audio decodes)
    if (peaks && peaks.length > 0 && audioDuration) {
      const flat = peaks.flatMap(([lo, hi]) => [lo, hi]);
      wavesurfer.load(src, [flat], audioDuration);
    } else {
      wavesurfer.load(src);
    }

    wavesurfer.on("ready", () => {
      clearTimeout(timeout);
      setDuration(wavesurfer.getDuration());
      setIsReady(true);
      setError(null);
    });

    wavesurfer.on("error", (err) => {
      clearTimeout(timeout);
      setError(`Failed to load audio: ${err}`);
    });

    wavesurfer.on("audioprocess", () => {
      const time = wavesurfer.getCurrentTime();
      setCurrentTime(time);
      onTimeUpdate?.(time);
    });

    wavesurfer.on("seeking", () => {
      const time = wavesurfer.getCurrentTime();
      setCurrentTime(time);
      onTimeUpdate?.(time);
    });

    wavesurfer.on("play", () => setIsPlaying(true));
    wavesurfer.on("pause", () => setIsPlaying(false));
    wavesurfer.on("finish", () => setIsPlaying(false));

    wavesurferRef.current = wavesurfer;

    return () => {
      clearTimeout(timeout);
      spectrogramPluginRef.current = null;
      wavesurfer.destroy();
    };
  }, [src, recordingId, peaks, audioDuration]);

  const handleRetry = () => {
    setError(null);
    setIsReady(false);
    if (wavesurferRef.current) {
      if (peaks && peaks.length > 0 && audioDuration) {
        const flat = peaks.flatMap(([lo, hi]) => [lo, hi]);
        wavesurferRef.current.load(src, [flat], audioDuration);
      } else {
        wavesurferRef.current.load(src);
      }
    }
  };

  const togglePlay = () => {
    wavesurferRef.current?.playPause();
  };

  const skip = (seconds: number) => {
    if (wavesurferRef.current) {
      const newTime = Math.max(
        0,
        Math.min(duration, currentTime + seconds)
      );
      wavesurferRef.current.seekTo(newTime / duration);
    }
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    wavesurferRef.current?.setPlaybackRate(newSpeed);
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div>
      <div
        ref={containerRef}
        className="bg-gray-900 rounded mb-4 cursor-pointer"
      />

      {/* Spectrogram rendered by WaveSurfer plugin — synced cursor automatically */}
      <div
        ref={spectrogramRef}
        className={`bg-gray-900 rounded mb-4 overflow-hidden transition-all duration-300 ${
          showSpectrogram ? "max-h-[300px] opacity-100" : "max-h-0 opacity-0"
        }`}
      />

      {error && (
        <div className="bg-red-900/50 border border-red-700 rounded p-3 mb-4 flex items-center justify-between gap-3">
          <span className="text-red-200 text-sm">{error}</span>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={handleRetry}
              className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-sm text-white"
            >
              Retry
            </button>
            <a
              href={src}
              download
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white"
            >
              Download
            </a>
          </div>
        </div>
      )}

      {!isReady && !error && (
        <div className="text-gray-500 text-sm mb-4">Loading audio...</div>
      )}

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            onClick={() => skip(-10)}
            disabled={!isReady}
            className="p-2 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50"
            title="Back 10s"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.334 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"
              />
            </svg>
          </button>

          <button
            onClick={togglePlay}
            disabled={!isReady}
            className="p-3 bg-green-600 rounded-full hover:bg-green-500 disabled:opacity-50"
          >
            {isPlaying ? (
              <svg
                className="w-6 h-6"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg
                className="w-6 h-6"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            onClick={() => skip(10)}
            disabled={!isReady}
            className="p-2 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-50"
            title="Forward 10s"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 text-sm text-gray-400">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>

        {/* Speed control */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">Speed:</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => handleSpeedChange(s)}
              disabled={!isReady}
              className={`px-2 py-0.5 rounded text-xs font-mono disabled:opacity-40 transition-colors ${
                speed === s
                  ? "bg-green-700 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600"
              }`}
            >
              {s === 1.0 ? "1\u00d7" : `${s}\u00d7`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default AudioPlayer;
