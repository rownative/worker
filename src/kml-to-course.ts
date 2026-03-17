/**
 * KML to course JSON converter.
 * Port of Rowsandall courses.py kmltocourse / crewnerdcourse / get_polygons logic.
 * Uses regex parsing (no DOMParser — not available in Cloudflare Workers).
 */

export interface CoursePolygon {
  name: string;
  order: number;
  points: Array<{ lat: number; lon: number }>;
}

export interface CourseFromKml {
  id: string;
  name: string;
  country: string;
  center_lat: number;
  center_lon: number;
  distance_m: number;
  notes: string;
  status: string;
  submitted_by?: string;
  polygons: CoursePolygon[];
}

function parseCoordinates(text: string): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];
  const tokens = text.trim().split(/\s+/);
  for (const t of tokens) {
    const parts = t.split(',');
    if (parts.length >= 2) {
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        points.push({ lat, lon });
      }
    }
  }
  return points;
}

function getPolarAngle(p: { lat: number; lon: number }, cx: number, cy: number): number {
  return Math.atan2(p.lat - cx, p.lon - cy);
}

function sortCoordinatesCcw(points: Array<{ lat: number; lon: number }>): Array<{ lat: number; lon: number }> {
  if (points.length < 3) return points;
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.lat, 0) / n;
  const cy = points.reduce((s, p) => s + p.lon, 0) / n;
  return [...points].sort((a, b) => getPolarAngle(a, cx, cy) - getPolarAngle(b, cx, cy));
}

function polygonCentroid(points: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  const n = points.length;
  if (n === 0) return { lat: 0, lon: 0 };
  const lat = points.reduce((s, p) => s + p.lat, 0) / n;
  const lon = points.reduce((s, p) => s + p.lon, 0) / n;
  return { lat, lon };
}

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000; // m
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Extract text between XML tags (handles namespaced and non-namespaced).
 */
function extractTag(html: string, tagName: string): string {
  const re = new RegExp(`<[^>]*:?${tagName}[^>]*>([\\s\\S]*?)</[^>]*:?${tagName}>`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Parse KML string and convert to course JSON.
 * Supports Folder with Placemarks or Document with Placemarks.
 * Uses regex parsing — works in Cloudflare Workers (no DOMParser).
 */
export function kmlToCourse(kmlText: string, courseId: string): CourseFromKml | null {
  // Prefer Folder; fallback to Document
  let container = kmlText.match(/<Folder[^>]*>([\s\S]*?)<\/Folder>/);
  if (!container) {
    container = kmlText.match(/<Document[^>]*>([\s\S]*?)<\/Document>/);
  }
  const inner = container?.[1] ?? kmlText;

  const name = extractTag(inner, 'name') || 'Imported course';
  const description = extractTag(inner, 'description') || '';

  // Find all Placemarks
  const placemarkRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  const placemarks: string[] = [];
  let pm;
  while ((pm = placemarkRe.exec(inner)) !== null) {
    placemarks.push(pm[1]);
  }

  if (placemarks.length < 2) return null;

  const polygons: CoursePolygon[] = [];
  for (let i = 0; i < placemarks.length; i++) {
    const pmXml = placemarks[i];
    const pmName = extractTag(pmXml, 'name') || `Polygon ${i}`;
    const coordText = extractTag(pmXml, 'coordinates');
    const pts = parseCoordinates(coordText);
    const sorted = sortCoordinatesCcw(pts);
    if (sorted.length >= 3) {
      polygons.push({ name: pmName, order: i, points: sorted });
    }
  }

  if (polygons.length < 2) return null;

  return buildCourse(courseId, name, description, polygons);
}

function buildCourse(
  id: string,
  name: string,
  notes: string,
  polygons: CoursePolygon[]
): CourseFromKml {
  const centroids = polygons.map((p) => polygonCentroid(p.points));
  const center_lat = centroids.reduce((s, c) => s + c.lat, 0) / centroids.length;
  const center_lon = centroids.reduce((s, c) => s + c.lon, 0) / centroids.length;

  let distance_m = 0;
  for (let i = 0; i < centroids.length - 1; i++) {
    distance_m += haversine(centroids[i], centroids[i + 1]);
  }
  distance_m = Math.round(Math.max(0, distance_m));

  const normalizedNotes = notes
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

  return {
    id,
    name,
    country: 'Unknown',
    center_lat,
    center_lon,
    distance_m,
    notes: normalizedNotes,
    status: 'provisional',
    submitted_by: 'migrated from Rowsandall',
    polygons: polygons.map((p, i) => ({ ...p, order: i })),
  };
}
