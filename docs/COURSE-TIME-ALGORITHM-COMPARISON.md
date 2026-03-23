# Course Time Algorithm: Rowsandall vs Worker Comparison

This document compares the course time calculation algorithm implemented in **Rowsandall** (Python/Django) with the implementation in this **worker** project (TypeScript/Cloudflare Workers). The worker implementation is explicitly documented as a *port* of Rowsandall’s `handle_check_race_course` and `courseutils` module.

---

## 1. Overview

Both implementations compute **net time** on a measured rowing course from a GPS track by detecting polygon gate passages. The core idea:

1. Represent the course as a sequence of polygons (start gate, optional waypoints, finish gate).
2. Find all times the track **exits** the start gate.
3. For each such “lap,” compute the time to traverse all gates in order.
4. Compute **net time** = finish time − start time (time from crossing the start line to crossing the finish line).
5. Return the best (lowest) net time among completed laps.

---

## 2. Why Recursion and Multiple Attempts? Real-World Rowing Behavior

New readers may wonder why the algorithm is structured around recursion and why it considers *all* start-gate exits rather than just one. The answer lies in how rowers actually use a measured course.

### 2.1 Rowers Pass Through Gates Many Times Before a Timed Effort

In practice, a rower does not simply cross the start line once and race to the finish. Typical scenarios:

- **Warm-up and approach:** The rower paddles through the start area, turns, and rows away before coming back to begin a timed piece.
- **Multiple attempts:** A rower may do several pieces in one session — each lap produces another exit from the start gate.
- **Navigation and positioning:** The boat may pass through or near gate polygons while maneuvering, turning around, or adjusting course.

As a result, a single GPS track can contain **multiple exits** from the start gate. Each exit is a potential “beginning” of a timed lap. The algorithm must evaluate every such exit to find valid, completed laps and pick the best net time.

### 2.2 Two Levels of “Trying Every Possibility”

The design has two related ideas:

**1. Outer loop: try every start-gate exit**

`time_in_path(..., maxmin='max', getall=True)` returns *all* times the track exits the start polygon. For each of these `entryTimes`, the algorithm:

- Slices the track from slightly before that exit (10 s buffer) to the end.
- Runs the full gate-traversal logic on that slice.
- Computes net time = finish time − start time.
- Keeps only completed laps and chooses the best one.

So if a rower does three pieces, we get three candidate laps and keep the fastest.

**2. Inner recursion: traverse gates in order**

`coursetime_paths` uses recursion to move gate-by-gate (start → waypoints → finish):

- Find the first exit from the current gate.
- Slice the track to points *after* that exit and rebase time.
- Recursively process the remaining gates on the sliced track.
- For the last gate (finish), use **entry** instead of exit so time stops when the bow crosses the line.

The recursion naturally enforces the correct gate order: we must exit the start, then pass through any waypoints in sequence, then enter the finish. If any gate is missed, the lap is incomplete.

### 2.3 Why This Design Works

- **Flexibility:** Works for any number of laps and for messy, real-world tracks with warm-up and maneuvering.
- **Correctness:** Only counts laps that pass through all gates in order.
- **Robustness:** The 10 s buffer before each start exit ensures we have enough points for gate detection even when the rower is still approaching.

In short: the recursion handles gate order within a lap; the outer loop over entry times handles multiple laps and the fact that rowers often row through gates before their actual timed attempt.

---

## 3. Architecture

### 3.1 Rowsandall (Python)

- **Entry point:** `handle_check_race_course` in `rowers/tasks.py` (~line 1336)
- **Core logic:** `rowers/courseutils.py` — `time_in_path`, `coursetime_first`, `coursetime_paths`
- **Data:** Pandas DataFrame with columns `time`, `latitude`, `longitude`, `cumdist`/`cum_dist`
- **Polygons:** Matplotlib `Path` objects from `polygon_to_path()` in `rowers/models.py`

### 3.2 Worker (TypeScript)

