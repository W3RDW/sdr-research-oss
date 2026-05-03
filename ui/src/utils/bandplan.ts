/**
 * ARRL Band Plan utility — maps frequencies to amateur radio band segments.
 *
 * Covers HF (160m–10m), VHF (6m, 2m), and UHF (70cm) with proper
 * CW / Digital / Phone / FM / Repeater sub-band designations.
 */

export interface BandSegment {
  label: string;       // e.g. "CW Only", "Phone", "Digital"
  start_hz: number;
  end_hz: number;
  band: string;        // e.g. "2m", "70cm", "20m"
  color: string;       // for visualization
}

// ── Color palette for segment types ──────────────────────────────────
const C = {
  cw:       "#eab308", // yellow
  digital:  "#3b82f6", // blue
  phone:    "#22c55e", // green
  fm:       "#8b5cf6", // purple
  repeater: "#ec4899", // pink
  ssb:      "#06b6d4", // cyan
  mixed:    "#f97316", // orange
  atv:      "#ef4444", // red
  beacon:   "#14b8a6", // teal
  satellite:"#a855f7", // violet
  aprs:     "#f43f5e", // rose
  simplex:  "#84cc16", // lime
  weak:     "#0ea5e9", // sky blue (weak signal modes)
  sstv:     "#d946ef", // fuchsia
  emcomm:   "#dc2626", // red-600
} as const;

// ── Segments ─────────────────────────────────────────────────────────
// Frequencies in Hz. Ordered by band then by start frequency.

