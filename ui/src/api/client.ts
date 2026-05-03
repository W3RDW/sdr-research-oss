import axios from "axios";

const api = axios.create({
  baseURL: "/api/v1",
});

export type FrequencyGroup = "ham" | "emergency" | "other" | string;

export interface FrequencyGroupInfo {
  frequency_group?: FrequencyGroup | null;
  frequency_group_label?: string | null;
}

export interface RepeaterInfo {
  id: number;
  callsign: string;
  location: string | null;
  county: string | null;
  state: string | null;
  frequency_hz: number;
  input_hz: number | null;
  pl_tone: number | null;
  digital_modes: string[];
  linked_nodes: string | null;
  use: string | null;
}

export interface OperatorInfo {
  callsign: string;
  name: string | null;
  qth_city: string | null;
  qth_state: string | null;
  license_class: string | null;
  grid: string | null;
}

export interface Recording extends FrequencyGroupInfo {
  id: number;
  filename: string;
  mode: "cw" | "voice" | "aprs" | "hfdl" | "sstv" | string;
  frequency_hz: number | null;
  frequency_label?: string | null;
  timestamp: string | null;
  duration_seconds: number | null;
  has_transcript?: boolean;
  transcript_status?: "yes" | "pending" | "no";
  transcript?: string;
  callsign_tags?: string[];
  ai_tags?: string[];
  tags?: string[];
  repeater?: RepeaterInfo | null;
  operators?: OperatorInfo[];
  notes?: string | null;
  dtmf_tones?: string | null;
  signal_db?: number | null;
  source_sdr?: string | null;
}

export interface RepeaterEntry {
  id: number;
  callsign: string;
  frequency_hz: number;
  input_hz: number | null;
  pl_tone: number | null;
  location: string | null;
  county: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  use: string | null;
  digital_modes: string[];
  linked_nodes: string | null;
  last_synced: string | null;
  last_heard: string | null;
}

export interface RepeaterBrowseResponse {
  total: number;
  page: number;
  limit: number;
  items: RepeaterEntry[];
}

export interface RepeaterBrowseParams {
  state?: string;
  callsign?: string;
  frequency_min?: number;
  frequency_max?: number;
  digital_only?: boolean;
  digital_mode?: string;
  page?: number;
  limit?: number;
}

export interface BrowseResponse {
  total: number;
  page: number;
  limit: number;
  items: Recording[];
}

export interface BrowseParams {
  mode?: string;
  frequency_min?: number;
  frequency_max?: number;
  q?: string;
  callsign?: string;
  tag?: string;
  repeater?: string;
  date_from?: string;
  date_to?: string;
  duration_min?: number;
  duration_max?: number;
  has_transcript?: boolean;
  transcript_pending?: boolean;
  page?: number;
  limit?: number;
}

export interface SearchResult extends Recording {
  headline: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  total: number;
  page: number;
  limit: number;
  items: SearchResult[];
}

export interface WaveformData {
  peaks: [number, number][];
  duration: number;
  sample_rate: number;
}

export async function browseFiles(params: BrowseParams): Promise<BrowseResponse> {
  const { data } = await api.get("/files/browse", { params });
  return data;
}

export async function getFile(id: number): Promise<Recording> {
  const { data } = await api.get(`/files/${id}`);
  return data;
}

export function getStreamUrl(id: number): string {
  return `/api/v1/files/${id}/stream`;
}

export async function getWaveform(id: number): Promise<WaveformData> {
  const { data } = await api.get(`/waveform/${id}`);
  return data;
}

export function getSpectrogramUrl(id: number): string {
  return `/api/v1/waveform/${id}/spectrogram`;
}

export async function searchText(params: {
  q: string;
  mode?: string;
  frequency_min?: number;
  frequency_max?: number;
  callsign?: string;
  date_from?: string;
  date_to?: string;
  has_transcript?: boolean;
  tag?: string;
  page?: number;
}): Promise<SearchResponse> {
  const { data } = await api.get("/search/text", { params });
  return data;
}

export async function deleteFile(id: number): Promise<{ deleted: number }> {
  const { data } = await api.delete(`/files/${id}`);
  return data;
}

export async function bulkDeleteFiles(
  ids: number[]
): Promise<{ deleted: number }> {
  const { data } = await api.post("/files/bulk-delete", { ids });
  return data;
}

export interface BulkDeleteFilteredParams {
  mode?: "cw" | "voice";
  frequency_min?: number;
  frequency_max?: number;
  q?: string;
  callsign?: string;
  date_from?: string;
  date_to?: string;
  duration_min?: number;
  duration_max?: number;
  has_transcript?: boolean;
  transcript_pending?: boolean;
  dry_run?: boolean;
}

