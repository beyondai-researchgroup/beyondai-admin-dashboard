// Parsing + analysis for the CSV produced by the EmotivEEG_DataCollecting console app
// (Emotiv Insight 5, via Cortex API's "pow" band-power stream — NOT raw voltage, so there is no
// FFT/DSP step here, just arithmetic over already-computed band-power values). Kept separate
// from eeg/routes.mjs (HTTP concerns) the same way results/aggregate.mjs is kept separate from
// results/routes.mjs.
//
// CSV quirks this has to tolerate (confirmed by reading the collector app's source):
//  - Marker rows (AI_START/REPORT_START/DECISION) are mixed into the same file as data rows —
//    every field after the timestamp is just the marker code repeated, with a leading space on
//    the first few fields that plain data rows don't have. Detected here by checking whether the
//    "signal_quality" field parses as a number.
//  - Pauses between sessions leave a real gap in consecutive timestamps, with no explicit marker.

// The exact Research.EegDeviceType value that opts a participant's recording into this
// module's parsing/interpretation — must match configuration.component.ts's EEG_DEVICE_INSIGHT5
// literal exactly (that's the single source of truth for the value written to the DB; this is
// the single source of truth for what value the backend treats as parseable).
export const RECOGNIZED_DEVICE = 'Emotiv Insight 5';

export const CHANNELS = ['AF3', 'T7', 'Pz', 'T8', 'AF4'];
export const BANDS = ['theta', 'alpha', 'betaL', 'betaH', 'gamma'];

const EXPECTED_HEADER = [
  'timestamp', 'participantId', 'sessionNumber', 'signal_quality',
  ...CHANNELS.flatMap((ch) => BANDS.map((b) => `${ch}/${b}`)),
];

const SEGMENT_LABEL_BY_MARKER_CODE = { AI_START: 'AI', REPORT_START: 'Report' };

/** "yyyy-MM-dd HH:mm:ss.fff" -> epoch ms. Falls back to NaN for anything unparseable. */
function toEpochMs(timestamp) {
  return new Date(timestamp.replace(' ', 'T')).getTime();
}

function computeIndices(pow) {
  let engagementSum = 0;
  let engagementCount = 0;
  for (const ch of CHANNELS) {
    const denom = pow[`${ch}/theta`] + pow[`${ch}/alpha`];
    if (denom > 0) {
      engagementSum += (pow[`${ch}/betaL`] + pow[`${ch}/betaH`]) / denom;
      engagementCount++;
    }
  }

  let cognitiveLoadSum = 0;
  let cognitiveLoadCount = 0;
  for (const ch of ['AF3', 'AF4']) {
    const alpha = pow[`${ch}/alpha`];
    if (alpha > 0) {
      cognitiveLoadSum += pow[`${ch}/theta`] / alpha;
      cognitiveLoadCount++;
    }
  }

  return {
    engagement: engagementCount ? engagementSum / engagementCount : null,
    cognitiveLoad: cognitiveLoadCount ? cognitiveLoadSum / cognitiveLoadCount : null,
    frontalAsymmetry: pow['AF4/alpha'] - pow['AF3/alpha'],
  };
}

/** Per-band average across all 5 channels, e.g. bandAverages.theta = avg(AF3/theta..AF4/theta). */
function computeBandAverages(pow) {
  const avg = {};
  for (const band of BANDS) {
    let sum = 0;
    let count = 0;
    for (const ch of CHANNELS) {
      const v = pow[`${ch}/${band}`];
      if (v !== null && v !== undefined && !Number.isNaN(v)) {
        sum += v;
        count++;
      }
    }
    avg[band] = count ? sum / count : null;
  }
  return avg;
}

/**
 * Parses a raw CSV string. Returns `{ recognized: false }` for anything that isn't exactly the
 * Insight-5 29-column POW header — a future non-Insight-5 device's CSV just won't get
 * interpretation, but keeps working with the generic column preview/chart elsewhere.
 */
export function parseInsight5Csv(rawCsv) {
  const lines = rawCsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { recognized: false };

  const header = lines[0].split(',').map((h) => h.trim());
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((h, i) => h === header[i])) {
    return { recognized: false };
  }

  const markers = [];
  const dataRows = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',').map((f) => f.trim());
    if (fields.length < EXPECTED_HEADER.length) continue; // malformed/truncated line — skip

    const signalQuality = Number(fields[3]);
    if (Number.isNaN(signalQuality)) {
      markers.push({ code: fields[3], timestamp: fields[0], timeMs: toEpochMs(fields[0]) });
      continue;
    }

    const pow = {};
    let ok = true;
    for (let c = 0; c < CHANNELS.length && ok; c++) {
      for (let b = 0; b < BANDS.length; b++) {
        const v = Number(fields[4 + c * BANDS.length + b]);
        if (Number.isNaN(v)) { ok = false; break; }
        pow[`${CHANNELS[c]}/${BANDS[b]}`] = v;
      }
    }
    if (!ok) continue;

    dataRows.push({
      timestamp: fields[0],
      timeMs: toEpochMs(fields[0]),
      signalQuality,
      indices: computeIndices(pow),
      bandAverages: computeBandAverages(pow),
    });
  }

  return { recognized: true, markers, dataRows };
}