const SEGMENTS: BandSegment[] = [
  // ── 160m (1.8–2.0 MHz) ────────────────────────────────────────────
  { band: "160m", label: "CW",                start_hz: 1_800_000, end_hz: 1_810_000, color: C.cw },
  { band: "160m", label: "CW / Digital",      start_hz: 1_810_000, end_hz: 1_840_000, color: C.digital },
  { band: "160m", label: "CW / SSB / Digital",start_hz: 1_840_000, end_hz: 2_000_000, color: C.phone },

  // ── 80m (3.5–4.0 MHz) ─────────────────────────────────────────────
  { band: "80m", label: "CW",                 start_hz: 3_500_000, end_hz: 3_600_000, color: C.cw },
  { band: "80m", label: "CW / Digital",       start_hz: 3_570_000, end_hz: 3_600_000, color: C.digital },
  { band: "80m", label: "Phone",              start_hz: 3_600_000, end_hz: 3_700_000, color: C.phone },
  { band: "80m", label: "Phone (75m)",        start_hz: 3_700_000, end_hz: 4_000_000, color: C.phone },

  // ── 60m (5.3 MHz) — channelized ───────────────────────────────────
  { band: "60m", label: "Channel 1 (USB)",    start_hz: 5_330_500, end_hz: 5_333_500, color: C.ssb },
  { band: "60m", label: "Channel 2 (USB)",    start_hz: 5_346_500, end_hz: 5_349_500, color: C.ssb },
  { band: "60m", label: "Channel 3 (USB)",    start_hz: 5_357_000, end_hz: 5_360_000, color: C.ssb },
  { band: "60m", label: "Channel 4 (USB)",    start_hz: 5_371_500, end_hz: 5_374_500, color: C.ssb },
  { band: "60m", label: "Channel 5 (USB)",    start_hz: 5_403_500, end_hz: 5_406_500, color: C.ssb },

  // ── 40m (7.0–7.3 MHz) ─────────────────────────────────────────────
  { band: "40m", label: "CW",                 start_hz: 7_000_000, end_hz: 7_025_000, color: C.cw },
  { band: "40m", label: "CW / Digital",       start_hz: 7_025_000, end_hz: 7_125_000, color: C.digital },
  { band: "40m", label: "Phone",              start_hz: 7_125_000, end_hz: 7_300_000, color: C.phone },

  // ── 30m (10.1–10.15 MHz) ──────────────────────────────────────────
  { band: "30m", label: "CW",                 start_hz: 10_100_000, end_hz: 10_130_000, color: C.cw },
  { band: "30m", label: "CW / Digital",       start_hz: 10_130_000, end_hz: 10_150_000, color: C.digital },

  // ── 20m (14.0–14.35 MHz) ──────────────────────────────────────────
  { band: "20m", label: "CW",                 start_hz: 14_000_000, end_hz: 14_025_000, color: C.cw },
  { band: "20m", label: "CW / Digital",       start_hz: 14_025_000, end_hz: 14_150_000, color: C.digital },
  { band: "20m", label: "Phone",              start_hz: 14_150_000, end_hz: 14_350_000, color: C.phone },

  // ── 17m (18.068–18.168 MHz) ───────────────────────────────────────
  { band: "17m", label: "CW",                 start_hz: 18_068_000, end_hz: 18_095_000, color: C.cw },
  { band: "17m", label: "CW / Digital",       start_hz: 18_095_000, end_hz: 18_110_000, color: C.digital },
  { band: "17m", label: "Phone",              start_hz: 18_110_000, end_hz: 18_168_000, color: C.phone },

  // ── 15m (21.0–21.45 MHz) ──────────────────────────────────────────
  { band: "15m", label: "CW",                 start_hz: 21_000_000, end_hz: 21_025_000, color: C.cw },
  { band: "15m", label: "CW / Digital",       start_hz: 21_025_000, end_hz: 21_200_000, color: C.digital },
  { band: "15m", label: "Phone",              start_hz: 21_200_000, end_hz: 21_450_000, color: C.phone },

  // ── 12m (24.89–24.99 MHz) ─────────────────────────────────────────
  { band: "12m", label: "CW",                 start_hz: 24_890_000, end_hz: 24_915_000, color: C.cw },
  { band: "12m", label: "CW / Digital",       start_hz: 24_915_000, end_hz: 24_930_000, color: C.digital },
  { band: "12m", label: "Phone",              start_hz: 24_930_000, end_hz: 24_990_000, color: C.phone },

  // ── 10m (28.0–29.7 MHz) ───────────────────────────────────────────
  { band: "10m", label: "CW",                 start_hz: 28_000_000, end_hz: 28_070_000, color: C.cw },
  { band: "10m", label: "CW / Digital",       start_hz: 28_070_000, end_hz: 28_150_000, color: C.digital },
  { band: "10m", label: "Beacons",            start_hz: 28_150_000, end_hz: 28_300_000, color: C.beacon },
  { band: "10m", label: "Phone",              start_hz: 28_300_000, end_hz: 29_000_000, color: C.phone },
  { band: "10m", label: "Satellite",          start_hz: 29_000_000, end_hz: 29_200_000, color: C.satellite },
  { band: "10m", label: "FM Repeater",        start_hz: 29_200_000, end_hz: 29_510_000, color: C.repeater },
  { band: "10m", label: "FM Simplex",         start_hz: 29_510_000, end_hz: 29_700_000, color: C.simplex },

  // ── 6m (50–54 MHz) ────────────────────────────────────────────────
  { band: "6m",  label: "CW / Beacons",       start_hz: 50_000_000, end_hz: 50_100_000, color: C.cw },
  { band: "6m",  label: "SSB / CW",           start_hz: 50_100_000, end_hz: 50_300_000, color: C.ssb },
  { band: "6m",  label: "Digital / Packet",   start_hz: 50_300_000, end_hz: 50_600_000, color: C.digital },
  { band: "6m",  label: "All Modes",          start_hz: 50_600_000, end_hz: 51_000_000, color: C.mixed },
  { band: "6m",  label: "FM Repeater",        start_hz: 51_000_000, end_hz: 52_000_000, color: C.repeater },
  { band: "6m",  label: "FM",                 start_hz: 52_000_000, end_hz: 54_000_000, color: C.fm },

  // ── 2m (144–148 MHz) ──────────────────────────────────────────────
  { band: "2m",  label: "CW / EME",           start_hz: 144_000_000, end_hz: 144_100_000, color: C.cw },
  { band: "2m",  label: "SSB / CW",           start_hz: 144_100_000, end_hz: 144_275_000, color: C.ssb },
  { band: "2m",  label: "Beacons / Propagation", start_hz: 144_275_000, end_hz: 144_300_000, color: C.beacon },
  { band: "2m",  label: "OSCAR Satellite",    start_hz: 144_300_000, end_hz: 144_380_000, color: C.satellite },
  { band: "2m",  label: "APRS",               start_hz: 144_380_000, end_hz: 144_400_000, color: C.aprs },
  { band: "2m",  label: "Satellite",          start_hz: 144_400_000, end_hz: 144_500_000, color: C.satellite },
  { band: "2m",  label: "FM Repeater Input",  start_hz: 144_500_000, end_hz: 144_900_000, color: C.repeater },
  { band: "2m",  label: "Weak Signal / SSB",  start_hz: 144_900_000, end_hz: 145_100_000, color: C.weak },
  { band: "2m",  label: "FM Repeater",        start_hz: 145_100_000, end_hz: 145_500_000, color: C.repeater },
  { band: "2m",  label: "Packet / Digital",   start_hz: 145_500_000, end_hz: 145_800_000, color: C.digital },
  { band: "2m",  label: "Satellite",          start_hz: 145_800_000, end_hz: 146_000_000, color: C.satellite },
  { band: "2m",  label: "FM Repeater Input",  start_hz: 146_000_000, end_hz: 146_400_000, color: C.repeater },
  { band: "2m",  label: "FM Simplex",         start_hz: 146_400_000, end_hz: 146_580_000, color: C.simplex },
  { band: "2m",  label: "National Calling Freq", start_hz: 146_520_000, end_hz: 146_520_001, color: C.emcomm },
  { band: "2m",  label: "FM Repeater Output", start_hz: 146_610_000, end_hz: 147_000_000, color: C.repeater },
  { band: "2m",  label: "FM Repeater Output", start_hz: 147_000_000, end_hz: 147_390_000, color: C.repeater },
  { band: "2m",  label: "FM Repeater Input",  start_hz: 147_390_000, end_hz: 147_600_000, color: C.repeater },
  { band: "2m",  label: "FM Repeater",        start_hz: 147_600_000, end_hz: 148_000_000, color: C.repeater },

  // ── 70cm (420–450 MHz) ────────────────────────────────────────────
  { band: "70cm", label: "ATV",               start_hz: 420_000_000, end_hz: 426_000_000, color: C.atv },
  { band: "70cm", label: "Mixed / ATV",       start_hz: 426_000_000, end_hz: 432_000_000, color: C.mixed },
  { band: "70cm", label: "EME / Weak Signal", start_hz: 432_000_000, end_hz: 432_100_000, color: C.weak },
  { band: "70cm", label: "SSB / CW",          start_hz: 432_100_000, end_hz: 433_000_000, color: C.ssb },
  { band: "70cm", label: "Digital / Packet",  start_hz: 433_000_000, end_hz: 435_000_000, color: C.digital },
  { band: "70cm", label: "Satellite",         start_hz: 435_000_000, end_hz: 438_000_000, color: C.satellite },
  { band: "70cm", label: "ATV / Repeater",    start_hz: 438_000_000, end_hz: 442_000_000, color: C.atv },
  { band: "70cm", label: "FM Repeater Output",start_hz: 442_000_000, end_hz: 445_000_000, color: C.repeater },
  { band: "70cm", label: "FM Simplex",        start_hz: 445_000_000, end_hz: 446_025_000, color: C.simplex },
  { band: "70cm", label: "National Calling Freq", start_hz: 446_000_000, end_hz: 446_000_001, color: C.emcomm },
  { band: "70cm", label: "FM Repeater Input", start_hz: 447_000_000, end_hz: 450_000_000, color: C.repeater },
];

