import math as _math
import wave as _wave
import numpy as np


def generate_waveform_peaks(audio_path: str, num_peaks: int = 1000) -> dict:
    """Generate waveform peaks for visualization.

    Returns a dict with:
    - peaks: list of [min, max] values per segment
    - duration: total duration in seconds
    - sample_rate: original sample rate
    """
    import librosa  # lazy import — keeps startup memory low
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    duration = len(y) / sr

    # Calculate samples per peak
    samples_per_peak = max(1, len(y) // num_peaks)

    peaks = []
    for i in range(0, len(y), samples_per_peak):
        segment = y[i : i + samples_per_peak]
        if len(segment) > 0:
            peaks.append([float(np.min(segment)), float(np.max(segment))])

    return {
        "peaks": peaks,
        "duration": duration,
        "sample_rate": sr,
        "num_samples": len(y),
    }


def generate_spectrogram(
    audio_path: str,
    output_path: str,
    figsize: tuple = (12, 4),
    max_seconds: int = 90,
):
    """Generate spectrogram image and save to file."""
    import librosa  # lazy import
    import librosa.display
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # Bound decode duration to avoid huge memory/latency on very long captures.
    y, sr = librosa.load(audio_path, sr=8000, mono=True, duration=max_seconds)

    # Compute spectrogram
    hop_length = max(256, len(y) // 2000) if len(y) else 256
    D = librosa.amplitude_to_db(
        np.abs(librosa.stft(y, n_fft=512, hop_length=hop_length)),
        ref=np.max,
    )

    # Create figure
    fig, ax = plt.subplots(figsize=figsize)
    img = librosa.display.specshow(D, sr=sr, x_axis="time", y_axis="hz", ax=ax, cmap="magma")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Frequency (Hz)")
    fig.colorbar(img, ax=ax, format="%+2.0f dB")

    # Save
    plt.tight_layout()
    plt.savefig(output_path, dpi=100, bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)


def get_time_segments(transcript: str, duration: float) -> list:
    """Estimate time segments for transcript words.

    Since Whisper doesn't always provide word-level timestamps in our setup,
    we estimate based on character position and total duration.
    """
    if not transcript:
        return []

    words = transcript.split()
    total_chars = len(transcript)
    if total_chars == 0:
        return []

    segments = []
    char_pos = 0
    for word in words:
        start_time = (char_pos / total_chars) * duration
        char_pos += len(word) + 1  # +1 for space
        end_time = (char_pos / total_chars) * duration
        segments.append({
            "word": word,
            "start": start_time,
            "end": end_time,
        })

    return segments


def compute_signal_db(audio_path: str):
    """Compute RMS signal level in dBFS using stdlib wave + numpy (no librosa)."""
    try:
        with _wave.open(audio_path, "rb") as w:
            n_ch = w.getnchannels()
            sw = w.getsampwidth()
            if sw not in (2, 4):
                return None
            dtype = np.int16 if sw == 2 else np.int32
            scale = 32768.0 if sw == 2 else 2147483648.0
            chunk = 8192
            sum_sq = 0.0
            count = 0
            while True:
                raw = w.readframes(chunk)
                if not raw:
                    break
                data = np.frombuffer(raw, dtype=dtype).astype(np.float32) / scale
                if n_ch > 1:
                    data = data.reshape(-1, n_ch).mean(axis=1)
                sum_sq += float(np.sum(data ** 2))
                count += len(data)
        if count == 0:
            return None
        rms = float(np.sqrt(sum_sq / count))
        return round(20 * _math.log10(rms), 1) if rms > 0 else None
    except Exception:
        return None