- **Entry point:** `calculateCourseTime` in `src/course-time.ts`
- **Core logic:** Same file — `timeInPath`, `coursetimeFirst`, `coursetimePaths`
- **Data:** `TrackPoint[]` with `lat`, `lon`, `time`, optionally `cumdist`
- **Polygons:** `CoursePolygon` objects with `points: Array<{ lat, lon }>`

---

## 4. Data Preparation

### 4.1 Source Data

| Aspect | Rowsandall | Worker |
|--------|------------|--------|
| Input | CSV/GPX from `rdata()` (rowingdata library) | GPS stream from Intervals.icu API (latlng + time arrays) |
| Time column | `TimeStamp (sec)` renamed to `time`, zero-based | Seconds from activity start |
| Position | ` latitude`, ` longitude` (space-prefixed) | `lat`, `lon` in each track point |

### 4.2 Interpolation

Both resample the track to ~100 ms resolution for more reliable gate detection.

**Rowsandall:**
```python
rowdata = rowdata.resample('100ms', on='dt').mean()
rowdata = rowdata.interpolate()
```

**Worker:**
```typescript
export function interpolateTrack(points: TrackPoint[], intervalMs = 100): TrackPoint[]
// Linear interpolation between consecutive points
const steps = Math.max(1, Math.ceil(dtMs / intervalMs));
for (let s = 1; s < steps; s++) {
  const t = s / steps;
  result.push({ lat: a.lat + t * (b.lat - a.lat), lon: ..., time: ... });
}
```

**Difference:** Rowsandall uses Pandas time-based resampling and `interpolate()`. The worker uses explicit linear interpolation between consecutive points. Both end up with ~100 ms spacing.

### 4.3 Cumulative Distance

**Rowsandall:**  
`row.calc_dist_from_gps()` populates `gps_dist_calculated`, then `rowdata['cum_dist'] = rowdata['gps_dist_calculated']`.

**Worker:**  
`addCumulativeDistance()` uses a haversine function to sum distances between consecutive points.

Both use cumulative distance to report distance at gate crossings and for optional distance-based logic.

---

## 5. Point-in-Polygon

### Rowsandall

Uses Matplotlib’s `Path.contains_points()`:

```python
def coordinate_in_path(latitude, longitude, p):
    return p.contains_points([(latitude, longitude)])[0]
```

The polygon is built with `path.Path(s[:-1])` — points ordered by `order_in_poly`, last vertex omitted (Path closes implicitly).

### Worker

Implements ray-casting (odd–even rule):

```typescript
export function pointInPolygon(lat, lon, polygon): boolean {
  let inside = false;
  const x = lon, y = lat;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
```

**Difference:** Rowsandall relies on Matplotlib’s robust implementation. The worker uses a standard ray-casting algorithm. Both are correct for simple closed polygons; Matplotlib may handle more complex cases (e.g. self-intersections).

---

## 6. Transition Detection (`time_in_path` / `timeInPath`)

This is the core gate-crossing logic: detect when the track crosses a polygon boundary.

### 6.1 Conceptual Model

- **max / `max`:** exit — inside → outside. Time used: last point *inside* the polygon.
- **min / `min`:** entry — outside → inside. Time used: first point *inside* the polygon.

So:
- For the **start gate**, we care about the first **exit** (leaving the start area).
- For the **finish gate**, we care about the first **entry** (entering the finish area).

### 6.2 Rowsandall (Pandas)

Uses a boolean mask and `shift` to find transitions:

```python
inpolygon = df.apply(lambda row: coordinate_in_path(...), axis=1)
if maxmin == 'max':
    b = (~inpolygon).shift(-1) + inpolygon   # exit: inside and next outside
else:
    b = (~inpolygon).shift(1) + inpolygon    # entry: was outside, now inside
# b == 2 marks transition rows
return df[b == 2]['time'], df[b == 2]['cumdist']
```

- **Exit (max):** `inpolygon[i]=True`, `inpolygon[i+1]=False` → `b[i]=2` → time of last inside row.
- **Entry (min):** `inpolygon[i-1]=False`, `inpolygon[i]=True` → `b[i]=2` → time of first inside row.

