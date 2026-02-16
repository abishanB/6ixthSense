# Building Placement UX Overhaul — Implementation Spec

This document describes the planned changes to building placement and how to implement them step by step.

---

## Overview

**Current state:** Users select a mode (draw polygon or rectangle drag), manually draw/define a footprint, then adjust dimensions and rotation in a separate panel.

**Target state:**
- Drag-and-drop buildings from a palette onto the map
- Auto-snap orientation from nearby roads
- Overlap detection with both user-placed and basemap buildings
- Keybind for rotation after placement
- Post-placement: only height is adjustable; footprint and rotation are set at placement

---

## 1. Drag-and-Drop Building Palette

### Goal
Replace the dropdown + draw/rectangle modes with a building palette. User drags a building template from the sidebar onto the map and drops it at the desired location.

### Steps

1. **Define building templates**
   - Create a data structure for templates, e.g.:
     ```ts
     interface BuildingTemplate {
       id: string;
       label: string;
       widthM: number;
       depthM: number;
       defaultHeightM: number;
       modelType?: BuildingModelType;  // if using 3D models
     }
     ```
   - Add presets: e.g. "Small (15×15m)", "Medium (25×25m)", "Large (40×40m)" or model-specific (Store, Restaurant, etc.).

2. **Create a BuildingPalette component**
   - Renders a list of draggable building cards in the sidebar.
   - Each card shows label and dimensions.
   - Use HTML5 drag-and-drop:
     - `draggable={true}` on each card
     - `onDragStart` — store template ID and dimensions in `dataTransfer.setData('application/json', JSON.stringify(template))`

3. **Make the map a drop target**
   - Attach `onDragOver` (prevent default to allow drop) and `onDrop` to the map container.
   - On drop: get `event.clientX/clientY`, convert to map coordinates via `map.project()` or use the map's pixel-to-LngLat conversion.
   - Extract template from `dataTransfer.getData`.

4. **Place building at drop location**
   - Create a building feature with:
     - Center = drop point (lng, lat)
     - Dimensions = template width × depth
     - Height = template default height
     - Orientation = to be set by snap-to-road (next section)
   - Convert center + dimensions + rotation to polygon coordinates (4 corners).
   - Add to polygon buildings state and update map source.

5. **Visual feedback during drag**
   - Optional: show a semi-transparent preview that follows the cursor when dragging over the map, using the rectangle-preview layer or similar.

---

## 2. Snap to Road Orientation

### Goal
When a building is dropped, auto-align its orientation to the nearest road so it “sits” naturally along the street.

### Steps

1. **Find nearby road segments**
   - Use existing road GeoJSON (`public/data/roads_downtown.geojson`).
   - At drop point (lng, lat), find roads within a radius (e.g. 50–100m).
   - Use Turf: `turf.nearestPointOnLine` or buffer the point and `turf.featuresWithin`.

2. **Compute road bearing**
   - For each nearby road LineString, get the bearing of the segment closest to the drop point.
   - Use `@turf/bearing` between two points on the line, or `@turf/line-chunk` + bearing of the relevant chunk.

3. **Pick best alignment**
   - Option A: Use the closest road’s bearing.
   - Option B: Average bearings of roads within radius, weighted by proximity.
   - Option C: Use the road with highest “highway” importance (e.g. primary > secondary > tertiary).

4. **Apply rotation to building polygon**
   - Given center (lng, lat), width, depth, and bearing θ:
   - Compute 4 corners in local frame (centered at origin, axis-aligned), then rotate by θ and translate to center.
   - Conversion: meters to degrees ≈ `meters / 111320` (at equator; for Toronto use ~111000 for lat and 111000 * cos(lat) for lng).

5. **Fallback**
   - If no roads in radius, use 0° (north-aligned) or previous default.

---

## 3. Overlap Detection

### Where Does Basemap Building Data Come From?

The map (MapLibre) loads **vector tiles** from a tile API (e.g. Mapbox). Each tile is a `.mvt` / `.pbf` file containing layers such as roads, water, and **buildings**. The buildings are polygon geometries stored in the tile. The map fetches these tiles as the user pans/zooms, parses them, and renders them.

To check overlap with basemap buildings, we need those building geometries in a form we can query (e.g. GeoJSON). There are two ways to get them:

| Approach | How we get the data | Export step? |
|----------|---------------------|--------------|
| **A. queryRenderedFeatures** | The map has already fetched and parsed tiles. We ask MapLibre: "What features did you render in this area?" It returns the parsed features from memory. | **No.** The map loads tiles automatically. We query what it already has. |
| **B. Fetch + decode tiles ourselves** | We construct the same tile URLs the map uses, fetch the raw `.mvt` files from the API, and decode them with `@mapbox/vector-tile` + `pbf`. | **Yes.** We explicitly fetch tiles from the tile API and decode them into GeoJSON. |