// ── Pre-built index by band for fast lookup ──────────────────────────
const _segmentsByBand: Map<string, BandSegment[]> = new Map();
for (const seg of SEGMENTS) {
  const arr = _segmentsByBand.get(seg.band) ?? [];
  arr.push(seg);
  _segmentsByBand.set(seg.band, arr);
}

// ── Band boundaries for quick band detection ─────────────────────────
interface BandRange {
  band: string;
  start_hz: number;
  end_hz: number;
}

const BAND_RANGES: BandRange[] = [
  { band: "160m", start_hz: 1_800_000,   end_hz: 2_000_000 },
  { band: "80m",  start_hz: 3_500_000,   end_hz: 4_000_000 },
  { band: "60m",  start_hz: 5_330_500,   end_hz: 5_406_500 },
  { band: "40m",  start_hz: 7_000_000,   end_hz: 7_300_000 },
  { band: "30m",  start_hz: 10_100_000,  end_hz: 10_150_000 },
  { band: "20m",  start_hz: 14_000_000,  end_hz: 14_350_000 },
  { band: "17m",  start_hz: 18_068_000,  end_hz: 18_168_000 },
  { band: "15m",  start_hz: 21_000_000,  end_hz: 21_450_000 },
  { band: "12m",  start_hz: 24_890_000,  end_hz: 24_990_000 },
  { band: "10m",  start_hz: 28_000_000,  end_hz: 29_700_000 },
  { band: "6m",   start_hz: 50_000_000,  end_hz: 54_000_000 },
  { band: "2m",   start_hz: 144_000_000, end_hz: 148_000_000 },
  { band: "70cm", start_hz: 420_000_000, end_hz: 450_000_000 },
];

// ── Notable frequencies (spot frequencies) ───────────────────────────
interface NotableFrequency {
  freq_hz: number;
  label: string;
  band: string;
}