export async function bulkDeleteFilteredFiles(
  params: BulkDeleteFilteredParams
): Promise<{ matched: number; deleted: number }> {
  const { data } = await api.post("/files/bulk-delete-filtered", params);
  return data;
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface FrequencyCount extends FrequencyGroupInfo {
  frequency_hz: number | null;
  label: string | null;
  count: number;
  is_grouped?: boolean;
  collapsed_labels?: string[];
}

export interface FrequencyGroupCount extends FrequencyGroupInfo {
  count: number;
}

export interface HourCount {
  hour: number;
  count: number;
}

export interface CallsignCount {
  callsign: string;
  count: number;
}

export interface StatsResponse {
  total_recordings: number;
  total_duration_seconds: number;
  by_mode: Record<string, number>;
  with_transcript: number;
  without_transcript: number;
  with_frequency_label: number;
  matched_to_repeater: number;
  total_repeaters_known: number;
  daily_last_30: DailyCount[];
  top_tags: TagCount[];
  top_frequency_groups?: FrequencyGroupCount[];
  top_frequencies: FrequencyCount[];
  by_hour: HourCount[];
  top_callsigns: CallsignCount[];
}

export async function getStats(): Promise<StatsResponse> {
  const { data } = await api.get("/stats");
  return data;
}

export interface AdminStatus {
  total_repeaters: number;
  last_repeater_sync: string | null;
  repeaters_by_state: Record<string, number>;
  total_recordings: number;
  pending_freq_label: number;
  pending_ai_tags: number;
  pending_transcripts: number;
  sdr_last_seen_seconds: number | null;
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const { data } = await api.get("/admin/status");
  return data;
}

export async function syncRepeaters(): Promise<{ status: string }> {
  const { data } = await api.post("/admin/sync-repeaters");
  return data;
}

export async function updateRecordingTags(
  id: number,
  aiTags: string[]
): Promise<{ id: number; ai_tags: string[]; callsign_tags: string[]; tags: string[] }> {
  const { data } = await api.patch(`/files/${id}`, { ai_tags: aiTags });
  return data;
}

export async function retagRecording(id: number): Promise<{ status: string }> {
  const { data } = await api.post(`/files/${id}/retag`);
  return data;
}

export async function retranscribeRecording(id: number): Promise<{ status: string }> {
  const { data } = await api.post(`/files/${id}/retranscribe`);
  return data;
}

export async function reclassifyRecordingMode(
  id: number,
  mode: "voice" | "cw"
): Promise<{ id: number; mode: string; status: string }> {
  const { data } = await api.patch(`/files/${id}/mode`, { mode });
  return data;
}

export async function listRepeaters(
  params: RepeaterBrowseParams
): Promise<RepeaterBrowseResponse> {
  const { data } = await api.get("/repeaters", { params });
  return data;
}

/** Fetch all repeaters with coordinates for the map view (up to 2000). */
export async function listAllRepeaters(): Promise<RepeaterEntry[]> {
  const { data } = await api.get("/repeaters", {
    params: { limit: 2000, page: 1 },
  });
  return (data.items as RepeaterEntry[]).filter(
    (r) => r.latitude != null && r.longitude != null
  );
}

export async function backfillFrequency(
  limit = 500
): Promise<{ scanned: number; updated: number }> {
  const { data } = await api.post("/admin/backfill-frequency", null, {
    params: { limit },
  });
  return data;
}

export interface AprsWeather {
  wind_dir_deg: number | null;
  wind_speed_mph: number | null;
  wind_gust_mph: number | null;
  temp_f: number | null;
  rain_1h_in: number | null;
  rain_24h_in: number | null;
  humidity_pct: number | null;
  pressure_mbar: number | null;
}

export interface AprsStation {
  callsign: string;
  path: string;
  latitude: number | null;
  longitude: number | null;
  speed_kt: number | null;
  course: number | null;
  altitude_ft: number | null;
  comment: string;
  packet: string;
  last_heard: string | null;
  frequency_hz: number | null;
  is_weather?: boolean;
  weather?: AprsWeather | null;
}

export interface AprsPacket {
  callsign: string;
  path: string;
  latitude: number | null;
  longitude: number | null;
  speed_kt: number | null;
  course: number | null;
  altitude_ft: number | null;
  comment: string;
  packet: string;
  id: number;
  timestamp: string | null;
  frequency_hz: number | null;
  is_weather?: boolean;
  weather?: AprsWeather | null;
}

export interface AprsStationsResponse {
  stations: AprsStation[];
  hours: number;
}

export interface AprsPacketsResponse {
  packets: AprsPacket[];
  total: number;
  page: number;
  limit: number;
}

export interface AprsTrackPosition {
  lat: number;
  lon: number;
  timestamp: string | null;
}

export interface AprsTrack {
  callsign: string;
  positions: AprsTrackPosition[];
}

export interface AprsTracksResponse {
  tracks: AprsTrack[];
  hours: number;
}

export async function listAprsStations(hours = 24): Promise<AprsStationsResponse> {
  const { data } = await api.get("/aprs/stations", { params: { hours } });
  return data;
}

export async function listAprsTracks(hours = 24): Promise<AprsTracksResponse> {
  const { data } = await api.get("/aprs/tracks", { params: { hours } });
  return data;
}

export async function getStationCenter(): Promise<{ latitude: number; longitude: number }> {
  const { data } = await api.get("/repeaters/station");
  return data;
}

export async function listAprsPackets(params: {
  callsign?: string;
  hours?: number;
  page?: number;
  limit?: number;
}): Promise<AprsPacketsResponse> {
  const { data } = await api.get("/aprs/packets", { params });
  return data;
}

// Alert history
export interface AlertHistoryEntry {
  id: number;
  timestamp: string | null;
  recording_id: number | null;
  filename: string | null;
  frequency_hz: number | null;
  frequency_label: string | null;
  transcript_excerpt: string | null;
  matched: string[];
}

export interface AlertsResponse {
  total: number;
  items: AlertHistoryEntry[];
}

export async function listAlerts(limit = 100): Promise<AlertsResponse> {
  const { data } = await api.get("/admin/alerts", { params: { limit } });
  return data;
}

export async function resendAlert(id: number): Promise<{ status: string; alert_id: number }> {
  const { data } = await api.post(`/admin/alerts/${id}/resend`);
  return data;
}

// Alert rules
export interface AlertRule {
  id: number;
  rule_type: "keyword" | "callsign";
  value: string;
  enabled: boolean;
  notes: string | null;
  created_at: string;
}

export interface AlertRulesResponse {
  items: AlertRule[];
}

export async function listAlertRules(): Promise<AlertRulesResponse> {
  const { data } = await api.get("/admin/alert-rules");
  return data;
}

export async function createAlertRule(body: {
  rule_type: string;
  value: string;
  notes?: string;
}): Promise<AlertRule> {
  const { data } = await api.post("/admin/alert-rules", body);
  return data;
}

export async function toggleAlertRule(
  id: number,
  enabled: boolean
): Promise<{ id: number; enabled: boolean }> {
  const { data } = await api.patch(`/admin/alert-rules/${id}`, null, {
    params: { enabled },
  });
  return data;
}

export async function deleteAlertRule(id: number): Promise<{ deleted: number }> {
  const { data } = await api.delete(`/admin/alert-rules/${id}`);
  return data;
}

// Storage stats
export interface StorageStats {
  audio_bytes: number;
  audio_files: number;
  cache_bytes: number;
  free_bytes: number;
  total_bytes: number;
}

export async function getStorageStats(): Promise<StorageStats> {
  const { data } = await api.get("/admin/storage");
  return data;
}

// Retention
export async function runRetention(
  days: number,
  dry_run = false,
  mode?: string
): Promise<{ days: number; cutoff: string; matched: number; deleted: number }> {
  const { data } = await api.post("/admin/retention", null, {
    params: { days, dry_run, ...(mode ? { mode } : {}) },
  });
  return data;
}

// Frequency labels
export interface FrequencyLabelEntry {
  id: number;
  frequency_hz: number;
  bandwidth_hz: number | null;
  label: string;
  mode: string | null;
  notes: string | null;
  created_at: string | null;
}

export interface FrequencyLabelsResponse {
  items: FrequencyLabelEntry[];
}

export async function listFrequencyLabels(): Promise<FrequencyLabelsResponse> {
  const { data } = await api.get("/admin/frequency-labels");
  return data;
}

export async function createFrequencyLabel(body: {
  frequency_hz: number;
  bandwidth_hz?: number;
  label: string;
  mode?: string;
  notes?: string;
}): Promise<FrequencyLabelEntry> {
  const { data } = await api.post("/admin/frequency-labels", body);
  return data;
}

export async function deleteFrequencyLabel(id: number): Promise<{ deleted: number }> {
  const { data } = await api.delete(`/admin/frequency-labels/${id}`);
  return data;
}

// Callsign activity
export interface CallsignActivityResponse {
  callsign: string;
  total: number;
  items: Recording[];
}

export async function getCallsignActivity(
  callsign: string,
  page = 1,
  limit = 50
): Promise<CallsignActivityResponse> {
  const { data } = await api.get("/files/browse", {
    params: { callsign, page, limit },
  });
  return { callsign, total: data.total, items: data.items };
}

// Callsign info (operator card + stats)
export interface CallsignOperator {
  name: string | null;
  qth_city: string | null;
  qth_state: string | null;
  license_class: string | null;
  grid: string | null;
}

export interface CallsignInfoResponse {
  callsign: string;
  operator: CallsignOperator | null;
  total_recordings: number;
  first_heard: string | null;
  last_heard: string | null;
  total_airtime_seconds: number;
}

export async function getCallsignInfo(callsign: string): Promise<CallsignInfoResponse> {
  const { data } = await api.get(`/files/callsign/${callsign}`);
  return data;
}

// File neighbors (prev/next by timestamp)
export interface FileNeighbors {
  prev_id: number | null;
  next_id: number | null;
}

export async function getFileNeighbors(id: number): Promise<FileNeighbors> {
  const { data } = await api.get(`/files/${id}/neighbors`);
  return data;
}

// Related recordings (same freq ±10kHz, ±1 hour)
export interface RelatedRecordingsResponse {
  items: Recording[];
  count: number;
}

export async function getRelatedRecordings(id: number): Promise<RelatedRecordingsResponse> {
  const { data } = await api.get(`/files/${id}/related`);
  return data;
}

// Update transcript
export async function updateTranscript(
  id: number,
  transcript: string
): Promise<{ id: number; transcript: string | null }> {
  const { data } = await api.patch(`/files/${id}`, { transcript });
  return data;
}

// SDR health
export interface SdrHealth {
  band: "all" | "2m" | "70cm";
  last_seen_seconds: number | null;
  last_seen_at: string | null;
  healthy: boolean;
  status: string;
}

export async function getSdrHealth(band?: "2m" | "70cm"): Promise<SdrHealth> {
  const { data } = await api.get("/admin/sdr-health", {
    params: band ? { band } : undefined,
  });
  return data;
}

// Bulk re-transcribe
export async function bulkRetranscribe(
  clear_no_speech_only = true
): Promise<{ cleared: number; mode: string }> {
  const { data } = await api.post("/admin/bulk-retranscribe", null, {
    params: { clear_no_speech_only },
  });
  return data;
}

// Callsign / name lookup (FCC ULS)
export interface CallsignSearchResult {
  callsign: string;
  name: string | null;
  status: string;
  expired_date: string | null;
}

export interface CallsignSearchResponse {
  query: string;
  results: CallsignSearchResult[];
  total: number;
}

export async function searchCallsign(q: string): Promise<CallsignSearchResponse> {
  const { data } = await api.get("/search/callsign", { params: { q } });
  return data;
}

// Webhook test
export async function testWebhook(): Promise<{ message: string }> {
  const { data } = await api.post("/admin/test-webhook");
  return data;
}

// Alert dry-run
export interface AlertDryRunMatch {
  id: number;
  filename: string;
  matched_rule: string;
  timestamp: string | null;
}

export interface AlertDryRunResponse {
  matches: AlertDryRunMatch[];
  checked: number;
}

export async function getAlertDryRun(limit = 500): Promise<AlertDryRunResponse> {
  const { data } = await api.get("/admin/alert-dryrun", { params: { limit } });
  return data;
}

// Tag list for autocomplete
export interface TagEntry {
  tag: string;
  count: number;
}

export async function listTags(): Promise<TagEntry[]> {
  const { data } = await api.get("/files/tags/list");
  return data.tags ?? data;
}

// Notes
export async function updateNotes(
  id: number,
  notes: string | null
): Promise<{ id: number; notes: string | null }> {
  const { data } = await api.patch(`/files/${id}/notes`, { notes });
  return data;
}

// Export ZIP URL builder
export function buildExportZipUrl(params: {
  mode?: string;
  frequency_min?: number;
  frequency_max?: number;
  date_from?: string;
  date_to?: string;
  tag?: string;
  limit?: number;
}): string {
  const qs = new URLSearchParams();
  if (params.mode) qs.set("mode", params.mode);
  if (params.frequency_min != null) qs.set("frequency_min", String(params.frequency_min));
  if (params.frequency_max != null) qs.set("frequency_max", String(params.frequency_max));
  if (params.date_from) qs.set("date_from", params.date_from);
  if (params.date_to) qs.set("date_to", params.date_to);
  if (params.tag) qs.set("tag", params.tag);
  if (params.limit != null) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return `/api/v1/files/export-zip${q ? `?${q}` : ""}`;
}

// Bookmarks
export interface FrequencyBookmark {
  id: number;
  frequency_hz: number;
  bandwidth_hz: number;
  label: string;
  notes: string | null;
  alert_on_activity: boolean;
  created_at: string | null;
}

export interface BookmarksResponse {
  items: FrequencyBookmark[];
}

export async function listBookmarks(): Promise<BookmarksResponse> {
  const { data } = await api.get("/files/bookmarks");
  return data;
}

export async function createBookmark(body: {
  frequency_hz: number;
  bandwidth_hz?: number;
  label: string;
  notes?: string;
  alert_on_activity?: boolean;
}): Promise<FrequencyBookmark> {
  const { data } = await api.post("/files/bookmarks", body);
  return data;
}

export async function updateBookmark(
  id: number,
  body: Partial<Omit<FrequencyBookmark, "id" | "created_at">>
): Promise<FrequencyBookmark> {
  const { data } = await api.patch(`/files/bookmarks/${id}`, body);
  return data;
}

export async function deleteBookmark(id: number): Promise<{ deleted: number }> {
  const { data } = await api.delete(`/files/bookmarks/${id}`);
  return data;
}

// Activity heatmap
export interface ActivitySeries extends FrequencyGroupInfo {
  label: string;
  data: number[];
  total: number;
  is_grouped?: boolean;
  collapsed_labels?: string[];
}

export interface ActivityHeatmapResponse {
  days: number;
  hours: number[];
  series: ActivitySeries[];
}

export async function getActivityHeatmap(days = 30): Promise<ActivityHeatmapResponse> {
  const { data } = await api.get("/stats/activity", { params: { days } });
  return data;
}

// Similar recordings
export interface SimilarRecording {
  id: number;
  filename: string;
  mode: string;
  frequency_hz: number | null;
  frequency_label: string | null;
  timestamp: string | null;
  transcript: string;
  rank: number;
  ai_tags: string[];
}

export interface SimilarResponse {
  items: SimilarRecording[];
  total: number;
}

export async function getSimilarRecordings(
  id: number,
  limit = 10
): Promise<SimilarResponse> {
  const { data } = await api.get(`/search/similar/${id}`, { params: { limit } });
  return data;
}

// Voice callsign map overlay
export interface VoiceCallsign {
  callsign: string;
  name: string | null;
  latitude: number;
  longitude: number;
  qth_city: string | null;
  qth_state: string | null;
  grid: string | null;
  last_heard: string | null;
}

export interface VoiceCallsignsResponse {
  stations: VoiceCallsign[];
  total: number;
}

export async function listVoiceCallsigns(
  hours = 72
): Promise<VoiceCallsignsResponse> {
  const { data } = await api.get("/aprs/voice-callsigns", { params: { hours } });
  return data;
}

// Frequency detail stats
export interface FrequencyRepeater {
  id: number;
  callsign: string;
  frequency_hz: number;
  location: string | null;
  state: string | null;
  pl_tone: number | null;
  use: string | null;
}

export interface FrequencyStats {
  frequency_hz: number;
  tolerance_hz: number;
  label: string | null;
  recordings_total: number;
  by_mode: Record<string, number>;
  daily_last_30: { date: string; count: number }[];
  by_hour: { hour: number; count: number }[];
  top_callsigns: { callsign: string; count: number }[];
  repeaters: FrequencyRepeater[];
  recent_recordings: {
    id: number;
    mode: string;
    frequency_hz: number | null;
    timestamp: string | null;
    duration_seconds: number | null;
    has_transcript: boolean;
    transcript_status?: "yes" | "pending" | "no";
    frequency_label: string | null;
    signal_db: number | null;
  }[];
}

export async function getFrequencyStats(
  frequency_hz: number,
  tolerance_hz = 10000
): Promise<FrequencyStats> {
  const { data } = await api.get(`/stats/frequency/${frequency_hz}`, {
    params: { tolerance_hz },
  });
  return data;
}

// ADS-B aircraft (proxied from ultrafeeder)
export interface AircraftEntry {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  squawk?: string;
  category?: string;
  seen?: number;
  rssi?: number;
}

export interface AircraftResponse {
  now: number;
  messages: number;
  total: number;
  total_raw: number;
  aircraft: AircraftEntry[];
}

export async function listAircraft(
  min_altitude?: number,
  max_altitude?: number
): Promise<AircraftResponse> {
  const { data } = await api.get("/aprs/aircraft", {
    params: {
      ...(min_altitude != null ? { min_altitude } : {}),
      ...(max_altitude != null ? { max_altitude } : {}),
    },
  });
  return data;
}

// AIS marine vessels (proxied from ais-catcher)
export interface VesselEntry {
  mmsi: number;
  name?: string;
  callsign?: string;
  lat?: number;
  lon?: number;
  course?: number;
  speed?: number;
  shiptype?: number;
  status?: number;
  timestamp?: string;
}

export async function listAisVessels(): Promise<VesselEntry[]> {
  const { data } = await api.get("/aprs/ais/vessels");
  return data.vessels ?? data ?? [];
}

// Satellite tracking — TLE fetched via backend proxy, propagated with satellite.js
import * as sat from "satellite.js";

const TRACKED_SATELLITES = [
  { id: 25544, name: "ISS",          color: "#22d3ee" },
  { id: 48274, name: "CSS (Tianhe)", color: "#fb923c" },
  { id: 20580, name: "Hubble",       color: "#facc15" },
  { id: 33591, name: "NOAA-19",      color: "#86efac" },
  { id: 28654, name: "NOAA-18",      color: "#c084fc" },
  { id: 43013, name: "NOAA-20",      color: "#f472b6" },
];

export interface SatelliteData {
  id: number;
  name: string;
  color: string;
  latitude: number;
  longitude: number;
  altitude: number;   // km
  velocity: number;   // km/s
  timestamp: number;
  groundTrack: [number, number][][]; // polyline segments split at antimeridian
}

async function _fetchTle(noradId: number): Promise<{ name: string; line1: string; line2: string }> {
  const { data } = await api.get(`/aprs/satellites/tle/${noradId}`);
  return data;
}

function _propagate(
  satrec: sat.SatRec,
  start: Date,
  minutes: number,
  stepMin: number
): [number, number][] {
  const pts: [number, number][] = [];
  for (let t = 0; t <= minutes; t += stepMin) {
    const d = new Date(start.getTime() + t * 60_000);
    const pv = sat.propagate(satrec, d);
    if (!pv || !pv.position || typeof pv.position === "boolean") continue;
    const gmst = sat.gstime(d);
    const geo = sat.eciToGeodetic(pv.position as sat.EciVec3<number>, gmst);
    const lat = sat.degreesLat(geo.latitude);
    const lon = sat.degreesLong(geo.longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    pts.push([lat, lon]);
  }
  return pts;
}

function _splitAntimeridian(pts: [number, number][]): [number, number][][] {
  if (pts.length === 0) return [];
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i][1] - pts[i - 1][1]) > 180) {
      segs.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  if (cur.length > 0) segs.push(cur);
  return segs;
}