### 6.3 Worker (Explicit Loop)

Walks the track step by step:

```typescript
for (let i = 0; i < track.length - 1; i++) {
  const currInside = inPolygon[i];
  const nextInside = inPolygon[i + 1];
  if (maxmin === 'max') {
    if (currInside && !nextInside) {
      transitions.push(track[i].time);        // last inside
      dists.push(distCross);
    }
  } else {
    if (!currInside && nextInside) {
      transitions.push(track[i + 1].time);     // first inside
      dists.push(distCross);
    }
  }
}
```

### 6.4 Distance at Crossing

**Rowsandall:** Returns `df[b==2]['cumdist']` — cumulative distance at the crossing row(s).

**Worker:** Uses the midpoint of neighboring points:

```typescript
const d0 = track[i].cumdist ?? 0;
const d1 = track[i+1].cumdist ?? 0;
const distCross = (d0 + d1) / 2;
```

**Difference:** Rowsandall uses the value at the transition point; the worker uses an average of the two adjacent points. For typical 100 ms data this is a small numerical difference.

---

## 7. Recursive Gate Traversal (`coursetime_paths` / `coursetimePaths`)

Both implementations recursively traverse gates: first exit from the current gate, then handle the rest.

### 7.1 Structure

**Rowsandall:**
```python
time, dist = time_in_path(data, paths[0], maxmin='max')  # exit first gate
data2 = data[data['time'] > time].copy()
data2['time'] = data2['time'].apply(lambda x: x - time)
data2['cumdist'] = data2['cumdist'].apply(lambda x: x - dist)
timenext, distnext, coursecompleted = coursetime_paths(data2, paths[1:], ...)
return time + timenext, dist + distnext, coursecompleted
```

**Worker:**
```typescript
const { times } = timeInPath(track, polygons[0], 'max', false);
const t0 = times[0];
const slice = track.filter((p) => p.time > t0).map((p) => ({ ...p, time: p.time - t0 }));
const rest = coursetimePaths(slice, polygons.slice(1), finalMaxMin, log);
return { time: t0 + rest.time, dist: rest.dist, completed: rest.completed };
```

### 7.2 Finish Gate Semantics

For the last gate (finish), both use entry (`min`) so the clock stops when the bow enters the finish zone:

**Rowsandall:** `finalmaxmin='min'` (default) for `time_in_path(data, paths[0], maxmin=finalmaxmin)` when `len(paths)==1`.

**Worker:** `finalMaxMin: MaxMin = 'min'` — documented as “time stops when bow crosses the line.”

### 7.3 Distance Handling

**Rowsandall:** Propagates and accumulates `cumdist` through recursion (`dist + distnext`). The final `dist` is the cumulative distance along the track at the finish.

**Worker:** Returns `rest.dist` for the multipolygon case and `dist: 0` for the single-polygon (finish) case. The main algorithm uses `course.distance_m ?? best.dist`, so distance comes from course metadata when available rather than from path computation.

---

## 8. First Exit (`coursetime_first` / `coursetimeFirst`)

Both compute the time of the **first exit** from the start polygon.

**Rowsandall:**
```python
entrytime, entrydistance = time_in_path(data, paths[0], maxmin='max', ...)
return entrytime, entrydistance, coursecompleted
```

**Worker:**
```typescript
const { times } = timeInPath(track, polygons[0], 'max', false);
return { time: times[0], dist: 0, completed: true };
```

**Difference:** Rowsandall returns distance at that crossing; the worker returns `dist: 0`. Net time does not depend on distance, so this does not affect the main result.

---

## 9. Main Algorithm Loop (`handle_check_race_course` / `calculateCourseTime`)

### 9.1 Entry Times

Both find all start-gate exits:

**Rowsandall:**
```python
entrytimes, entrydistances = time_in_path(rowdata, paths[0], maxmin='max', getall=True, ...)
```

**Worker:**
```typescript
const r = timeInPath(withDist, course.polygons[0], 'max', true);
entryTimes = r.times;
```

### 9.2 Slice and Buffer

