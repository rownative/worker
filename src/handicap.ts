/**
 * Handicap scoring for challenge results.
 * Matches Rowsandall rowing-courses-spec.md / scoring.py:
 * - corrected_time = raw * (athlete_ref_speed / baseline_ref_speed)
 * - points = 100 * (2 - reference_speed / velo), velo = course_distance / raw_time
 */

export interface HandicapInput {
  rawTimeS: number;
  boatType: string;
  sex: string;
  weightClass?: string;
  /** Challenge course distance (m). Required for points; used for velo. */
  courseDistanceM?: number;
}

export interface HandicapResult {
  correctedTimeS: number;
  points: number;
}

/** Built-in standard times (seconds) for 500m. Reference: M1x HWT = 420s. */
const BUILTIN_STANDARDS: Record<string, Record<string, number>> = {
  hocr: {
    '1x-M-HWT': 420,
    '1x-M-LWT': 435,
    '1x-F-HWT': 450,
    '1x-F-LWT': 465,
    '2x-M-HWT': 390,
    '2x-M-LWT': 405,
    '2x-F-HWT': 420,
    '2x-F-LWT': 435,
    '2--M-HWT': 400,
    '2--F-HWT': 435,
    '4x-M-HWT': 360,
    '4x-F-HWT': 390,
    '4--M-HWT': 375,
    '4--F-HWT': 405,
    '4+-M-HWT': 380,
    '4+-F-HWT': 410,
    '8+-M-HWT': 330,
    '8+-F-HWT': 360,
    '8+-M-LWT': 345,
    '8+-F-LWT': 375,
  },
  fisa: {
    '1x-M-HWT': 420,
    '1x-M-LWT': 435,
    '1x-F-HWT': 450,
    '1x-F-LWT': 465,
    '2x-M-HWT': 390,
    '2x-M-LWT': 405,
    '2x-F-HWT': 420,
    '2x-F-LWT': 435,
    '2--M-HWT': 400,
    '2--F-HWT': 435,
    '4x-M-HWT': 360,
    '4x-F-HWT': 390,
    '4--M-HWT': 375,
    '4--F-HWT': 405,
    '4+-M-HWT': 380,
    '4+-F-HWT': 410,
    '8+-M-HWT': 330,
    '8+-F-HWT': 360,
    '8+-M-LWT': 345,
    '8+-F-LWT': 375,
  },
  charles: {
    '1x-M-HWT': 420,
    '1x-M-LWT': 435,
    '1x-F-HWT': 450,
    '1x-F-LWT': 465,
    '2x-M-HWT': 390,
    '2x-F-HWT': 420,
    '4x-M-HWT': 360,
    '4x-F-HWT': 390,
    '8+-M-HWT': 330,
    '8+-F-HWT': 360,
  },
};

function categoryKey(boatType: string, sex: string, weightClass: string): string {
  const bt = (boatType || '1x').trim();
  const sx = (sex || 'M').trim().toUpperCase().slice(0, 1);
  const wc = (weightClass || 'HWT').trim().toUpperCase();
  return `${bt}-${sx}-${wc}`;
}

function lookupBuiltin(collectionId: string, boatType: string, sex: string, weightClass: string): number | null {
  const standards = BUILTIN_STANDARDS[collectionId.toLowerCase()];
  if (!standards) return null;
  const key = categoryKey(boatType, sex, weightClass);
  let val = standards[key];
  if (val != null) return val;
  val = standards[`${(boatType || '1x').trim()}-${(sex || 'M').trim().toUpperCase().slice(0, 1)}-HWT`];
  if (val != null) return val;
  return standards['1x-M-HWT'] ?? null;
}

export interface D1Database {
  prepare(query: string): { bind(...args: unknown[]): { first(): Promise<unknown>; all(): Promise<{ results?: unknown[] }> } };
}

/**
 * Compute handicap corrected time and points.
 * Returns null if challenge has no collection or category not found.
 */
export async function computeHandicap(
  collectionId: string | null,
  input: HandicapInput,
  db: D1Database | null
): Promise<HandicapResult | null> {
  if (!collectionId || !input.boatType || !input.sex) return null;

  const wc = (input.weightClass || 'HWT').trim() || 'HWT';
  let standardS: number | null = null;

  const builtin = ['hocr', 'fisa', 'charles'];
  let courseDistanceStd = 500;
  if (builtin.includes(collectionId.toLowerCase())) {
    standardS = lookupBuiltin(collectionId, input.boatType, input.sex, wc);
  } else if (db) {
    const row = await db
      .prepare(
        'SELECT standard_time_s, course_distance_m FROM course_standards WHERE collection_id = ? AND boat_type = ? AND sex = ? AND weight_class = ?'
      )
      .bind(collectionId, input.boatType.trim(), input.sex.trim().toUpperCase().slice(0, 1), wc)
      .first();
    if (row) {
      const r = row as { standard_time_s: number; course_distance_m?: number };
      standardS = r.standard_time_s;
      courseDistanceStd = r.course_distance_m ?? 500;
    }
    if (standardS == null) {
      const fallback = await db
        .prepare(
          'SELECT standard_time_s, course_distance_m FROM course_standards WHERE collection_id = ? AND boat_type = ? AND sex = ? AND weight_class = ?'
        )
        .bind(collectionId, input.boatType.trim(), input.sex.trim().toUpperCase().slice(0, 1), 'HWT')
        .first();
      if (fallback) {
        const f = fallback as { standard_time_s: number; course_distance_m?: number };
        standardS = f.standard_time_s;
        courseDistanceStd = f.course_distance_m ?? 500;
      }
    }
  }

  if (standardS == null || standardS <= 0) return null;

  const raw = input.rawTimeS;
  if (raw <= 0) return null;

  const referenceSpeed = courseDistanceStd / standardS;
  const baselineRefSpeed = 500 / 420;
  const correctedTimeS = raw * (referenceSpeed / baselineRefSpeed);

  const courseDistanceM = input.courseDistanceM ?? courseDistanceStd;
  const velo = courseDistanceM / raw;
  const points = 100 * (2 - referenceSpeed / velo);

  return { correctedTimeS, points };
}