const NOTABLE_FREQUENCIES: NotableFrequency[] = [
  // 2m
  { freq_hz: 144_200_000, label: "SSB Calling", band: "2m" },
  { freq_hz: 144_390_000, label: "APRS", band: "2m" },
  { freq_hz: 146_520_000, label: "National Simplex Calling", band: "2m" },
  { freq_hz: 145_050_000, label: "Satellite Uplink", band: "2m" },
  // 70cm
  { freq_hz: 446_000_000, label: "National Simplex Calling", band: "70cm" },
  { freq_hz: 432_100_000, label: "SSB/CW Calling", band: "70cm" },
  // HF
  { freq_hz: 7_074_000,   label: "FT8", band: "40m" },
  { freq_hz: 7_038_600,   label: "WSPR", band: "40m" },
  { freq_hz: 14_074_000,  label: "FT8", band: "20m" },
  { freq_hz: 14_095_600,  label: "WSPR", band: "20m" },
  { freq_hz: 10_136_000,  label: "FT8", band: "30m" },
  { freq_hz: 10_138_700,  label: "WSPR", band: "30m" },
  { freq_hz: 3_573_000,   label: "FT8", band: "80m" },
  { freq_hz: 3_568_600,   label: "WSPR", band: "80m" },
  { freq_hz: 1_840_000,   label: "FT8", band: "160m" },
  { freq_hz: 1_836_600,   label: "WSPR", band: "160m" },
  { freq_hz: 18_100_000,  label: "FT8", band: "17m" },
  { freq_hz: 21_074_000,  label: "FT8", band: "15m" },
  { freq_hz: 24_915_000,  label: "FT8", band: "12m" },
  { freq_hz: 28_074_000,  label: "FT8", band: "10m" },
  { freq_hz: 50_313_000,  label: "FT8", band: "6m" },
  { freq_hz: 14_070_000,  label: "PSK31", band: "20m" },
  { freq_hz: 7_040_000,   label: "PSK31", band: "40m" },
  { freq_hz: 14_230_000,  label: "SSTV", band: "20m" },
  { freq_hz: 3_845_000,   label: "SSTV", band: "80m" },
  { freq_hz: 14_300_000,  label: "Emergency Net", band: "20m" },
  { freq_hz: 7_290_000,   label: "Emergency Net", band: "40m" },
];

/**
 * Find the band segment a frequency falls within.
 * Returns the most specific (narrowest) matching segment.
 * For point frequencies like the National Calling Frequency,
 * we check within ±500 Hz.
 */
export function getBandSegment(freq_hz: number): BandSegment | null {
  let best: BandSegment | null = null;
  let bestWidth = Infinity;

  for (const seg of SEGMENTS) {
    // For "point" segments (1 Hz wide), check within ±500 Hz
    const segWidth = seg.end_hz - seg.start_hz;
    if (segWidth <= 10) {
      if (Math.abs(freq_hz - seg.start_hz) <= 500 && segWidth < bestWidth) {
        best = seg;
        bestWidth = segWidth;
      }
    } else {
      if (freq_hz >= seg.start_hz && freq_hz < seg.end_hz && segWidth < bestWidth) {
        best = seg;
        bestWidth = segWidth;
      }
    }
  }

  return best;
}

/**
 * Return the amateur band name for a frequency, or null if outside any band.
 */
export function getBandName(freq_hz: number): string | null {
  for (const br of BAND_RANGES) {
    if (freq_hz >= br.start_hz && freq_hz <= br.end_hz) {
      return br.band;
    }
  }
  return null;
}

/**
 * Get the band range boundaries for a named band.
 */
export function getBandRange(band: string): BandRange | null {
  return BAND_RANGES.find((br) => br.band === band) ?? null;
}

/**
 * Return all band plan segments for a given band name.
 */
export function getAllSegmentsForBand(band: string): BandSegment[] {
  return _segmentsByBand.get(band) ?? [];
}

/**
 * Return all segments that overlap with a frequency range.
 * Useful for the waterfall view where we need segments within the visible window.
 */
export function getSegmentsInRange(minHz: number, maxHz: number): BandSegment[] {
  return SEGMENTS.filter(
    (seg) => seg.end_hz > minHz && seg.start_hz < maxHz
  );
}

/**
 * Check whether a frequency is near a notable frequency (±1 kHz).
 */
export function getNotableFrequency(freq_hz: number, tolerance_hz = 1000): NotableFrequency | null {
  for (const nf of NOTABLE_FREQUENCIES) {
    if (Math.abs(freq_hz - nf.freq_hz) <= tolerance_hz) {
      return nf;
    }
  }
  return null;
}

/**
 * Build a human-readable description: "2m FM Simplex" or "20m Phone" etc.
 * Returns null if the frequency is outside known amateur bands.
 */
export function describeBandSegment(freq_hz: number): string | null {
  const seg = getBandSegment(freq_hz);
  if (!seg) return null;
  return `${seg.band} ${seg.label}`;
}

/**
 * All known band names in order.
 */
export const ALL_BANDS = BAND_RANGES.map((br) => br.band);

/**
 * All band ranges exposed for external use.
 */
export { BAND_RANGES };