**For approach A:** No export. The map fetches tiles on demand; when we call `queryRenderedFeatures`, we're reading the features MapLibre already loaded for the current view.

**For approach B:** We "export" by fetching tiles from the tile API and decoding them. The tile API URL comes from the map style (e.g. `map.getStyle().sources['composite'].url` or similar). We substitute `{z}/{x}/{y}` and fetch. Then we decode the binary MVT into GeoJSON using `@mapbox/vector-tile`.

---

### Goal
Prevent or warn when placing a building on top of existing buildings (user-placed or basemap).

### 3a. Overlap with User-Placed Buildings

1. **Get polygon of new building**
   - You have center, dimensions, rotation — compute the 4-corner polygon.

2. **Get polygons of existing user-placed buildings**
   - From `polygonBuildings` state (or equivalent), extract each building’s polygon from its GeoJSON geometry.

3. **Check intersection**
   - Use `@turf/boolean-intersects`: `booleanIntersects(newPolygon, existingPolygon)`.
   - If any returns true → overlap with user-placed building.

### 3b. Overlap with Basemap Buildings

**Option A: queryRenderedFeatures (simpler, view-dependent)**

1. Get bounding box of new building polygon: `turf.bbox(newPolygon)`.
2. Convert bbox to screen coordinates or use `map.queryRenderedFeatures` with a geometry.
3. Call:
   ```ts
   const layers = ['building', 'building-extrusion']; // adjust for your style
   const features = map.queryRenderedFeatures(bboxOrGeometry, { layers });
   ```
4. Discover layer IDs: iterate `map.getStyle().layers`, find `type: 'fill-extrusion'` or ids containing `building`.
5. For each feature returned, get its geometry and run `turf.booleanIntersects(newPolygon, featureAsPolygon)`.
6. If any intersect → overlap with basemap.

**Option B: Fetch and decode vector tiles (more robust, cacheable)**

This approach explicitly fetches building data from the tile API and decodes it into GeoJSON. The flow: **Style → Tile URL → Fetch → Decode → GeoJSON**.

1. **Get tile URL from style**
   - From `map.getStyle().sources`, find the source that provides buildings (e.g. composite source or main vector source).
   - Extract `tiles` URL template, e.g. `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.mvt?access_token=...`

2. **Compute tile indices for bounding box**
   - For zoom z (e.g. 14–16), compute x,y for corners of bbox:
     - `x = floor((lng + 180) / 360 * 2^z)`
     - `y = floor((1 - log(tan(latRad) + 1/cos(latRad)) / π) / 2 * 2^z)`
   - Fetch all tiles in that range.

3. **Fetch tiles**
   - Replace `{z}/{x}/{y}` in URL template. Add `access_token` if Mapbox.
   - `fetch(url)` → `response.arrayBuffer()`.

4. **Decode MVT**
   ```ts
   import Pbf from 'pbf';
   import VectorTile from '@mapbox/vector-tile';
   
   const pbf = new Pbf(arrayBuffer);
   const tile = new VectorTile(pbf);
   const layer = tile.layers['building'] || tile.layers['building-extrusion'];
   if (!layer) return [];
   
   const features = [];
   for (let i = 0; i < layer.length; i++) {
     const feat = layer.feature(i);
     const geojson = feat.toGeoJSON(tileX, tileY, tileZ);
     features.push(geojson);
   }
   ```
   - Convert tile x,y to tile indices. `toGeoJSON(x, y, z)` expects the tile’s column, row, zoom.

5. **Cache**
   - Key: `{z}_{x}_{y}`. Store decoded features in a Map or object.
   - Reuse when checking overlap for multiple placements in the same area.

6. **Check overlap**
   - For each decoded building feature, `turf.booleanIntersects(newPolygon, feature)`.
   - If any intersect → overlap with basemap.

**Option B export pipeline summary:**
1. **Export from API** — Fetch `.mvt` tiles from the tile API (same URLs the map uses).
2. **Decode** — Parse the binary MVT with `@mapbox/vector-tile` + `pbf` into GeoJSON features.
3. **Use** — Pass GeoJSON polygons to Turf for overlap checks.

No separate "export" step is needed for Option A; the map already holds the data. For Option B, the fetch + decode *is* the export.

### 3c. Integration into placement flow