function avgOf(vals) {
  const clean = vals.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function avgIndex(rows, field) {
  return avgOf(rows.map((r) => r.indices[field]));
}

function avgBand(rows, band) {
  return avgOf(rows.map((r) => r.bandAverages[band]));
}

/** Device-reported Cortex contact-quality (0-100%) — the one metric here that needs no derivation,
 *  averaged the same null-tolerant way as the composite indices/bands above. Exported so
 *  routes.mjs can compute the whole-recording figure the same way segments compute theirs. */
export function avgSignalQuality(rows) {
  return avgOf(rows.map((r) => r.signalQuality));
}

/** Centered moving average over a null-tolerant window — smooths the bin-to-bin jitter in the
 *  downsampled series (ratio metrics like Engagement/Cognitive Load are noisy at ~600-point
 *  resolution) without touching the true per-segment means computed above from unsmoothed rows. */
function movingAverage(values, windowSize = 9) {
  const half = Math.floor(windowSize / 2);
  return values.map((_, i) => avgOf(values.slice(Math.max(0, i - half), i + half + 1)));
}

/**
 * Segments the recording using AI_START/REPORT_START markers: everything before the first one is
 * a "Uvod" (baseline) segment; each AI_START/REPORT_START opens a segment that runs until the
 * next marker (typically DECISION) or the next AI_START/REPORT_START, whichever comes first.
 */
export function buildSegments(markers, dataRows) {
  if (!dataRows.length) return [];

  const boundaries = markers
    .filter((m) => m.code in SEGMENT_LABEL_BY_MARKER_CODE)
    .sort((a, b) => a.timeMs - b.timeMs);
  const otherMarkerTimes = markers
    .filter((m) => !(m.code in SEGMENT_LABEL_BY_MARKER_CODE))
    .map((m) => m.timeMs)
    .sort((a, b) => a - b);

  const segments = [];
  const firstBoundaryMs = boundaries.length ? boundaries[0].timeMs : Infinity;

  const baselineRows = dataRows.filter((r) => r.timeMs < firstBoundaryMs);
  if (baselineRows.length) {
    segments.push({
      label: 'Uvod',
      avgIndices: { engagement: avgIndex(baselineRows, 'engagement'), cognitiveLoad: avgIndex(baselineRows, 'cognitiveLoad'), frontalAsymmetry: avgIndex(baselineRows, 'frontalAsymmetry') },
      avgSignalQuality: avgSignalQuality(baselineRows),
    });
  }

  for (let i = 0; i < boundaries.length; i++) {
    const startMs = boundaries[i].timeMs;
    const nextBoundaryMs = i + 1 < boundaries.length ? boundaries[i + 1].timeMs : Infinity;
    const nextOtherMarkerMs = otherMarkerTimes.find((t) => t > startMs) ?? Infinity;
    const endMs = Math.min(nextBoundaryMs, nextOtherMarkerMs);

    const rows = dataRows.filter((r) => r.timeMs >= startMs && r.timeMs < endMs);
    if (rows.length) {
      segments.push({
        label: SEGMENT_LABEL_BY_MARKER_CODE[boundaries[i].code],
        avgIndices: { engagement: avgIndex(rows, 'engagement'), cognitiveLoad: avgIndex(rows, 'cognitiveLoad'), frontalAsymmetry: avgIndex(rows, 'frontalAsymmetry') },
        avgSignalQuality: avgSignalQuality(rows),
      });
    }
  }

  return segments;
}

/** Bins dataRows into ~maxPoints windows (averaging each index/band per bin) so a 10-20 min
 *  recording at 8Hz (~5-10k rows) renders as a smooth chart instead of a huge/laggy one. */
export function downsampleSeries(dataRows, maxPoints = 600) {
  if (!dataRows.length) {
    return {
      timestamps: [], elapsedSeconds: [], engagement: [], cognitiveLoad: [], frontalAsymmetry: [],
      bands: { theta: [], alpha: [], betaL: [], betaH: [], gamma: [] },
    };
  }

  const binSize = Math.max(1, Math.ceil(dataRows.length / maxPoints));
  const startMs = dataRows[0].timeMs;
  const timestamps = [];
  const elapsedSeconds = [];
  const engagement = [];
  const cognitiveLoad = [];
  const frontalAsymmetry = [];
  const bands = { theta: [], alpha: [], betaL: [], betaH: [], gamma: [] };

  for (let i = 0; i < dataRows.length; i += binSize) {
    const bin = dataRows.slice(i, i + binSize);
    const mid = bin[Math.floor(bin.length / 2)];
    timestamps.push(mid.timestamp);
    // X-axis for both EEG time-series charts: ordinal second since the recording's first row —
    // computed here off the already-parsed timeMs rather than re-parsing the timestamp string on
    // the frontend, which turned out to be unreliable across browsers/formats.
    elapsedSeconds.push(Number.isFinite(mid.timeMs) ? Math.round((mid.timeMs - startMs) / 1000) : null);
    engagement.push(avgIndex(bin, 'engagement'));
    cognitiveLoad.push(avgIndex(bin, 'cognitiveLoad'));
    frontalAsymmetry.push(avgIndex(bin, 'frontalAsymmetry'));
    for (const band of BANDS) bands[band].push(avgBand(bin, band));
  }

  // Smoothing pass over the binned series only — a rendering concern, not a change to the
  // per-segment true means computed by buildSegments() from unsmoothed rows.
  const smoothedBands = {};
  for (const band of BANDS) smoothedBands[band] = movingAverage(bands[band]);

  return {
    timestamps,
    elapsedSeconds,
    engagement: movingAverage(engagement),
    cognitiveLoad: movingAverage(cognitiveLoad),
    frontalAsymmetry: movingAverage(frontalAsymmetry),
    bands: smoothedBands,
  };
}