export async function fetchSatellitePositions(): Promise<SatelliteData[]> {
  const now = new Date();
  const results = await Promise.allSettled(
    TRACKED_SATELLITES.map(async ({ id, name, color }) => {
      const tle = await _fetchTle(id);
      const satrec = sat.twoline2satrec(tle.line1, tle.line2);

      // Current position
      const pv = sat.propagate(satrec, now);
      if (!pv || !pv.position || typeof pv.position === "boolean")
        throw new Error(`propagation failed for ${id}`);
      const gmst = sat.gstime(now);
      const geo = sat.eciToGeodetic(pv.position as sat.EciVec3<number>, gmst);
      const curLat = sat.degreesLat(geo.latitude);
      const curLon = sat.degreesLong(geo.longitude);
      if (!isFinite(curLat) || !isFinite(curLon))
        throw new Error(`NaN position for satellite ${id}`);

      // Velocity magnitude (km/s)
      const vel = pv.velocity;
      const speed =
        !vel || typeof vel === "boolean"
          ? 0
          : Math.sqrt((vel as sat.EciVec3<number>).x ** 2 + (vel as sat.EciVec3<number>).y ** 2 + (vel as sat.EciVec3<number>).z ** 2);

      // Ground track: next ~95 min (one LEO orbit), 1-min steps
      const rawTrack = _propagate(satrec, now, 95, 1);

      return {
        id,
        name: tle.name.trim() || name,
        color,
        latitude: curLat,
        longitude: curLon,
        altitude: geo.height,
        velocity: speed,
        timestamp: now.getTime() / 1000,
        groundTrack: _splitAntimeridian(rawTrack),
      } as SatelliteData;
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<SatelliteData> => r.status === "fulfilled")
    .map((r) => r.value);
}

// ── FT8/WSPR Spots ──────────────────────────────────────────────────
export interface Spot {
  id: number;
  timestamp: string;
  mode: string;          // ft8, ft4, wspr
  dial_frequency_hz: number;
  audio_offset_hz: number | null;
  snr_db: number | null;
  dt: number | null;
  callsign: string | null;
  grid: string | null;
  power_dbm: number | null;
  message: string | null;
  band: string | null;
  distance_km: number | null;
  tx_latitude: number | null;
  tx_longitude: number | null;
}

export interface SpotBrowseResponse {
  total: number;
  page: number;
  limit: number;
  items: Spot[];
}

export interface SpotMapResponse {
  spots: Spot[];
  total: number;
}

export interface BandActivity {
  band: string;
  mode: string;
  count: number;
}

export interface SpotStats {
  hours: number;
  total_spots: number;
  unique_callsigns: number;
  by_mode: Record<string, number>;
  by_band: { band: string; count: number }[];
  top_callsigns: { callsign: string; count: number }[];
  farthest: Spot[];
  by_hour: { hour: number; count: number }[];
}

export async function browseSpots(params: {
  mode?: string;
  band?: string;
  callsign?: string;
  hours?: number;
  page?: number;
  limit?: number;
}): Promise<SpotBrowseResponse> {
  const { data } = await api.get("/stats/spots/browse", { params });
  return data;
}

export async function getSpotMap(params: {
  mode?: string;
  band?: string;
  hours?: number;
  limit?: number;
}): Promise<SpotMapResponse> {
  const { data } = await api.get("/stats/spots/map", { params });
  return data;
}

export async function getSpotBands(hours = 1): Promise<{ hours: number; bands: BandActivity[] }> {
  const { data } = await api.get("/stats/spots/bands", { params: { hours } });
  return data;
}

export async function getSpotStats(hours = 24): Promise<SpotStats> {
  const { data } = await api.get("/stats/spots/stats", { params: { hours } });
  return data;
}

// Band activity (enhanced propagation view)
export interface BandCondition {
  band: string;
  spot_count: number;
  unique_callsigns: number;
  farthest_km: number | null;
  farthest_callsign: string | null;
  avg_snr: number | null;
  modes: string[];
  status: "open" | "marginal" | "closed";
  last_spot_at: string | null;
}

export async function getBandActivity(hours = 1): Promise<{ hours: number; bands: BandCondition[] }> {
  const { data } = await api.get("/stats/bands/activity", { params: { hours } });
  return data;
}

// Solar propagation data
export interface PropagationData {
  solar_flux_index: number | null;
  k_index: number | null;
  k_index_forecast: number[];
  bz: number | null;
  bt: number | null;
  hf_conditions: Record<string, string>;
  fetched_at: string | null;
  cached: boolean;
}

export async function getPropagation(): Promise<PropagationData> {
  const { data } = await api.get("/admin/propagation");
  return data;
}

// Daily digest
export async function getDigestStatus(): Promise<{ last_sent: string | null }> {
  const { data } = await api.get("/admin/digest-status");
  return data;
}

export async function sendDigestNow(): Promise<{ status: string; sent_at: string }> {
  const { data } = await api.post("/admin/send-digest");
  return data;
}

// ── Satellite pass prediction TLEs ──────────────────────────────────
export interface SatelliteFrequencyInfo {
  mhz: number;
  mode: string;
  direction: "uplink" | "downlink";
}

export interface SatelliteTleEntry {
  norad_id: number;
  name: string;
  tle_name: string;
  tle_line1: string;
  tle_line2: string;
  frequencies: SatelliteFrequencyInfo[];
}

export interface SatellitePassesResponse {
  station: { latitude: number | null; longitude: number | null };
  hours: number;
  min_elevation: number;
  satellites: SatelliteTleEntry[];
}

export async function getSatellitePasses(
  hours = 24,
  min_elevation = 10.0
): Promise<SatellitePassesResponse> {
  const { data } = await api.get("/admin/satellite-passes", {
    params: { hours, min_elevation },
  });
  return data;
}

// ── Live Spectrum / FFT Detection Data ────────────────────────────────
export interface SpectrumDetection {
  frequency_hz: number;
  power_db: number;
  bandwidth_hz: number;
  mode: string;
  recording: boolean;
}

export interface SpectrumCapture {
  capture_id: string;
  center_freq_hz: number;
  sample_rate: number;
  noise_floor_db: number | null;
  timestamp: number;
  age_seconds: number;
  stale: boolean;
  detections: SpectrumDetection[];
}

export interface SpectrumResponse {
  captures: SpectrumCapture[];
  error?: string;
}

export async function getSpectrum(captureId?: string): Promise<SpectrumResponse> {
  const { data } = await api.get("/admin/spectrum", {
    params: captureId ? { capture_id: captureId } : undefined,
  });
  return data;
}

// ── SSE (Server-Sent Events) ─────────────────────────────────────────
export interface EventStreamFilters {
  mode?: string;
  frequency_min?: number;
  frequency_max?: number;
  callsign?: string;
}

export interface RecordingEvent {
  id: number;
  mode: string;
  frequency_hz: number | null;
  frequency_label: string | null;
  timestamp: string | null;
  duration_seconds: number | null;
  has_transcript: boolean;
  transcript_status?: string;
  signal_db: number | null;
  callsign_tags?: string[];
  ai_tags?: string[];
}

/**
 * Build the SSE stream URL with optional query-parameter filters.
 *
 * Usage:
 *   const url = buildEventStreamUrl({ mode: "voice", frequency_min: 144000000, frequency_max: 148000000 });
 *   const es = new EventSource(url);
 *   es.onmessage = (e) => { const rec: RecordingEvent = JSON.parse(e.data); ... };
 */
export function buildEventStreamUrl(filters?: EventStreamFilters): string {
  const qs = new URLSearchParams();
  if (filters?.mode) qs.set("mode", filters.mode);
  if (filters?.frequency_min != null) qs.set("frequency_min", String(filters.frequency_min));
  if (filters?.frequency_max != null) qs.set("frequency_max", String(filters.frequency_max));
  if (filters?.callsign) qs.set("callsign", filters.callsign);
  const q = qs.toString();
  return `/api/v1/events/stream${q ? `?${q}` : ""}`;
}

// ─── Weather Intelligence (NWS / SPC proxy) ─────────────────────────

export type AlertSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";

export interface WeatherAlert {
  id: string;
  event: string | null;
  severity: AlertSeverity | null;
  urgency: string | null;
  certainty: string | null;
  status: string | null;
  messageType: string | null;
  category: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDesc: string | null;
  sent: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  ends: string | null;
  senderName: string | null;
  geometry: GeoJSON.Geometry | null;
}

export interface WeatherAlertsResponse {
  alerts: WeatherAlert[];
  count: number;
  lat: number;
  lon: number;
  fetched_at: string;
}

export interface MetarObservation {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
  distance_km: number;
  timestamp: string | null;
  temp_c: number | null;
  temp_f: number | null;
  dewpoint_c: number | null;
  dewpoint_f: number | null;
  humidity_pct: number | null;
  wind_dir_deg: number | null;
  wind_speed_kt: number | null;
  wind_gust_kt: number | null;
  wind_speed_mph: number | null;
  wind_gust_mph: number | null;
  visibility_mi: number | null;
  ceiling_ft: number | null;
  pressure_mbar: number | null;
  raw_metar: string | null;
  text_description: string | null;
  icon: string | null;
}

export interface MetarsResponse {
  metars: MetarObservation[];
  count: number;
  lat: number;
  lon: number;
  fetched_at: string;
}

export interface ForecastPeriod {
  name: string | null;
  start: string | null;
  end: string | null;
  is_daytime: boolean | null;
  temp: number | null;
  temp_unit: string | null;
  wind_speed: string | null;
  wind_dir: string | null;
  icon: string | null;
  short_forecast: string | null;
  detailed_forecast: string | null;
  precip_chance: number | null;
  humidity: number | null;
  dewpoint_c: number | null;
}

export interface ForecastResponse {
  lat: number;
  lon: number;
  office: string | null;
  grid_x: number | null;
  grid_y: number | null;
  city: string | null;
  state: string | null;
  updated: string | null;
  hourly: boolean;
  periods: ForecastPeriod[];
  fetched_at: string;
}

export interface SpcOutlookResponse {
  day: 1 | 2 | 3;
  layer: "cat" | "torn" | "hail" | "wind" | "prob";
  geojson: GeoJSON.FeatureCollection | null;
  fetched_at: string;
}

export interface StormReport {
  type: "tornado" | "hail" | "wind" | "other";
  time: string | null;
  magnitude: string | null;
  location: string | null;
  county: string | null;
  state: string | null;
  lat: number;
  lon: number;
  comments: string;
}

export interface StormReportsResponse {
  date: string;
  reports: StormReport[];
  by_type: { tornado: number; hail: number; wind: number };
  count: number;
  fetched_at: string;
}

export interface MesoscaleDiscussion {
  title: string | null;
  link: string | null;
  pub_date: string | null;
  description: string | null;
}

export interface MesoscaleDiscussionsResponse {
  items: MesoscaleDiscussion[];
  count: number;
  fetched_at: string;
}

export async function getWeatherAlerts(lat?: number, lon?: number): Promise<WeatherAlertsResponse> {
  const { data } = await api.get("/stats/weather/alerts", { params: { lat, lon } });
  return data;
}

export async function getMetars(params: {
  lat?: number;
  lon?: number;
  radius_km?: number;
  limit?: number;
}): Promise<MetarsResponse> {
  const { data } = await api.get("/stats/weather/metars", { params });
  return data;
}

export async function getForecast(params: {
  lat?: number;
  lon?: number;
  hourly?: boolean;
}): Promise<ForecastResponse> {
  const { data } = await api.get("/stats/weather/forecast", { params });
  return data;
}

export async function getSpcOutlook(day: 1 | 2 | 3 = 1, layer = "cat"): Promise<SpcOutlookResponse> {
  const { data } = await api.get("/stats/weather/spc-outlook", { params: { day, layer } });
  return data;
}

export async function getStormReports(date: "today" | "yesterday" | string = "today"): Promise<StormReportsResponse> {
  const { data } = await api.get("/stats/weather/storm-reports", { params: { date } });
  return data;
}

export async function getMesoscaleDiscussions(): Promise<MesoscaleDiscussionsResponse> {
  const { data } = await api.get("/stats/weather/mesoscale-discussions");
  return data;
}

export default api;
