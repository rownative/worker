import { describe, it, expect } from 'vitest';
import { kmlToCourse, type CourseFromKml } from '../src/kml-to-course';

const MINIMAL_VALID_KML = `
<Folder>
  <name>Test Course</name>
  <Placemark>
    <name>Start</name>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>-71.746,42.247 -71.746,42.246 -71.745,42.246 -71.746,42.247</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark>
    <name>Finish</name>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>-71.756,42.294 -71.756,42.294 -71.757,42.294 -71.756,42.294</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Folder>
`;

describe('kmlToCourse', () => {
	it('converts valid KML with Folder and two Placemarks', () => {
		const result = kmlToCourse(MINIMAL_VALID_KML, '42');
		expect(result).not.toBeNull();
		const course = result as CourseFromKml;
		expect(course.id).toBe('42');
		expect(course.name).toBe('Test Course');
		expect(course.country).toBe('Unknown');
		expect(course.status).toBe('provisional');
		expect(course.submitted_by).toBe('migrated from Rowsandall');
		expect(course.polygons).toHaveLength(2);
		expect(course.polygons[0].name).toBe('Start');
		expect(course.polygons[0].order).toBe(0);
		expect(course.polygons[1].name).toBe('Finish');
		expect(course.polygons[1].order).toBe(1);
		expect(course.polygons.every((p) => p.points.length >= 3)).toBe(true);
		expect(typeof course.center_lat).toBe('number');
		expect(typeof course.center_lon).toBe('number');
		expect(typeof course.distance_m).toBe('number');
		expect(course.distance_m).toBeGreaterThanOrEqual(0);
	});

	it('falls back to Document when no Folder', () => {
		const kml = `
<Document>
  <name>Doc Course</name>
  <Placemark><name>Start</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 0,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>Finish</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 1,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document>
`;
		const result = kmlToCourse(kml, '99');
		expect(result).not.toBeNull();
		expect((result as CourseFromKml).name).toBe('Doc Course');
		expect((result as CourseFromKml).polygons).toHaveLength(2);
	});

	it('returns null when fewer than 2 Placemarks', () => {
		const kml = `
<Folder>
  <Placemark>
    <name>Start</name>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 0,1</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Folder>
`;
		expect(kmlToCourse(kml, '1')).toBeNull();
	});

	it('returns null when Placemarks have fewer than 2 polygons (one degenerate)', () => {
		// Two Placemarks but only one has enough points for a polygon
		const kml = `
<Folder>
  <Placemark><name>Start</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 0,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>Finish</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
`;
		expect(kmlToCourse(kml, '1')).toBeNull();
	});

	it('returns null for empty KML', () => {
		expect(kmlToCourse('', '1')).toBeNull();
	});

	it('returns null for KML with no Folder or Document', () => {
		const kml = '<kml><Placemark><name>X</name></Placemark></kml>';
		expect(kmlToCourse(kml, '1')).toBeNull();
	});

	it('uses "Imported course" when no name in container', () => {
		const kml = `
<Folder>
  <Placemark><name>Start</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 0,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>Finish</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 1,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
`;
		const result = kmlToCourse(kml, '1');
		expect(result).not.toBeNull();
		expect((result as CourseFromKml).name).toBe('Imported course');
	});

	it('normalizes description/notes (newlines)', () => {
		const kml = `
<Folder>
  <name>Named</name>
  <description>Line 1\r\nLine 2\rLine 3</description>
  <Placemark><name>Start</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 0,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>Finish</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 1,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
`;
		const result = kmlToCourse(kml, '1');
		expect(result).not.toBeNull();
		expect((result as CourseFromKml).notes).toBe('Line 1\nLine 2\nLine 3');
	});


	it('parses KML coordinates (lon,lat) correctly', () => {
		const kml = `
<Folder>
  <Placemark><name>Start</name><Polygon><outerBoundaryIs><LinearRing><coordinates>4.927,52.35 4.928,52.3505 4.9275,52.3495</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>Finish</name><Polygon><outerBoundaryIs><LinearRing><coordinates>4.930,52.352 4.931,52.3525 4.9305,52.3515</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
`;
		const result = kmlToCourse(kml, '1');
		expect(result).not.toBeNull();
		const start = (result as CourseFromKml).polygons[0].points;
		expect(start.length).toBe(3);
		expect(start[0]).toEqual({ lat: 52.35, lon: 4.927 });
		expect(start[1]).toEqual({ lat: 52.3505, lon: 4.928 });
	});
});
