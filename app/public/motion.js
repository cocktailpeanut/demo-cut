export const MAX_POINTS = 100;
export const MIN_DURATION = 0.2;
export const RAMP_DURATION = 0.6;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const smoothstep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Validate and return a sorted copy. Times include the zoom-in and zoom-out. */
export function validatePoints(points, duration) {
  if (!Array.isArray(points)) throw new Error('Focus points must be a list.');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The recording has no usable duration.');
  if (points.length > MAX_POINTS) throw new Error(`A recording can have up to ${MAX_POINTS} focus points.`);
  const seen = new Set();
  const clean = points.map((point, index) => {
    const label = `Focus ${index + 1}`;
    if (!point || typeof point !== 'object') throw new Error(`${label} is invalid.`);
    if (typeof point.id !== 'string' || !point.id || point.id.length > 100 || seen.has(point.id)) {
      throw new Error('Every focus point needs a unique ID.');
    }
    seen.add(point.id);
    for (const key of ['time', 'duration', 'zoom', 'x', 'y']) {
      if (typeof point[key] !== 'number' || !Number.isFinite(point[key])) throw new Error(`${label}: ${key} must be a number.`);
    }
    if (point.time < 0 || point.duration < MIN_DURATION || point.time + point.duration > duration + 0.000001) {
      throw new Error(`${label} must last at least ${MIN_DURATION} seconds and fit inside the recording.`);
    }
    if (point.zoom < 1.1 || point.zoom > 4) throw new Error(`${label}: zoom must be between 1.1× and 4×.`);
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error(`${label} must be inside the picture.`);
    return { id: point.id, time: point.time, duration: Math.min(point.duration, duration - point.time), zoom: point.zoom, x: point.x, y: point.y };
  }).sort((a, b) => a.time - b.time);
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].time < clean[i - 1].time + clean[i - 1].duration - 0.000001) {
      throw new Error('Focus points overlap. Shorten one or move it to a different time.');
    }
  }
  return clean;
}

/** Crop origin (x/y) and zoom in normalized source coordinates. */
export function cameraAt(points, time) {
  const point = points.find((p) => time >= p.time && time <= p.time + p.duration);
  if (!point) return { zoom: 1, x: 0, y: 0 };
  const ramp = Math.min(RAMP_DURATION, point.duration / 2);
  const weight = Math.min(smoothstep((time - point.time) / ramp), smoothstep((point.time + point.duration - time) / ramp));
  const zoom = 1 + (point.zoom - 1) * weight;
  return { zoom, x: clamp(point.x - 0.5 / zoom, 0, 1 - 1 / zoom), y: clamp(point.y - 0.5 / zoom, 0, 1 - 1 / zoom) };
}
