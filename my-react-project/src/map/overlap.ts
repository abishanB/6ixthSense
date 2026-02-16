import maplibregl from "maplibre-gl";
import { bbox, booleanIntersects } from "@turf/turf";

type PolygonLike = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

function asPolygonLike(
  feature: GeoJSON.Feature | maplibregl.MapGeoJSONFeature,
): PolygonLike | null {
  const geometry = feature.geometry;
  if (!geometry) {
    return null;
  }
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    return null;
  }
  return {
    type: "Feature",
    geometry,
    properties: { ...(feature.properties ?? {}) },
  };
}

export function overlapsUserBuildings(
  candidate: PolygonLike,
  existingBuildings: ReadonlyMap<string, GeoJSON.Feature>,
): boolean {
  for (const existing of existingBuildings.values()) {
    const existingPolygon = asPolygonLike(existing);
    if (!existingPolygon) {
      continue;
    }
    if (booleanIntersects(candidate, existingPolygon)) {
      return true;
    }
  }
  return false;
}

function findBasemapBuildingLayers(
  map: maplibregl.Map,
  excludedLayerIds: ReadonlySet<string>,
): string[] {
  const layers = map.getStyle().layers ?? [];
  return layers
    .filter((layer) => {
      if (excludedLayerIds.has(layer.id)) {
        return false;
      }
      if (layer.type !== "fill" && layer.type !== "fill-extrusion") {
        return false;
      }
      const idLower = layer.id.toLowerCase();
      const sourceLayer = String((layer as { "source-layer"?: unknown })["source-layer"] ?? "").toLowerCase();
      return idLower.includes("building") || sourceLayer === "building";
    })
    .map((layer) => layer.id);
}

export function overlapsBasemapBuildings(
  map: maplibregl.Map,
  candidate: PolygonLike,
  excludedLayerIds: ReadonlyArray<string>,
): boolean {
  const exclusionSet = new Set(excludedLayerIds);
  const buildingLayers = findBasemapBuildingLayers(map, exclusionSet);
  if (buildingLayers.length === 0) {
    return false;
  }

  const [minLng, minLat, maxLng, maxLat] = bbox(candidate);
  const bottomLeft = map.project([minLng, minLat]);
  const topRight = map.project([maxLng, maxLat]);
  const queryBox: [[number, number], [number, number]] = [
    [Math.min(bottomLeft.x, topRight.x), Math.min(bottomLeft.y, topRight.y)],
    [Math.max(bottomLeft.x, topRight.x), Math.max(bottomLeft.y, topRight.y)],
  ];

  const rendered = map.queryRenderedFeatures(queryBox, { layers: buildingLayers });
  for (const feature of rendered) {
    const polygon = asPolygonLike(feature);
    if (!polygon) {
      continue;
    }
    if (booleanIntersects(candidate, polygon)) {
      return true;
    }
  }
  return false;
}