**Rowsandall:**
```python
rowdata2 = rowdata[rowdata['time'] > (startt - 10.)]
```

**Worker:**
```typescript
const sliceStart = Math.max(0, startT - 10);
const sliced = withDist.filter((p) => p.time >= sliceStart).map((p) => ({
  ...p,
  time: p.time - sliceStart,
}));
```

Both use a 10 s buffer before the exit time. The worker additionally:
- Re-bases time to 0 at `sliceStart`
- Uses `>=` vs `>`, a minor difference

### 9.3 Net Time Formula

**Rowsandall:**
```python
coursetimesecondsnet = coursetimeseconds - coursetimefirst
coursemeters = coursemeters - coursemetersfirst
```

**Worker:**
```typescript
const netTime = pathsResult.time - firstResult.time;
```

Same formula: finish time − start time.

### 9.4 Best Lap Selection

**Rowsandall:**
```python
records = records.loc[records['coursecompleted'], :]
mintime = records['coursetimeseconds'].min()
# Select row with mintime for final values
```

**Worker:**
```typescript
const completed = records.filter((r) => r.completed);
const best = completed.reduce((a, b) => (a.netTime < b.netTime ? a : b));
```

Both keep only completed laps and take the minimum net time.

---

## 10. Differences Summary

| Aspect | Rowsandall | Worker |
|--------|------------|--------|
| Language | Python | TypeScript |
| Data structure | Pandas DataFrame | `TrackPoint[]` |
| Point-in-polygon | Matplotlib `Path.contains_points` | Ray-casting |
| Interpolation | Pandas `resample` + `interpolate` | Manual linear interpolation |
| Transition detection | Pandas `shift` trick | Explicit loop |
| Distance at crossing | Row value | Midpoint of neighbors |
| Time base for slice | Absolute, `time > startt-10` | Rebased to 0 at `sliceStart` |
| Distance usage | Computed and accumulated | Prefer `course.distance_m` |
| Finish gate | Entry (min) | Entry (min) |
| Start gate | Exit (max) | Exit (max) |
| 10 s buffer | `startt - 10` | `startT - 10` |

---

## 11. Appendix: Side-by-Side Code Comparison

### A.1 Point-in-Polygon

**Rowsandall** (`courseutils.py`):
```python
def coordinate_in_path(latitude, longitude, p):
    return p.contains_points([(latitude, longitude)])[0]
```

**Worker** (`course-time.ts`):
```typescript
export function pointInPolygon(lat: number, lon: number, polygon: Array<{ lat: number; lon: number }>): boolean {
  if (polygon.length < 3) return false;
  const n = polygon.length;
  let inside = false;
  const x = lon, y = lat;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].lon, yi = polygon[i].lat;
    const xj = polygon[j].lon, yj = polygon[j].lat;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
```

### A.2 Transition Detection — Exit (max)

**Rowsandall**:
```python
inpolygon = df.apply(lambda row: coordinate_in_path(...), axis=1)
b = (~inpolygon).shift(-1) + inpolygon   # inside + next outside → b=2
return df[b == 2]['time']   # last inside row's time
```

**Worker**:
```typescript
if (maxmin === 'max') {
  if (currInside && !nextInside) {
    const tCross = track[i].time;   // last inside point
    transitions.push(tCross);
    dists.push(distCross);
  }
}
```

### A.3 Transition Detection — Entry (min)

**Rowsandall**:
```python
b = (~inpolygon).shift(1) + inpolygon   # was outside, now inside → b=2
return df[b == 2]['time']   # first inside row's time
```

**Worker**:
```typescript
else {
  if (!currInside && nextInside) {
    transitions.push(track[i + 1].time);   // first inside point
    dists.push(distCross);
  }
}
```

### A.4 `coursetime_paths` — Recursive Gate Traversal