1. **Before committing placement**
   - Run overlap checks (user-placed + basemap).
   - If overlap: either block placement and show "Overlaps existing building" or show warning and let user confirm.
   - If no overlap: place building.

2. **Visual feedback (optional)**
   - During drag-over-map: run overlap check for preview position; tint preview red if overlapping, green if clear.

---

## 4. Keybind for Rotation (Post-Placement)

### Goal
After a building is placed, the user can rotate it using a keybind without opening a panel.

### Steps

1. **Selection state**
   - Ensure there is a clear "selected building" state (e.g. `selectedPolygonBuildingId`).

2. **Keybind handler**
   - Listen for keydown on the window or map container.
   - When selected building exists:
     - e.g. `R` or `[` / `]`: rotate by fixed step (e.g. 15°).
     - Or `Shift+R`: rotate 90°.
   - Prevent default for these keys so they don’t trigger browser shortcuts.

3. **Apply rotation**
   - Get current building polygon. Compute centroid, current angle (from first edge), then rotate vertices around centroid by the step.
   - Use Turf: `turf.transformRotate(polygon, angleDegrees, { pivot: centroid })`.
   - Update building feature in state and map source.

4. **UI hint**
   - Show a small tooltip or status: "Press R to rotate" when a building is selected.

---

## 5. Post-Placement: Height Only

### Goal
After placement, only height is adjustable. Footprint (width × depth) and rotation are fixed unless the user explicitly edits them (e.g. via rotation keybind).

### Steps

1. **Simplify BuildingControls (or equivalent)**
   - When a polygon building is selected, show only:
     - Height slider
     - Building type selector (if still needed)
     - Delete button
   - Remove or hide footprint/dimension sliders for the new drag-and-drop flow.

2. **Model scaling**
   - If using 3D models (ScenegraphLayer), scale only the height component. Width/depth are derived from the polygon at placement and not changed by the height slider.
   - Ensure the 3D layer uses `height` from properties for extrusion or model scale.

3. **Rectangle-drag / polygon-draw**
   - Either remove these modes or keep them as an "advanced" option. Primary flow is drag-and-drop.

---

## 6. Remove or Simplify Old Placement Modes

### Goal
Make drag-and-drop the primary (or only) placement method.

### Steps

1. **Disable or hide**
   - Draw Polygon control: hide or remove from the main UI.
   - Rectangle-drag mode: disable when not in "advanced" mode.
   - Building mode toggle: repurpose for "Add from palette" or remove if the palette is always visible.

2. **Migration**
   - Existing polygon buildings in state remain valid. No data migration needed.
   - Ensure selected-building logic works for both old and new placements.

---

## Implementation Order

| Phase | Task | Dependencies |
|-------|------|--------------|
| 1 | Building templates + BuildingPalette component | — |
| 2 | Map as drop target, place building at drop | 1 |
| 3 | Snap-to-road orientation | 2, road GeoJSON |
| 4 | Overlap with user-placed buildings | 2, Turf |
| 5 | Overlap with basemap (queryRenderedFeatures first) | 4 |
| 6 | Keybind for rotation | 2, selection state |
| 7 | Simplify BuildingControls (height only) | 2 |
| 8 | Remove/deprecate draw + rectangle modes | 1–7 |
| 9 | (Optional) Vector tile fetch + decode for overlap | 5 |

---

## Dependencies

- **Turf.js** (`@turf/turf`): `bbox`, `booleanIntersects`, `bearing`, `nearestPointOnLine` (or equivalent), `transformRotate`
- **@mapbox/vector-tile** + **pbf**: for Option B overlap (already in package.json)
- **Road GeoJSON**: `public/data/roads_downtown.geojson`

---

## File Touch Points

- `src/App.tsx` — map container drop handler, placement flow, selection, keybinds
- `src/components/BuildingPalette.tsx` — new component
- `src/components/BuildingControls.tsx` — simplify to height only
- `src/map/DrawPolygonControl.ts` — hide or remove
- New: `src/map/overlap.ts` — overlap detection helpers
- New: `src/map/snapToRoad.ts` — orientation from roads
- New: `src/map/tileDecoder.ts` — (optional) MVT fetch + decode

---

## Notes

- Mapbox tile URLs require an access token. Ensure it’s available when fetching tiles.
- Tile layer names vary by tileset. Mapbox Streets uses `building`; OpenMapTiles uses similar. Inspect the decoded tile’s `layer.name` to confirm.
- For Toronto, latitude ~43.65; 1° lat ≈ 111 km, 1° lng ≈ 111 * cos(43.65°) ≈ 80 km. Use for meter-to-degree conversion.
