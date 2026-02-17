# Building Save/Load Plan (Local File Export + Import)

## Goal
Let users save their current placed-building layout to a local file (normally downloaded to `Downloads`) and later load that file back into the site to restore all placed buildings.

## Current State (What Exists)
- Placed buildings are stored in React state as `Map<string, GeoJSON.Feature>` in `src/App.tsx`.
- Building geometry and render-critical properties already live on each feature (`height`, `modelType`, `scaleLength`, `scaleWidth`, `scaleHeight`, `rotationDeg`, etc.).
- There is currently no file export/import flow for these placed buildings.

## Scope
- Add client-side export of placed buildings to a JSON file.
- Add client-side import of that JSON file to restore building placements.
- Keep this independent of backend in-memory custom-building endpoints.

## Non-Goals (Initial Version)
- No cloud sync or multi-user persistence.
- No partial merge UI (import replaces current layout in v1).
- No server-side database changes.

## File Format (Versioned)
Use a versioned JSON container so we can evolve later.

```json
{
  "format": "toronto-reactive-traffic-layout",
  "version": 1,
  "exportedAt": "2026-02-17T00:00:00.000Z",
  "buildings": [
    {
      "id": "palette-1739123456789",
      "feature": {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [[[lng, lat], [lng, lat], [lng, lat], [lng, lat], [lng, lat]]]
        },
        "properties": {
          "id": "palette-1739123456789",
          "height": 40,
          "type": "palette-building",
          "baseHeight": 0,
          "modelType": "building",
          "scaleLength": 1,
          "scaleWidth": 1,
          "scaleHeight": 1,
          "rotationDeg": 15
        }
      }
    }
  ]
}
```

### Notes
- Do not persist `selected` as true across sessions; normalize selection to none on import.
- Keep the full polygon geometry so buildings restore exactly where they were.
- Keep `version` required for forward compatibility.

## UX Plan
1. Add `Save Buildings` button in the right panel (near existing selected-building controls).
2. Add `Load Buildings` button next to it.
3. `Save Buildings` creates and downloads a JSON file (browser default is usually `Downloads`).
4. `Load Buildings` opens file picker (`.json`), validates, then restores placements.
5. On successful import, show status + popup message with imported count.

## Technical Plan

### Phase 1: Export Data Builder
- Add helper to serialize `polygonBuildingsRef.current` into export schema.
- Strip transient UI-only values (`selected`) before writing.
- Include metadata (`format`, `version`, `exportedAt`).

### Phase 2: Download Action
- Create `Blob` from JSON string.
- Trigger browser download via temporary anchor (`URL.createObjectURL`).
- Filename convention: `toronto-layout-YYYY-MM-DD_HH-mm-ss.json`.

### Phase 3: Import + Validation
- Add hidden file input (`accept=".json,application/json"`).
- Read file with `File.text()` (or `FileReader` fallback if needed).
- Parse JSON and validate:
  - top-level `format` and `version`
  - `buildings` is array
  - each item has polygon geometry and valid coordinates
  - each feature has required properties with safe numeric bounds
- Reject invalid files with clear user-facing error.

### Phase 4: Rehydrate App State
- Convert imported array into `Map<string, GeoJSON.Feature>`.
- Ensure unique IDs (if collisions, generate deterministic suffix).
- Set all features `selected: false`.
- Replace existing `polygonBuildings` state and sync refs:
  - `polygonBuildingsRef.current`
  - `setPolygonBuildings(...)`
  - `setSelectedPolygonBuildingId(null)`
- Refresh map layers and scenegraph overlay using existing update helpers.
- Trigger simulation recompute after import.

### Phase 5: Guardrails
- If current layout has buildings, show confirm dialog before replacing.
- Cap max imported buildings in v1 (for example 1,000) to avoid lockups.
- Ignore unknown fields (forward-compatible), but enforce required fields.

## File Touch Points (When Implementing)
- `src/App.tsx`
  - add export/import handlers
  - add schema validation helpers
  - add file input + Save/Load buttons in sidebar
- Optional new utility file:
  - `src/lib/layout-io.ts` for serialization/validation helpers (recommended if `App.tsx` grows too large)
- Optional docs update:
  - `my-react-project/README.md` usage note for Save/Load

## Acceptance Criteria
- Clicking `Save Buildings` downloads a JSON file containing all currently placed buildings.
- Clearing/reloading app and importing that file restores the same building count and locations.
- Imported buildings retain height/model/rotation/scale behavior.
- Importing invalid JSON or wrong schema shows a clear error and does not corrupt current state.
- Import action updates map rendering and traffic simulation without page reload.

## Test Plan (Manual First)
1. Place 3+ buildings with varied size, model type, height, and rotation.
2. Export file and verify JSON structure quickly.
3. Delete all buildings.
4. Import file.
5. Confirm buildings visually match prior layout and controls still work.
6. Try invalid file cases:
   - not JSON
   - wrong `format`
   - missing `geometry`
   - invalid coordinates
7. Verify warning/confirm appears before replacing an existing non-empty layout.

## Future Extensions
- Add `Append` mode (merge imported buildings into current layout).
- Add export/import for road-closure state and map camera position.
- Add schema migration support for `version > 1`.