**Rowsandall** (`courseutils.py` lines 127–144):
```python
if len(paths) > 1:
    try:
        time, dist = time_in_path(data, paths[0], name=str(polygons[0]), logfile=logfile)
        data2 = data[data['time'] > time].copy()
        data2['time'] = data2['time'].apply(lambda x: x-time)
        data2['cumdist'] = data2['cumdist'].apply(lambda x: x-dist)
        (timenext, distnext, coursecompleted) = coursetime_paths(data2, paths[1:], ...)
        return time+timenext, dist+distnext, coursecompleted
```

**Worker** (`course-time.ts` lines 154–166):
```typescript
try {
  const { times } = timeInPath(track, polygons[0], 'max', false);
  const t0 = times[0];
  const slice = track.filter((p) => p.time > t0).map((p) => ({
    ...p,
    time: p.time - t0,
  }));
  const rest = coursetimePaths(slice, polygons.slice(1), finalMaxMin, log);
  return {
    time: t0 + rest.time,
    dist: rest.dist,
    completed: rest.completed,
  };
}
```

### A.5 `coursetime_paths` — Finish Gate (single polygon)

**Rowsandall**:
```python
if len(paths) == 1:
    (entrytime, entrydistance) = time_in_path(data, paths[0], maxmin=finalmaxmin, ...)
    return entrytime, entrydistance, coursecompleted
```

**Worker**:
```typescript
if (polygons.length === 1) {
  const { times } = timeInPath(track, polygons[0], finalMaxMin, false);
  return { time: times[0], dist: 0, completed: true };
}
```

### A.6 Main Loop — Slice, Net Time, Best Lap

**Rowsandall** (`tasks.py` lines 1477–1527):
```python
for startt in entrytimes:
    rowdata2 = rowdata[rowdata['time'] > (startt-10.)]
    (coursetimeseconds, coursemeters, coursecompleted) = coursetime_paths(rowdata2, paths, ...)
    (coursetimefirst, coursemetersfirst, firstcompleted) = coursetime_first(rowdata2, paths, ...)
    coursetimesecondsnet = coursetimeseconds - coursetimefirst
    coursemeters = coursemeters - coursemetersfirst
    cseconds.append(coursetimesecondsnet)
    ...
records = records.loc[records['coursecompleted'], :]
mintime = records['coursetimeseconds'].min()
```

**Worker** (`course-time.ts` lines 272–303):
```typescript
for (const startT of entryTimes) {
  const sliceStart = Math.max(0, startT - 10);
  const sliced = withDist.filter((p) => p.time >= sliceStart).map((p) => ({
    ...p,
    time: p.time - sliceStart,
  }));
  const pathsResult = coursetimePaths(sliced, polygons, 'min', log);
  const firstResult = coursetimeFirst(sliced, polygons);
  const netTime = pathsResult.time - firstResult.time;
  records.push({ netTime, dist, completed: pathsResult.completed, startS: startT, endS });
  ...
}
const completed = records.filter((r) => r.completed);
const best = completed.reduce((a, b) => (a.netTime < b.netTime ? a : b));
```

### A.7 Interpolation

**Rowsandall** (`tasks.py`):
```python
rowdata = rowdata.resample('100ms', on='dt').mean()
rowdata = rowdata.interpolate()
```

**Worker**:
```typescript
const dtMs = (b.time - a.time) * 1000;
const steps = Math.max(1, Math.ceil(dtMs / intervalMs));
for (let s = 1; s < steps; s++) {
  const t = s / steps;
  result.push({
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    time: a.time + t * (b.time - a.time),
  });
}
```

---

## 12. Conclusion

The worker implementation is a faithful port of the Rowsandall algorithm. The main behavior matches:

1. Same net time formula: finish time − start time.
2. Same gate semantics: exit at start, entry at finish.
3. Same 100 ms–style interpolation.
4. Same 10 s buffer before each start-gate exit.
5. Same strategy for best lap: minimum net time among completed laps.

Differences are mostly technical:

- Different data structures and APIs.
- Ray-casting vs Matplotlib for point-in-polygon.
- Slightly different handling of distance at crossings and in the recursion.
- Worker prefers `course.distance_m` over computed path distance.

These differences do not materially change the course time result for typical tracks and courses.
