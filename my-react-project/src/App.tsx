import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import { centroid, transformRotate } from "@turf/turf";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import { addRoadLayers, ROAD_LAYER_IDS, updateRoadSourceData } from "./map/layers";
import { buildGraphFromGeoJSON } from "./traffic/graph";
import {
  buildReverseAdjacency,
  dijkstraTreeToDestination,
  reconstructPathFromTree,
} from "./traffic/dijkstra";
import {
  assignTraffic,
  countDisconnectedTrips,
  generateOD,
  generateODFromOrigins,
  generateReachabilityProbe,
  getClosedFeatureNodeIds,
} from "./traffic/model";
import {
  computeLineFeatureBBoxes,
  detectRoadClosuresFromBuildingRings,
  extractPolygonRings,
} from "./traffic/buildingClosures";
import type { Edge, EdgeMetric, FeatureMetric, Graph, ODPair, RoadFeatureProperties } from "./traffic/types";
import { applyMetricsToRoads } from "./traffic/updateGeo";
import { SimulationResultsPanel } from "./components/SimulationResultsPanel";
import {
  BUILDING_TEMPLATE_MIME,
  BuildingPalette,
  type BuildingTemplate,
} from "./components/BuildingPalette";
import { overlapsBasemapBuildings, overlapsUserBuildings } from "./map/overlap";
import { snapToRoadOrientation, type BuildingModelType } from "./map/snapToRoad";
import { fetchAndConvertMapboxStyle, type MapboxStyle } from "./utils/mapbox-style-converter";

type RoadCollection = GeoJSON.FeatureCollection<GeoJSON.LineString, RoadFeatureProperties>;

export interface SimulationStats {
  nodes: number;
  directedEdges: number;
  trips: number;
  probeTrips: number;
  closed: number;
  closureSeedNodes: number;
  runtimeMs: number;
  unreachable: number;
}

type FeatureLike = {
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: GeoJSON.Geometry;
};

type BuildingModelOption = {
  id: BuildingModelType;
  label: string;
  modelUrl: string;
  referenceWidthM: number;
  referenceDepthM: number;
  referenceHeightM: number;
  supersizeMultiplier: number;
  orientation: [number, number, number];
};
type ScenegraphBuildingInstance = {
  id: string;
  modelType: BuildingModelType;
  position: [number, number, number];
  scale: [number, number, number];
  orientation: [number, number, number];
};
type PlacementCheckResult = {
  feature: GeoJSON.Feature<GeoJSON.Polygon>;
  overlapsUser: boolean;
  overlapsRoad: boolean;
  overlapsBasemap: boolean;
};
type PlacementCheckOptions = {
  includeBasemap?: boolean;
  rotationOffsetDeg?: number;
};
type TopPopup = {
  message: string;
  kind: "warning" | "info";
};

const INITIAL_CENTER: [number, number] = [-79.385, 45];
const INITIAL_ZOOM = 12;
const PITCH = 45;
const BEARING = -12;

const TORONTO_BOUNDS: [[number, number], [number, number]] = [
  [-79.5005, 43.6],
  [-79.280, 43.7],
];
const MIN_ZOOM = 8;
const MAX_ZOOM = 20;
const FALLBACK_STYLE_URL = "https://demotiles.maplibre.org/style.json";
const TRAFFIC_PARTICLE_SOURCE_ID = "traffic-particles";
const TRAFFIC_PARTICLE_LAYER_ID = "traffic-particles";
const TRAFFIC_PARTICLE_MAX_COUNT = 1400;
const TRAFFIC_ROUTE_POOL_MAX = 1600;
const TRAFFIC_PARTICLE_FRAME_MS = 70;
const TRAFFIC_PARTICLE_SPEED_SCALE = 3.35;
const TRAFFIC_FOLLOW_MIN_GAP_M = 4;
const TRAFFIC_FOLLOW_TIME_HEADWAY_SEC = 0.42;
const TRAFFIC_INTERSECTION_HEADWAY_SEC = 0.28;
const TRAFFIC_INTERSECTION_HOLD_BACK_M = 1.8;
const TRAFFIC_INTERSECTION_SLOW_ZONE_M = 26;
const TRAFFIC_INTERSECTION_SLOW_FACTOR = 0.24;
const TRAFFIC_INTERSECTION_GREEN_SLOW_FACTOR = 0.72;
const TRAFFIC_INTERSECTION_QUEUE_GAP_M = 11.5;
const TRAFFIC_INTERSECTION_APPROACH_OFFSET_STEP_M = 0.65;
const TRAFFIC_INTERSECTION_APPROACH_OFFSET_SLOTS = 6;
const TRAFFIC_LANE_OFFSET_BASE_M = 1.45;
const TRAFFIC_LANE_OFFSET_VARIATION_M = 0.35;
const TRAFFIC_SPAWN_STAGGER_M = 7;
const TRAFFIC_SIGNAL_BASE_CYCLE_SEC = 20;
const TRAFFIC_SIGNAL_CYCLE_VARIANCE_SEC = 8;
const TRAFFIC_SIGNAL_GREEN_RATIO = 0.6;
const TRAFFIC_MAX_ACCEL_MPS2 = 8.5;
const TRAFFIC_MAX_BRAKE_MPS2 = 13;
const TRAFFIC_INTERSECTION_STOP_EPS_M = 0.06;
const POLYGON_BUILDINGS_SOURCE_ID = "polygon-buildings";
const POLYGON_BUILDINGS_LAYER_ID = "polygon-buildings-3d";
const POLYGON_BUILDINGS_OUTLINE_LAYER_ID = "polygon-buildings-outline";
const RECTANGLE_PREVIEW_SOURCE_ID = "rectangle-preview";
const RECTANGLE_PREVIEW_FILL_LAYER_ID = "rectangle-preview-fill";
const RECTANGLE_PREVIEW_LINE_LAYER_ID = "rectangle-preview-line";
// Central model tuning table: scale calibration, rotation, and slider behavior per model.
const DEFAULT_MODEL_RENDER_PARAMS = {
  supersizeMultiplier: 5,
  orientation: [0, 0, 90] as [number, number, number],
};
const BASE_BUILDING_HEIGHT_M = 40;
const MIN_MODEL_SCALE_PERCENT = 10;
const MAX_MODEL_SCALE_PERCENT = 500;
const MIN_MODEL_ROTATION_DEG = -180;
const MAX_MODEL_ROTATION_DEG = 180;
const BUILDING_MODEL_OPTIONS: ReadonlyArray<BuildingModelOption> = [
  {
    id: "building",
    label: "Store",
    modelUrl: new URL("../3d_models/Store.glb", import.meta.url).href,
    referenceWidthM: 20,
    referenceDepthM: 20,
    referenceHeightM: 20,
    ...DEFAULT_MODEL_RENDER_PARAMS,
  },
  {
    id: "restaurant",
    label: "Restaurant",
    modelUrl: new URL("../3d_models/Dining car.glb", import.meta.url).href,
    referenceWidthM: 80,
    referenceDepthM: 80,
    referenceHeightM: 80,
    ...DEFAULT_MODEL_RENDER_PARAMS,
  },
  {
    id: "large-building",
    label: "Large Building",
    modelUrl: new URL("../3d_models/Large Building.glb", import.meta.url).href,
    referenceWidthM: 24,
    referenceDepthM: 24,
    referenceHeightM: 24,
    ...DEFAULT_MODEL_RENDER_PARAMS,
    supersizeMultiplier: 10,
  },
  {
    id: "schoolhouse",
    label: "Schoolhouse",
    modelUrl: new URL("../3d_models/Schoolhouse.glb", import.meta.url).href,
    referenceWidthM: 16,
    referenceDepthM: 16,
    referenceHeightM: 16,
    ...DEFAULT_MODEL_RENDER_PARAMS,
    supersizeMultiplier: 2,
  },
  {
    id: "construction-sign",
    label: "Construction Sign",
    modelUrl: new URL("../3d_models/Construction sign.glb", import.meta.url).href,
    referenceWidthM: 3,
    referenceDepthM: 3,
    referenceHeightM: 3,
    ...DEFAULT_MODEL_RENDER_PARAMS,
    supersizeMultiplier: 1,
  },
];
const BUILDING_TEMPLATES: ReadonlyArray<BuildingTemplate> = [
  {
    id: "store-small",
    label: "Store Small",
    widthM: 15,
    depthM: 15,
    defaultHeightM: 20,
    modelType: "building",
  },
  {
    id: "store-medium",
    label: "Store Medium",
    widthM: 22,
    depthM: 20,
    defaultHeightM: 24,
    modelType: "building",
  },
  {
    id: "store-large",
    label: "Store Large",
    widthM: 30,
    depthM: 26,
    defaultHeightM: 30,
    modelType: "building",
  },
  {
    id: "restaurant-small",
    label: "Restaurant Small",
    widthM: 18,
    depthM: 14,
    defaultHeightM: 20,
    modelType: "restaurant",
  },
  {
    id: "restaurant-medium",
    label: "Restaurant Medium",
    widthM: 24,
    depthM: 18,
    defaultHeightM: 24,
    modelType: "restaurant",
  },
  {
    id: "restaurant-large",
    label: "Restaurant Large",
    widthM: 30,
    depthM: 24,
    defaultHeightM: 30,
    modelType: "restaurant",
  },
  {
    id: "large-building-medium",
    label: "Large Building Medium",
    widthM: 32,
    depthM: 26,
    defaultHeightM: 30,
    modelType: "large-building",
  },
  {
    id: "large-building-xl",
    label: "Large Building XL",
    widthM: 40,
    depthM: 32,
    defaultHeightM: 36,
    modelType: "large-building",
  },
  {
    id: "schoolhouse",
    label: "Schoolhouse",
    widthM: 28,
    depthM: 20,
    defaultHeightM: 18,
    modelType: "schoolhouse",
  },
  {
    id: "construction-sign",
    label: "Construction Sign",
    widthM: 4,
    depthM: 4,
    defaultHeightM: 6,
    modelType: "construction-sign",
  },
];
const ROTATION_STEP_DEG = 15;
const ROTATION_STEP_LARGE_DEG = 90;

const DEFAULT_STATS: SimulationStats = {
  nodes: 0,
  directedEdges: 0,
  trips: 0,
  probeTrips: 0,
  closed: 0,
  closureSeedNodes: 0,
  runtimeMs: 0,
  unreachable: 0,
};

const LAYOUT_FILE_FORMAT = "toronto-reactive-traffic-layout";
const LAYOUT_FILE_VERSION = 1;
const LAYOUT_IMPORT_MAX_BUILDINGS = 1000;
const LAYOUT_MAX_HEIGHT_M = 1000;
const LAYOUT_MAX_BASE_HEIGHT_M = 1000;

type LayoutFileBuilding = {
  id: string;
  feature: GeoJSON.Feature<GeoJSON.Polygon>;
};

type LayoutFileV1 = {
  format: typeof LAYOUT_FILE_FORMAT;
  version: typeof LAYOUT_FILE_VERSION;
  exportedAt: string;
  buildings: LayoutFileBuilding[];
};

function makeUniqueBuildingId(baseId: string, used: ReadonlySet<string>): string {
  const trimmed = baseId.trim();
  const normalized = trimmed.length > 0 ? trimmed : "imported-building";
  if (!used.has(normalized)) {
    return normalized;
  }
  let suffix = 2;
  while (used.has(`${normalized}-${suffix}`)) {
    suffix += 1;
  }
  return `${normalized}-${suffix}`;
}

function safeNumberInRange(value: unknown, min: number, max: number): number | null {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function normalizePolygonCoordinates(raw: unknown): GeoJSON.Position[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }

  const rings: GeoJSON.Position[][] = [];
  for (const ringRaw of raw) {
    if (!Array.isArray(ringRaw) || ringRaw.length < 4) {
      return null;
    }
    const ring: GeoJSON.Position[] = [];
    for (const coordRaw of ringRaw) {
      if (!Array.isArray(coordRaw) || coordRaw.length < 2) {
        return null;
      }
      const lng = Number(coordRaw[0]);
      const lat = Number(coordRaw[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return null;
      }
      ring.push([lng, lat]);
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    rings.push(ring);
  }
  return rings;
}

function parseLayoutFileBuildings(fileContent: string): LayoutFileBuilding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    throw new Error("File is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Layout file must contain a JSON object.");
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.format !== LAYOUT_FILE_FORMAT) {
    throw new Error(`Unsupported layout format. Expected "${LAYOUT_FILE_FORMAT}".`);
  }
  if (candidate.version !== LAYOUT_FILE_VERSION) {
    throw new Error(`Unsupported layout version. Expected version ${LAYOUT_FILE_VERSION}.`);
  }
  if (typeof candidate.exportedAt !== "string" || candidate.exportedAt.trim().length === 0) {
    throw new Error("Layout file is missing exportedAt.");
  }
  if (!Array.isArray(candidate.buildings)) {
    throw new Error("Layout file is missing buildings array.");
  }
  if (candidate.buildings.length > LAYOUT_IMPORT_MAX_BUILDINGS) {
    throw new Error(`Layout has too many buildings. Maximum supported is ${LAYOUT_IMPORT_MAX_BUILDINGS}.`);
  }

  const result: LayoutFileBuilding[] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < candidate.buildings.length; index += 1) {
    const item = candidate.buildings[index];
    if (!item || typeof item !== "object") {
      throw new Error(`Building entry ${index + 1} is invalid.`);
    }
    const entry = item as Record<string, unknown>;
    const featureRaw = entry.feature;
    if (!featureRaw || typeof featureRaw !== "object") {
      throw new Error(`Building entry ${index + 1} is missing feature.`);
    }
    const featureObj = featureRaw as Record<string, unknown>;
    if (featureObj.type !== "Feature") {
      throw new Error(`Building entry ${index + 1} has invalid feature type.`);
    }

    const geometryRaw = featureObj.geometry;
    if (!geometryRaw || typeof geometryRaw !== "object") {
      throw new Error(`Building entry ${index + 1} is missing geometry.`);
    }
    const geometry = geometryRaw as Record<string, unknown>;
    if (geometry.type !== "Polygon") {
      throw new Error(`Building entry ${index + 1} must use Polygon geometry.`);
    }
    const coordinates = normalizePolygonCoordinates(geometry.coordinates);
    if (!coordinates) {
      throw new Error(`Building entry ${index + 1} has invalid polygon coordinates.`);
    }

    const propertiesRaw =
      featureObj.properties && typeof featureObj.properties === "object"
        ? (featureObj.properties as Record<string, unknown>)
        : null;
    if (!propertiesRaw) {
      throw new Error(`Building entry ${index + 1} is missing feature properties.`);
    }

    const modelType = asBuildingModelType(propertiesRaw.modelType);
    if (!modelType) {
      throw new Error(`Building entry ${index + 1} has invalid modelType.`);
    }

    const height = safeNumberInRange(propertiesRaw.height, 1, LAYOUT_MAX_HEIGHT_M);
    if (height === null) {
      throw new Error(`Building entry ${index + 1} has invalid height.`);
    }

    const baseHeight = safeNumberInRange(propertiesRaw.baseHeight ?? 0, 0, LAYOUT_MAX_BASE_HEIGHT_M);
    if (baseHeight === null) {
      throw new Error(`Building entry ${index + 1} has invalid baseHeight.`);
    }

    const scaleLength = safeNumberInRange(
      propertiesRaw.scaleLength,
      MIN_MODEL_SCALE_PERCENT / 100,
      MAX_MODEL_SCALE_PERCENT / 100,
    );
    const scaleWidth = safeNumberInRange(
      propertiesRaw.scaleWidth,
      MIN_MODEL_SCALE_PERCENT / 100,
      MAX_MODEL_SCALE_PERCENT / 100,
    );
    const scaleHeight = safeNumberInRange(
      propertiesRaw.scaleHeight,
      MIN_MODEL_SCALE_PERCENT / 100,
      MAX_MODEL_SCALE_PERCENT / 100,
    );
    if (scaleLength === null || scaleWidth === null || scaleHeight === null) {
      throw new Error(`Building entry ${index + 1} has invalid scale values.`);
    }

    const rotationDeg = safeNumberInRange(propertiesRaw.rotationDeg, MIN_MODEL_ROTATION_DEG, MAX_MODEL_ROTATION_DEG);
    if (rotationDeg === null) {
      throw new Error(`Building entry ${index + 1} has invalid rotationDeg.`);
    }

    if (typeof propertiesRaw.type !== "string" || propertiesRaw.type.trim().length === 0) {
      throw new Error(`Building entry ${index + 1} is missing type.`);
    }

    const entryIdRaw = entry.id;
    const featureIdRaw =
      typeof propertiesRaw.id === "string" || typeof propertiesRaw.id === "number"
        ? propertiesRaw.id
        : (featureObj.id as unknown);
    const baseId =
      typeof entryIdRaw === "string" || typeof entryIdRaw === "number"
        ? String(entryIdRaw)
        : typeof featureIdRaw === "string" || typeof featureIdRaw === "number"
          ? String(featureIdRaw)
          : `imported-building-${index + 1}`;
    const uniqueId = makeUniqueBuildingId(baseId, usedIds);
    usedIds.add(uniqueId);

    const feature: GeoJSON.Feature<GeoJSON.Polygon> = {
      type: "Feature",
      id: uniqueId,
      geometry: {
        type: "Polygon",
        coordinates,
      },
      properties: {
        ...propertiesRaw,
        id: uniqueId,
        type: propertiesRaw.type,
        modelType,
        height,
        baseHeight,
        scaleLength,
        scaleWidth,
        scaleHeight,
        rotationDeg,
        selected: false,
      },
    };

    result.push({
      id: uniqueId,
      feature,
    });
  }

  return result;
}

function buildLayoutExportFile(buildings: ReadonlyMap<string, GeoJSON.Feature>): LayoutFileV1 {
  const exportedBuildings: LayoutFileBuilding[] = [];
  for (const [id, feature] of buildings.entries()) {
    if (!feature.geometry || feature.geometry.type !== "Polygon") {
      continue;
    }
    const properties = asPropertiesRecord(feature.properties);
    const { selected: _selected, ...restProperties } = properties;
    const coordinates = feature.geometry.coordinates.map((ring) =>
      ring.map((position) => [Number(position[0]), Number(position[1])] as GeoJSON.Position),
    );
    exportedBuildings.push({
      id,
      feature: {
        type: "Feature",
        id,
        geometry: {
          type: "Polygon",
          coordinates,
        },
        properties: {
          ...restProperties,
          id,
        },
      },
    });
  }

  return {
    format: LAYOUT_FILE_FORMAT,
    version: LAYOUT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    buildings: exportedBuildings,
  };
}

function parseRoadCollection(raw: unknown): RoadCollection {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Road data is missing or invalid.");
  }
  const candidate = raw as GeoJSON.FeatureCollection<GeoJSON.Geometry, RoadFeatureProperties>;
  if (candidate.type !== "FeatureCollection" || !Array.isArray(candidate.features)) {
    throw new Error("Road data is not a GeoJSON FeatureCollection.");
  }

  const features: Array<GeoJSON.Feature<GeoJSON.LineString, RoadFeatureProperties>> = [];
  for (const feature of candidate.features) {
    if (!feature.geometry || feature.geometry.type !== "LineString") {
      continue;
    }
    const coordinates = feature.geometry.coordinates
      .filter((coord): coord is number[] => Array.isArray(coord) && coord.length >= 2)
      .map((coord) => [Number(coord[0]), Number(coord[1])]);
    if (coordinates.length < 2) {
      continue;
    }

    features.push({
      type: "Feature",
      id: feature.id,
      geometry: { type: "LineString", coordinates },
      properties: { ...(feature.properties ?? {}) },
    });
  }

  return { type: "FeatureCollection", features };
}

function extractFeatureIndex(feature: FeatureLike): number | null {
  const fromProperties = feature.properties?.featureIndex;
  if (typeof fromProperties === "number" && Number.isFinite(fromProperties)) {
    return fromProperties;
  }
  if (typeof fromProperties === "string") {
    const parsed = Number.parseInt(fromProperties, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof feature.id === "number" && Number.isFinite(feature.id)) {
    return feature.id;
  }
  if (typeof feature.id === "string") {
    const parsed = Number.parseInt(feature.id, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function distance2ToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ddx = px - x1;
    const ddy = py - y1;
    return ddx * ddx + ddy * ddy;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ddx = px - projX;
  const ddy = py - projY;
  return ddx * ddx + ddy * ddy;
}

function featureDistance2InPixels(
  map: maplibregl.Map,
  feature: FeatureLike,
  px: number,
  py: number,
): number {
  if (!feature.geometry) {
    return Number.POSITIVE_INFINITY;
  }

  const measureLine = (line: number[][]): number => {
    if (line.length < 2) {
      return Number.POSITIVE_INFINITY;
    }
    let best = Number.POSITIVE_INFINITY;
    for (let idx = 1; idx < line.length; idx += 1) {
      const a = map.project([line[idx - 1][0], line[idx - 1][1]]);
      const b = map.project([line[idx][0], line[idx][1]]);
      best = Math.min(best, distance2ToSegment(px, py, a.x, a.y, b.x, b.y));
    }
    return best;
  };

  if (feature.geometry.type === "LineString") {
    return measureLine(feature.geometry.coordinates as number[][]);
  }
  if (feature.geometry.type === "MultiLineString") {
    let best = Number.POSITIVE_INFINITY;
    for (const line of feature.geometry.coordinates as number[][][]) {
      best = Math.min(best, measureLine(line));
    }
    return best;
  }
  return Number.POSITIVE_INFINITY;
}

type GeoJsonSourceWithData = maplibregl.GeoJSONSource & { _data?: GeoJSON.GeoJSON };
type TrafficRoute = {
  originNode: string;
  destNode: string;
  edgeIds: string[];
};
type TrafficParticle = {
  id: string;
  route: TrafficRoute;
  edgeIndex: number;
  edgeProgressM: number;
  position: [number, number];
  speedFactor: number;
  headwayFactor: number;
  currentSpeedMps: number;
};

function asFeatureCollection(
  geojson: GeoJSON.GeoJSON | undefined,
): GeoJSON.FeatureCollection | null {
  if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    return null;
  }
  return geojson;
}

function mergeClosedFeatureSets(...sets: ReadonlyArray<ReadonlySet<number>>): Set<number> {
  const merged = new Set<number>();
  for (const set of sets) {
    for (const value of set) {
      merged.add(value);
    }
  }
  return merged;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readFeatureScaleFactor(properties: Record<string, unknown>, key: "scaleLength" | "scaleWidth" | "scaleHeight"): number {
  const parsed = Number.parseFloat(String(properties[key] ?? 1));
  const value = Number.isFinite(parsed) ? parsed : 1;
  return clampNumber(value, MIN_MODEL_SCALE_PERCENT / 100, MAX_MODEL_SCALE_PERCENT / 100);
}

function readFeatureScaleFactorOrDefault(
  properties: Record<string, unknown>,
  key: "scaleLength" | "scaleWidth" | "scaleHeight",
  defaultValue: number,
): number {
  const raw = properties[key];
  if (raw === undefined || raw === null) {
    return clampNumber(defaultValue, MIN_MODEL_SCALE_PERCENT / 100, MAX_MODEL_SCALE_PERCENT / 100);
  }
  return readFeatureScaleFactor(properties, key);
}

function readFeatureRotationDeg(properties: Record<string, unknown>): number {
  const parsed = Number.parseFloat(String(properties.rotationDeg ?? 0));
  const value = Number.isFinite(parsed) ? parsed : 0;
  return clampNumber(value, MIN_MODEL_ROTATION_DEG, MAX_MODEL_ROTATION_DEG);
}

function readFeatureRotationDegOrDefault(
  properties: Record<string, unknown>,
  defaultValue: number,
): number {
  const raw = properties.rotationDeg;
  if (raw === undefined || raw === null) {
    return clampNumber(defaultValue, MIN_MODEL_ROTATION_DEG, MAX_MODEL_ROTATION_DEG);
  }
  return readFeatureRotationDeg(properties);
}

function asPropertiesRecord(
  properties: GeoJSON.GeoJsonProperties | null | undefined,
): Record<string, unknown> {
  if (!properties || typeof properties !== "object") {
    return {};
  }
  return { ...properties } as Record<string, unknown>;
}

function extractBuildingId(
  feature:
    | GeoJSON.Feature
    | maplibregl.MapGeoJSONFeature
    | { id?: string | number; properties?: Record<string, unknown> },
): string | null {
  const idFromProperties = feature.properties?.id;
  if (typeof idFromProperties === "string" || typeof idFromProperties === "number") {
    return String(idFromProperties);
  }
  if (typeof feature.id === "string" || typeof feature.id === "number") {
    return String(feature.id);
  }
  return null;
}

function asBuildingModelType(value: unknown): BuildingModelType | null {
  if (typeof value !== "string") {
    return null;
  }
  return BUILDING_MODEL_OPTIONS.some((option) => option.id === value)
    ? (value as BuildingModelType)
    : null;
}

function getBuildingModelOption(modelType: BuildingModelType): BuildingModelOption {
  const option = BUILDING_MODEL_OPTIONS.find((item) => item.id === modelType);
  return option ?? BUILDING_MODEL_OPTIONS[0];
}

function getBuildingTemplate(templateId: string): BuildingTemplate {
  const template = BUILDING_TEMPLATES.find((item) => item.id === templateId);
  return template ?? BUILDING_TEMPLATES[0];
}

function polygonFeatureCenter(feature: GeoJSON.Feature): [number, number] | null {
  if (!feature.geometry || feature.geometry.type !== "Polygon") {
    return null;
  }
  const ring = feature.geometry.coordinates[0];
  if (!ring || ring.length < 4) {
    return null;
  }
  const uniquePoints = ring.length > 1 ? ring.slice(0, ring.length - 1) : ring;
  if (uniquePoints.length === 0) {
    return null;
  }

  let lngSum = 0;
  let latSum = 0;
  for (const [lng, lat] of uniquePoints) {
    lngSum += lng;
    latSum += lat;
  }
  return [lngSum / uniquePoints.length, latSum / uniquePoints.length];
}

function polygonFootprintDimensionsMeters(
  feature: GeoJSON.Feature,
): { widthM: number; depthM: number } | null {
  if (!feature.geometry || feature.geometry.type !== "Polygon") {
    return null;
  }
  const ring = feature.geometry.coordinates[0];
  if (!ring || ring.length < 4) {
    return null;
  }

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const centerLat = (minLat + maxLat) / 2;
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.max(1, Math.cos((centerLat * Math.PI) / 180) * 111320);
  const widthM = Math.max(1, (maxLng - minLng) * metersPerDegLng);
  const depthM = Math.max(1, (maxLat - minLat) * metersPerDegLat);
  return { widthM, depthM };
}

function scaleFromDimensions(
  modelType: BuildingModelType,
  widthM: number,
  depthM: number,
  heightM: number,
): [number, number, number] {
  const option = getBuildingModelOption(modelType);
  const multiplier = option.supersizeMultiplier;
  return [
    clampNumber((widthM / option.referenceWidthM) * multiplier, 0.25, 300),
    clampNumber((depthM / option.referenceDepthM) * multiplier, 0.25, 300),
    clampNumber((heightM / option.referenceHeightM) * multiplier, 0.25, 300),
  ];
}

function buildScenegraphInstances(
  buildings: ReadonlyMap<string, GeoJSON.Feature>,
): ScenegraphBuildingInstance[] {
  const instances: ScenegraphBuildingInstance[] = [];
  for (const [id, feature] of buildings.entries()) {
    const center = polygonFeatureCenter(feature);
    if (!center) {
      continue;
    }
    const properties = asPropertiesRecord(feature.properties);
    const modelType = asBuildingModelType(properties.modelType) ?? "building";
    const option = getBuildingModelOption(modelType);
    const heightValue = Math.max(1, Number.parseFloat(String(properties.height ?? 20)) || 20);
    const dims = polygonFootprintDimensionsMeters(feature);
    const widthM = dims?.widthM ?? 20;
    const depthM = dims?.depthM ?? 20;
    const scaleLength = readFeatureScaleFactor(properties, "scaleLength");
    const scaleWidth = readFeatureScaleFactor(properties, "scaleWidth");
    const scaleHeight = readFeatureScaleFactor(properties, "scaleHeight");
    const rotationDeg = readFeatureRotationDeg(properties);
    const scaledWidthM = widthM * scaleLength;
    const scaledDepthM = depthM * scaleWidth;
    const scaledHeightM = heightValue * scaleHeight;
    instances.push({
      id,
      modelType,
      position: [center[0], center[1], 0],
      scale: scaleFromDimensions(modelType, scaledWidthM, scaledDepthM, scaledHeightM),
      // Apply user rotation as yaw so models rotate on the horizontal plane.
      orientation: [option.orientation[0], option.orientation[1] + rotationDeg, option.orientation[2]],
    });
  }
  return instances;
}

function normalizeRotationDegrees(value: number): number {
  let normalized = ((value % 360) + 360) % 360;
  if (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

function rectangleCoordinatesFromCenter(
  center: [number, number],
  widthM: number,
  depthM: number,
  rotationDeg: number,
): GeoJSON.Position[][] {
  const [centerLng, centerLat] = center;
  const latRad = (centerLat * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.max(1, Math.cos(latRad) * metersPerDegLat);
  const theta = (rotationDeg * Math.PI) / 180;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const halfWidth = widthM / 2;
  const halfDepth = depthM / 2;

  const localCorners: Array<[number, number]> = [
    [-halfWidth, -halfDepth],
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
    [-halfWidth, halfDepth],
  ];

  const ring = localCorners.map(([x, y]) => {
    const rotatedX = x * cosTheta - y * sinTheta;
    const rotatedY = x * sinTheta + y * cosTheta;
    const lng = centerLng + rotatedX / metersPerDegLng;
    const lat = centerLat + rotatedY / metersPerDegLat;
    return [lng, lat] as GeoJSON.Position;
  });
  ring.push(ring[0]);
  return [ring];
}

function createPlacementFeature(
  id: string,
  coordinates: GeoJSON.Position[][],
  height: number,
  modelType: BuildingModelType,
  rotationDeg: number,
  selected = false,
): GeoJSON.Feature<GeoJSON.Polygon> {
  return {
    type: "Feature",
    id,
    geometry: {
      type: "Polygon",
      coordinates,
    },
    properties: {
      id,
      height,
      type: "palette-building",
      baseHeight: 0,
      modelType,
      scaleLength: 1,
      scaleWidth: 1,
      scaleHeight: 1,
      rotationDeg: normalizeRotationDegrees(rotationDeg),
      selected,
    },
  };
}

function emptyTrafficPointCollection(): GeoJSON.FeatureCollection<
  GeoJSON.Point,
  { particleId: string }
> {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function edgeSpeedMps(edgeLengthM: number, edgeMetric: EdgeMetric | undefined): number {
  if (!edgeMetric || edgeMetric.closed || !Number.isFinite(edgeMetric.time) || edgeMetric.time <= 0) {
    return 0;
  }
  return clampNumber(edgeLengthM / edgeMetric.time, 1.2, 30);
}

function laneOffsetMetersForEdge(edge: Graph["edges"][number]): number {
  const directionalSign = edge.id.endsWith("_a") ? 1 : edge.id.endsWith("_b") ? -1 : 0;
  const sideSign = directionalSign !== 0 ? directionalSign : (hashNodeId(edge.id) & 1) === 0 ? 1 : -1;
  const variationBucket = hashNodeId(`${edge.id}:lane`) % 3;
  const variation = variationBucket === 0 ? 0 : variationBucket === 1 ? TRAFFIC_LANE_OFFSET_VARIATION_M : -TRAFFIC_LANE_OFFSET_VARIATION_M;
  return sideSign * (TRAFFIC_LANE_OFFSET_BASE_M + variation);
}

function interpolateAlongEdge(
  edge: Graph["edges"][number],
  progressM: number,
): [number, number] {
  const start = edge.coords[0];
  const end = edge.coords[edge.coords.length - 1];
  if (!start || !end) {
    return [0, 0];
  }
  const edgeLength = Math.max(1, edge.lengthM);
  const t = clampNumber(progressM / edgeLength, 0, 1);
  const lng = start[0] + (end[0] - start[0]) * t;
  const lat = start[1] + (end[1] - start[1]) * t;

  const midLatRad = (((start[1] + end[1]) * 0.5) * Math.PI) / 180;
  const vx = (end[0] - start[0]) * Math.cos(midLatRad);
  const vy = end[1] - start[1];
  const norm = Math.hypot(vx, vy);
  if (norm <= 1e-9) {
    return [lng, lat];
  }

  const perpX = -vy / norm;
  const perpY = vx / norm;
  const laneOffsetM = laneOffsetMetersForEdge(edge);
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.max(1e-6, metersPerDegLat * Math.cos(midLatRad));

  return [
    lng + (perpX * laneOffsetM) / metersPerDegLng,
    lat + (perpY * laneOffsetM) / metersPerDegLat,
  ];
}

function buildTrafficRoutePool(
  graph: Graph,
  odPairs: ODPair[],
  edgeMetrics: Map<string, EdgeMetric>,
): TrafficRoute[] {
  const edgeTimes = new Map<string, number>();
  for (const edge of graph.edges) {
    const metric = edgeMetrics.get(edge.id);
    if (!metric || metric.closed || !Number.isFinite(metric.time)) {
      edgeTimes.set(edge.id, Number.POSITIVE_INFINITY);
      continue;
    }
    edgeTimes.set(edge.id, Math.max(0.05, metric.time));
  }

  const routes: TrafficRoute[] = [];
  const reverseAdjacency = buildReverseAdjacency(graph);
  const byDestination = new Map<string, ODPair[]>();

  for (const od of odPairs) {
    const bucket = byDestination.get(od.destNode);
    if (bucket) {
      bucket.push(od);
    } else {
      byDestination.set(od.destNode, [od]);
    }
  }

  for (const [destinationNode, destinationPairs] of byDestination) {
    if (routes.length >= TRAFFIC_ROUTE_POOL_MAX) {
      break;
    }

    const tree = dijkstraTreeToDestination(
      graph,
      destinationNode,
      edgeTimes,
      reverseAdjacency,
    );

    for (const od of destinationPairs) {
      if (routes.length >= TRAFFIC_ROUTE_POOL_MAX) {
        break;
      }
      const edgeIds = reconstructPathFromTree(graph, od.originNode, od.destNode, tree);
      if (edgeIds.length === 0) {
        continue;
      }
      routes.push({
        originNode: od.originNode,
        destNode: od.destNode,
        edgeIds,
      });
    }
  }

  if (routes.length > 0) {
    return routes;
  }

  for (const edge of graph.edges) {
    if (routes.length >= TRAFFIC_ROUTE_POOL_MAX) {
      break;
    }
    const metric = edgeMetrics.get(edge.id);
    if (!metric || metric.closed || !Number.isFinite(metric.time)) {
      continue;
    }
    routes.push({
      originNode: edge.from,
      destNode: edge.to,
      edgeIds: [edge.id],
    });
  }

  return routes;
}

function randomTrafficRoute(routePool: TrafficRoute[]): TrafficRoute | null {
  if (routePool.length === 0) {
    return null;
  }
  return routePool[Math.floor(Math.random() * routePool.length)] ?? null;
}

function assignParticleRoute(
  particle: TrafficParticle,
  graph: Graph,
  routePool: TrafficRoute[],
  spawnAtStart = false,
): boolean {
  const route = randomTrafficRoute(routePool);
  if (!route) {
    return false;
  }

  const edgeIndex = spawnAtStart
    ? 0
    : Math.min(
        route.edgeIds.length - 1,
        Math.floor(Math.random() * Math.max(1, route.edgeIds.length)),
      );
  const edge = graph.edgesById.get(route.edgeIds[edgeIndex]);
  if (!edge) {
    return false;
  }

  const spawnStaggerRatio = (hashNodeId(`${particle.id}:${route.edgeIds[0]}`) % 1000) / 1000;
  const spawnWindowM = Math.min(TRAFFIC_SPAWN_STAGGER_M, Math.max(0.75, edge.lengthM * 0.35));
  const edgeProgressM = spawnAtStart
    ? spawnStaggerRatio * spawnWindowM
    : Math.random() * Math.max(1, edge.lengthM * 0.8);
  particle.route = route;
  particle.edgeIndex = edgeIndex;
  particle.edgeProgressM = edgeProgressM;
  particle.position = interpolateAlongEdge(edge, edgeProgressM);
  return true;
}

function buildTrafficParticles(
  graph: Graph,
  routePool: TrafficRoute[],
): TrafficParticle[] {
  if (routePool.length === 0) {
    return [];
  }

  const particleCount = clampNumber(
    Math.max(260, Math.round(routePool.length * 0.55)),
    260,
    TRAFFIC_PARTICLE_MAX_COUNT,
  );

  const particles: TrafficParticle[] = [];
  for (let index = 0; index < particleCount; index += 1) {
    const route = randomTrafficRoute(routePool);
    if (!route) {
      break;
    }
    const firstEdge = graph.edgesById.get(route.edgeIds[0]);
    if (!firstEdge) {
      continue;
    }
    const particle: TrafficParticle = {
      id: `particle-${index}`,
      route,
      edgeIndex: 0,
      edgeProgressM: 0,
      position: firstEdge.coords[0] ?? [0, 0],
      speedFactor: 0.9 + Math.random() * 0.65,
      headwayFactor: 0.82 + Math.random() * 0.42,
      currentSpeedMps: 3 + Math.random() * 6,
    };
    if (!assignParticleRoute(particle, graph, routePool)) {
      continue;
    }
    particles.push(particle);
  }

  return particles;
}

function hashNodeId(nodeId: string): number {
  let hash = 0;
  for (let idx = 0; idx < nodeId.length; idx += 1) {
    hash = (hash * 31 + nodeId.charCodeAt(idx)) >>> 0;
  }
  return hash;
}

function movementAxisForEdge(edge: Edge): 0 | 1 {
  const start = edge.coords[0];
  const end = edge.coords[edge.coords.length - 1];
  if (!start || !end) {
    return 0;
  }
  const deltaLng = Math.abs(end[0] - start[0]);
  const deltaLat = Math.abs(end[1] - start[1]);
  return deltaLng >= deltaLat ? 0 : 1;
}

function isIntersectionSignalGreen(nodeId: string, incomingEdge: Edge, simTimeSec: number): boolean {
  const hash = hashNodeId(nodeId);
  const cycle =
    TRAFFIC_SIGNAL_BASE_CYCLE_SEC + (hash % Math.max(1, TRAFFIC_SIGNAL_CYCLE_VARIANCE_SEC));
  const greenDuration = cycle * TRAFFIC_SIGNAL_GREEN_RATIO;
  const phaseOffset = ((hash >>> 3) % 1000) / 1000 * cycle;
  const phase = (simTimeSec + phaseOffset) % cycle;
  const primaryAxis = ((hash >>> 7) & 1) as 0 | 1;
  const movementAxis = movementAxisForEdge(incomingEdge);
  const primaryIsGreen = phase < greenDuration;
  return movementAxis === primaryAxis ? primaryIsGreen : !primaryIsGreen;
}

function intersectionHoldBackForEdge(edge: Edge): number {
  const slot = hashNodeId(edge.id) % Math.max(1, TRAFFIC_INTERSECTION_APPROACH_OFFSET_SLOTS);
  return TRAFFIC_INTERSECTION_HOLD_BACK_M + slot * TRAFFIC_INTERSECTION_APPROACH_OFFSET_STEP_M;
}

const SIGNAL_NODE_CACHE = new WeakMap<Graph, Set<string>>();

function signalControlledNodes(graph: Graph): Set<string> {
  const cached = SIGNAL_NODE_CACHE.get(graph);
  if (cached) {
    return cached;
  }

  const neighbors = new Map<string, Set<string>>();
  for (const nodeId of graph.nodes.keys()) {
    neighbors.set(nodeId, new Set<string>());
  }
  for (const edge of graph.edges) {
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }

  const controlled = new Set<string>();
  for (const [nodeId, nodeNeighbors] of neighbors) {
    if (nodeNeighbors.size >= 3) {
      controlled.add(nodeId);
    }
  }

  SIGNAL_NODE_CACHE.set(graph, controlled);
  return controlled;
}

function buildEdgeVehicleBuckets(particles: TrafficParticle[]): Map<string, TrafficParticle[]> {
  const buckets = new Map<string, TrafficParticle[]>();
  for (const particle of particles) {
    const edgeId = particle.route.edgeIds[particle.edgeIndex];
    if (!edgeId) {
      continue;
    }
    const edgeVehicles = buckets.get(edgeId);
    if (edgeVehicles) {
      edgeVehicles.push(particle);
    } else {
      buckets.set(edgeId, [particle]);
    }
  }
  for (const edgeVehicles of buckets.values()) {
    if (edgeVehicles.length > 1) {
      edgeVehicles.sort((a, b) => b.edgeProgressM - a.edgeProgressM);
    }
  }
  return buckets;
}

function enforceEdgeSpacing(
  particles: TrafficParticle[],
  graph: Graph,
  controlledSignalNodes: ReadonlySet<string>,
): void {
  const buckets = buildEdgeVehicleBuckets(particles);
  for (const edgeVehicles of buckets.values()) {
    if (edgeVehicles.length <= 1) {
      continue;
    }

    edgeVehicles.sort((a, b) => b.edgeProgressM - a.edgeProgressM);
    let leader = edgeVehicles[0];
    for (let idx = 1; idx < edgeVehicles.length; idx += 1) {
      const follower = edgeVehicles[idx];
      const leaderEdgeId = leader.route.edgeIds[leader.edgeIndex];
      const followerEdgeId = follower.route.edgeIds[follower.edgeIndex];
      if (!leaderEdgeId || !followerEdgeId || leaderEdgeId !== followerEdgeId) {
        leader = follower;
        continue;
      }

      const followerEdge = graph.edgesById.get(followerEdgeId);
      if (!followerEdge) {
        leader = follower;
        continue;
      }
      const edgeLength = Math.max(1, followerEdge.lengthM);
      const baseGapM = TRAFFIC_FOLLOW_MIN_GAP_M * follower.headwayFactor;
      let minGapM = baseGapM;
      if (controlledSignalNodes.has(followerEdge.to)) {
        const stopLineProgress = Math.max(0, edgeLength - intersectionHoldBackForEdge(followerEdge));
        const nearStopLineThreshold = stopLineProgress - TRAFFIC_INTERSECTION_SLOW_ZONE_M;
        const leaderNearStop = leader.edgeProgressM >= nearStopLineThreshold;
        const followerNearStop = follower.edgeProgressM >= nearStopLineThreshold;
        if (leaderNearStop || followerNearStop) {
          minGapM = Math.max(minGapM, TRAFFIC_INTERSECTION_QUEUE_GAP_M * follower.headwayFactor);
        }
      }
      const maxProgress = Math.max(0, leader.edgeProgressM - minGapM);
      if (follower.edgeProgressM > maxProgress) {
        follower.edgeProgressM = maxProgress;
        follower.currentSpeedMps = Math.min(follower.currentSpeedMps, leader.currentSpeedMps);
      }
      follower.edgeProgressM = clampNumber(follower.edgeProgressM, 0, edgeLength);
      follower.position = interpolateAlongEdge(followerEdge, follower.edgeProgressM);
      leader = follower;
    }
  }
}

function advanceTrafficParticles(
  particles: TrafficParticle[],
  graph: Graph,
  edgeMetrics: Map<string, EdgeMetric>,
  routePool: TrafficRoute[],
  simTimeSec: number,
  nodeNextRelease: Map<string, number>,
  deltaSeconds: number,
): void {
  if (particles.length === 0) {
    return;
  }

  const dt = Math.max(0.02, Math.min(0.25, deltaSeconds));
  const edgeBuckets = buildEdgeVehicleBuckets(particles);
  const controlledSignalNodes = signalControlledNodes(graph);

  for (const edgeVehicles of edgeBuckets.values()) {
    let leaderProgressOnEdge = Number.POSITIVE_INFINITY;

    for (let idx = 0; idx < edgeVehicles.length; idx += 1) {
      const particle = edgeVehicles[idx];
      const startingEdgeId = particle.route.edgeIds[particle.edgeIndex];
      let edgeId = startingEdgeId;
      let edge = edgeId ? graph.edgesById.get(edgeId) : undefined;
      let metric = edge ? edgeMetrics.get(edge.id) : undefined;

      if (!edge || !metric || metric.closed || !Number.isFinite(metric.time)) {
        if (!assignParticleRoute(particle, graph, routePool, true)) {
          continue;
        }
        edgeId = particle.route.edgeIds[particle.edgeIndex];
        edge = edgeId ? graph.edgesById.get(edgeId) : undefined;
        metric = edge ? edgeMetrics.get(edge.id) : undefined;
        if (!edge || !metric || metric.closed || !Number.isFinite(metric.time)) {
          continue;
        }
      }

      const edgeLength = Math.max(1, edge.lengthM);
      const nodeIsSignalized = controlledSignalNodes.has(edge.to);
      const stopLineProgress = nodeIsSignalized
        ? Math.max(0, edgeLength - intersectionHoldBackForEdge(edge))
        : edgeLength;
      const distanceToStop = stopLineProgress - particle.edgeProgressM;
      const baseSpeedMps =
        edgeSpeedMps(edge.lengthM, metric) * TRAFFIC_PARTICLE_SPEED_SCALE * particle.speedFactor;
      const nextOpenTime = nodeNextRelease.get(edge.to) ?? 0;
      const movementGreen = isIntersectionSignalGreen(edge.to, edge, simTimeSec);
      const intersectionBlocked = nodeIsSignalized && (!movementGreen || simTimeSec < nextOpenTime);

      const minGapM = TRAFFIC_FOLLOW_MIN_GAP_M * particle.headwayFactor;
      const desiredGapM =
        minGapM +
        particle.currentSpeedMps * TRAFFIC_FOLLOW_TIME_HEADWAY_SEC * particle.headwayFactor;

      let targetSpeedMps = baseSpeedMps;
      if (Number.isFinite(leaderProgressOnEdge)) {
        const gapToLeaderM = leaderProgressOnEdge - particle.edgeProgressM;
        if (gapToLeaderM <= minGapM) {
          targetSpeedMps = 0;
        } else {
          const headwayLimitedSpeed = Math.max(0, (gapToLeaderM - desiredGapM) / dt);
          targetSpeedMps = Math.min(targetSpeedMps, headwayLimitedSpeed);
        }
      }

      if (distanceToStop <= TRAFFIC_INTERSECTION_SLOW_ZONE_M) {
        const approachRatio = clampNumber(distanceToStop / TRAFFIC_INTERSECTION_SLOW_ZONE_M, 0, 1);
        const intersectionSlowFactor = intersectionBlocked
          ? TRAFFIC_INTERSECTION_SLOW_FACTOR
          : TRAFFIC_INTERSECTION_GREEN_SLOW_FACTOR;
        const slowdown =
          intersectionSlowFactor + (1 - intersectionSlowFactor) * approachRatio;
        targetSpeedMps = Math.min(
          targetSpeedMps,
          baseSpeedMps * clampNumber(slowdown, intersectionSlowFactor, 1),
        );
      }

      if (intersectionBlocked) {
        const stoppingSpeedLimit = Math.max(0, distanceToStop) / dt;
        targetSpeedMps = Math.min(targetSpeedMps, stoppingSpeedLimit);
      }

      if (!Number.isFinite(particle.currentSpeedMps) || particle.currentSpeedMps < 0) {
        particle.currentSpeedMps = 0;
      }
      const accelStep = TRAFFIC_MAX_ACCEL_MPS2 * dt;
      const brakeStep = TRAFFIC_MAX_BRAKE_MPS2 * dt;
      if (targetSpeedMps > particle.currentSpeedMps) {
        particle.currentSpeedMps = Math.min(targetSpeedMps, particle.currentSpeedMps + accelStep);
      } else {
        particle.currentSpeedMps = Math.max(targetSpeedMps, particle.currentSpeedMps - brakeStep);
      }

      let candidateProgress = particle.edgeProgressM + particle.currentSpeedMps * dt;
      if (Number.isFinite(leaderProgressOnEdge)) {
        const maxProgress = leaderProgressOnEdge - minGapM;
        candidateProgress = Math.min(candidateProgress, maxProgress);
      }
      candidateProgress = Math.max(particle.edgeProgressM, candidateProgress);

      let hop = 0;
      let activeEdge: Edge | undefined = edge;
      let activeMetric: EdgeMetric | undefined = metric;
      let activeEdgeLength = edgeLength;

      while (candidateProgress >= activeEdgeLength && hop < 6) {
        const nodeId = activeEdge.to;
        const activeNextOpenTime = nodeNextRelease.get(nodeId) ?? 0;
        const signalGreen = isIntersectionSignalGreen(nodeId, activeEdge, simTimeSec);
        const nodeIsSignalized = controlledSignalNodes.has(nodeId);
        if (nodeIsSignalized && (simTimeSec < activeNextOpenTime || !signalGreen)) {
          const holdAt = Math.max(0, activeEdgeLength - intersectionHoldBackForEdge(activeEdge));
          candidateProgress = Math.min(candidateProgress, holdAt);
          if (candidateProgress >= holdAt - TRAFFIC_INTERSECTION_STOP_EPS_M) {
            particle.currentSpeedMps = Math.min(particle.currentSpeedMps, 0.8);
          }
          break;
        }

        if (nodeIsSignalized) {
          nodeNextRelease.set(nodeId, simTimeSec + TRAFFIC_INTERSECTION_HEADWAY_SEC);
        }
        candidateProgress -= activeEdgeLength;
        particle.edgeIndex += 1;
        hop += 1;

        if (particle.edgeIndex >= particle.route.edgeIds.length) {
          if (!assignParticleRoute(particle, graph, routePool, true)) {
            break;
          }
          particle.currentSpeedMps = Math.max(2.5, particle.currentSpeedMps * 0.65);
          candidateProgress = particle.edgeProgressM;
        }

        edgeId = particle.route.edgeIds[particle.edgeIndex];
        activeEdge = edgeId ? graph.edgesById.get(edgeId) : undefined;
        activeMetric = activeEdge ? edgeMetrics.get(activeEdge.id) : undefined;
        if (
          !activeEdge ||
          !activeMetric ||
          activeMetric.closed ||
          !Number.isFinite(activeMetric.time)
        ) {
          if (!assignParticleRoute(particle, graph, routePool, true)) {
            break;
          }
          edgeId = particle.route.edgeIds[particle.edgeIndex];
          activeEdge = edgeId ? graph.edgesById.get(edgeId) : undefined;
          activeMetric = activeEdge ? edgeMetrics.get(activeEdge.id) : undefined;
          if (
            !activeEdge ||
            !activeMetric ||
            activeMetric.closed ||
            !Number.isFinite(activeMetric.time)
          ) {
            break;
          }
          particle.currentSpeedMps = Math.min(particle.currentSpeedMps, 2);
          candidateProgress = particle.edgeProgressM;
        }

        activeEdgeLength = Math.max(1, activeEdge.lengthM);
      }

      edgeId = particle.route.edgeIds[particle.edgeIndex];
      edge = edgeId ? graph.edgesById.get(edgeId) : undefined;
      if (!edge) {
        continue;
      }
      const finalEdgeLength = Math.max(1, edge.lengthM);
      let clampedProgress = clampNumber(candidateProgress, 0, finalEdgeLength);
      if (edgeId === startingEdgeId) {
        const localStopLine = Math.max(0, finalEdgeLength - intersectionHoldBackForEdge(edge));
        const localNextOpenTime = nodeNextRelease.get(edge.to) ?? 0;
        const localGreen = isIntersectionSignalGreen(edge.to, edge, simTimeSec);
        const nodeIsSignalized = controlledSignalNodes.has(edge.to);
        if (
          nodeIsSignalized &&
          (!localGreen || simTimeSec < localNextOpenTime) &&
          clampedProgress > localStopLine
        ) {
          clampedProgress = localStopLine;
          particle.currentSpeedMps = Math.min(particle.currentSpeedMps, 0.8);
        }
      }
      particle.edgeProgressM = clampedProgress;
      particle.position = interpolateAlongEdge(edge, clampedProgress);
      if (edgeId === startingEdgeId) {
        leaderProgressOnEdge = clampedProgress;
      } else {
        leaderProgressOnEdge = Number.POSITIVE_INFINITY;
      }
    }
  }

  enforceEdgeSpacing(particles, graph, controlledSignalNodes);
}

function trafficParticlesToFeatures(
  particles: TrafficParticle[],
): Array<GeoJSON.Feature<GeoJSON.Point, { particleId: string }>> {
  return particles.map((particle) => ({
    type: "Feature",
    properties: { particleId: particle.id },
    geometry: {
      type: "Point",
      coordinates: particle.position,
    },
  }));
}

export default function App() {
  const token =
    (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ??
    (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined);
  const hasToken = typeof token === "string" && token.trim().length > 0;

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const roadsRef = useRef<RoadCollection | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const odPairsRef = useRef<ODPair[]>([]);
  const probePairsRef = useRef<ODPair[]>([]);
  const sampleSignatureRef = useRef("");
  const closureSeedNodeCountRef = useRef(0);
  const manualClosedFeaturesRef = useRef<Set<number>>(new Set<number>());
  const buildingClosedFeaturesRef = useRef<Set<number>>(new Set<number>());
  const roadFeatureBBoxesRef = useRef<Array<[number, number, number, number]>>([]);
  const trafficParticlesRef = useRef<TrafficParticle[]>([]);
  const trafficRoutePoolRef = useRef<TrafficRoute[]>([]);
  const trafficEdgeMetricsRef = useRef<Map<string, EdgeMetric>>(new Map());
  const trafficSimulationTimeRef = useRef(0);
  const nodeNextReleaseRef = useRef<Map<string, number>>(new Map());
  const featureMetricsRef = useRef<Map<number, FeatureMetric>>(new Map());
  const trafficAnimationFrameRef = useRef<number | null>(null);
  const trafficLastFrameRef = useRef(0);
  const recomputeTimerRef = useRef<number | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  const polygonBuildingsRef = useRef<Map<string, GeoJSON.Feature>>(new Map());
  const selectedPolygonBuildingIdRef = useRef<string | null>(null);
  const selectedModelTypeRef = useRef<BuildingModelType>("building");
  const selectedTemplateIdRef = useRef<string>(BUILDING_TEMPLATES[0]?.id ?? "");
  const draggingTemplateRef = useRef<BuildingTemplate | null>(null);
  const dragPreviewFeatureRef = useRef<GeoJSON.Feature<GeoJSON.Polygon> | null>(null);
  const dragPreviewLatestRef = useRef<{ center: [number, number]; template: BuildingTemplate } | null>(null);
  const dragRotationOffsetDegRef = useRef(0);
  const dragPreviewFrameRef = useRef<number | null>(null);
  const dragPreviewPendingRef = useRef<{ center: [number, number]; template: BuildingTemplate } | null>(null);
  const topPopupTimerRef = useRef<number | null>(null);
  const layoutFileInputRef = useRef<HTMLInputElement | null>(null);

  const [mapStyle, setMapStyle] = useState<MapboxStyle | string | null>(null);
  const [cursorCoordinates, setCursorCoordinates] = useState<{ lng: number; lat: number } | null>(
    null,
  );
  const [statusText, setStatusText] = useState(
    hasToken ? "Waiting for map..." : "No Mapbox token found. Loading fallback map style...",
  );
  const [isComputing, setIsComputing] = useState(false);
  const [stats, setStats] = useState<SimulationStats>(DEFAULT_STATS);

  const [selectedPolygonBuildingId, setSelectedPolygonBuildingId] = useState<string | null>(null);
  const [selectedModelType, setSelectedModelType] = useState<BuildingModelType>("building");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(BUILDING_TEMPLATES[0]?.id ?? "");
  const [topPopup, setTopPopup] = useState<TopPopup | null>(null);
  const [showResultsPanel, setShowResultsPanel] = useState(false);
  const [polygonBuildings, setPolygonBuildings] = useState<Map<string, GeoJSON.Feature>>(new Map());

  useEffect(() => {
    selectedPolygonBuildingIdRef.current = selectedPolygonBuildingId;
  }, [selectedPolygonBuildingId]);

  useEffect(() => {
    selectedModelTypeRef.current = selectedModelType;
  }, [selectedModelType]);

  useEffect(() => {
    selectedTemplateIdRef.current = selectedTemplateId;
  }, [selectedTemplateId]);

  const showTopPopup = useCallback((message: string, kind: TopPopup["kind"] = "warning") => {
    setTopPopup({ message, kind });
    if (topPopupTimerRef.current !== null) {
      window.clearTimeout(topPopupTimerRef.current);
    }
    topPopupTimerRef.current = window.setTimeout(() => {
      setTopPopup(null);
      topPopupTimerRef.current = null;
    }, 2600);
  }, []);

  const refreshCustomBuildings = useCallback(async () => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    try {
      const response = await fetch("http://localhost:3001/api/buildings");
      if (!response.ok) {
        return;
      }
      const geojson = (await response.json()) as GeoJSON.FeatureCollection<
        GeoJSON.Polygon,
        Record<string, unknown>
      >;

      const sourceId = "custom-buildings";
      const layerId = "custom-buildings-3d";
      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
        return;
      }

      const layers = map.getStyle().layers || [];
      const labelLayerId = layers.find(
        (layer) => layer.type === "symbol" && layer.layout && layer.layout["text-field"],
      )?.id;

      map.addSource(sourceId, {
        type: "geojson",
        data: geojson,
      });

      map.addLayer(
        {
          id: layerId,
          type: "fill-extrusion",
          source: sourceId,
          paint: {
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": ["coalesce", ["get", "height"], 20],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.8,
          },
        },
        labelLayerId,
      );
    } catch (error) {
      console.error("Error refreshing custom buildings:", error);
    }
  }, []);

  const ensurePolygonBuildingsLayer = useCallback((map: maplibregl.Map) => {
    if (!map.getSource(POLYGON_BUILDINGS_SOURCE_ID)) {
      map.addSource(POLYGON_BUILDINGS_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });
    }

    if (!map.getLayer(POLYGON_BUILDINGS_LAYER_ID)) {
      map.addLayer({
        id: POLYGON_BUILDINGS_LAYER_ID,
        type: "fill-extrusion",
        source: POLYGON_BUILDINGS_SOURCE_ID,
        paint: {
          "fill-extrusion-color": [
            "case",
            ["==", ["coalesce", ["get", "selected"], false], true],
            "#f59e0b",
            "#4A90E2",
          ],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["get", "baseHeight"],
          "fill-extrusion-opacity": 0.08,
        },
      });
    }

    if (!map.getLayer(POLYGON_BUILDINGS_OUTLINE_LAYER_ID)) {
      map.addLayer({
        id: POLYGON_BUILDINGS_OUTLINE_LAYER_ID,
        type: "line",
        source: POLYGON_BUILDINGS_SOURCE_ID,
        filter: ["==", ["coalesce", ["get", "selected"], false], true],
        paint: {
          "line-color": "#ffd166",
          "line-width": 3,
          "line-opacity": 1,
        },
      });
    }
  }, []);

  const updatePolygonBuildingsSource = useCallback(
    (map: maplibregl.Map, buildings: Map<string, GeoJSON.Feature>) => {
      ensurePolygonBuildingsLayer(map);
      const source = map.getSource(POLYGON_BUILDINGS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) {
        return;
      }
      const features = Array.from(buildings.values());
      source.setData({
        type: "FeatureCollection",
        features,
      });
    },
    [ensurePolygonBuildingsLayer],
  );

  const updateScenegraphOverlay = useCallback((
    buildings: Map<string, GeoJSON.Feature>,
    previewFeature: GeoJSON.Feature<GeoJSON.Polygon> | null = dragPreviewFeatureRef.current,
  ) => {
    const overlay = deckOverlayRef.current;
    if (!overlay) {
      return;
    }
    const instances = buildScenegraphInstances(buildings);
    if (previewFeature) {
      const previewProperties = asPropertiesRecord(previewFeature.properties);
      const previewMap = new Map<string, GeoJSON.Feature>();
      previewMap.set("__preview__", {
        ...previewFeature,
        id: "__preview__",
        properties: {
          ...previewProperties,
          id: "__preview__",
          selected: false,
        },
      });
      const previewInstances = buildScenegraphInstances(previewMap).map((instance) => ({
        ...instance,
        id: `preview-${instance.id}`,
      }));
      instances.push(...previewInstances);
    }
    const layers = BUILDING_MODEL_OPTIONS.map((option) => {
      const layerData = instances.filter((instance) => instance.modelType === option.id);
      return new ScenegraphLayer<ScenegraphBuildingInstance>({
        id: `scenegraph-${option.id}`,
        data: layerData,
        scenegraph: option.modelUrl,
        pickable: false,
        sizeScale: 1,
        getPosition: (d) => d.position,
        getScale: (d) => d.scale,
        getOrientation: (d) => d.orientation,
        _lighting: "pbr",
      });
    });
    overlay.setProps({ layers });
  }, []);

  const ensureRectanglePreviewLayer = useCallback((map: maplibregl.Map) => {
    if (!map.getSource(RECTANGLE_PREVIEW_SOURCE_ID)) {
      map.addSource(RECTANGLE_PREVIEW_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });
    }

    if (!map.getLayer(RECTANGLE_PREVIEW_FILL_LAYER_ID)) {
      map.addLayer({
        id: RECTANGLE_PREVIEW_FILL_LAYER_ID,
        type: "fill",
        source: RECTANGLE_PREVIEW_SOURCE_ID,
        paint: {
          "fill-color": [
            "case",
            ["==", ["coalesce", ["get", "overlap"], false], true],
            "#dc2626",
            "#16a34a",
          ],
          "fill-opacity": 0.2,
        },
      });
    }

    if (!map.getLayer(RECTANGLE_PREVIEW_LINE_LAYER_ID)) {
      map.addLayer({
        id: RECTANGLE_PREVIEW_LINE_LAYER_ID,
        type: "line",
        source: RECTANGLE_PREVIEW_SOURCE_ID,
        paint: {
          "line-color": [
            "case",
            ["==", ["coalesce", ["get", "overlap"], false], true],
            "#ef4444",
            "#22c55e",
          ],
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
    }
  }, []);

  const updateRectanglePreview = useCallback(
    (
      map: maplibregl.Map,
      previewFeature: GeoJSON.Feature<GeoJSON.Polygon>,
      overlapsExisting: boolean,
    ) => {
      ensureRectanglePreviewLayer(map);
      const source = map.getSource(RECTANGLE_PREVIEW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) {
        return;
      }
      const properties = asPropertiesRecord(previewFeature.properties);
      source.setData({
        type: "FeatureCollection",
        features: [
          {
            ...previewFeature,
            id: "rectangle-preview",
            properties: {
              ...properties,
              overlap: overlapsExisting,
              selected: false,
            },
          },
        ],
      });
      dragPreviewFeatureRef.current = previewFeature;
      updateScenegraphOverlay(polygonBuildingsRef.current, previewFeature);
      try {
        map.moveLayer(RECTANGLE_PREVIEW_FILL_LAYER_ID);
        map.moveLayer(RECTANGLE_PREVIEW_LINE_LAYER_ID);
      } catch {
        // no-op
      }
    },
    [ensureRectanglePreviewLayer, updateScenegraphOverlay],
  );

  const clearRectanglePreview = useCallback((map: maplibregl.Map) => {
    dragPreviewFeatureRef.current = null;
    updateScenegraphOverlay(polygonBuildingsRef.current, null);
    const source = map.getSource(RECTANGLE_PREVIEW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!source) {
      return;
    }
    source.setData({
      type: "FeatureCollection",
      features: [],
    });
  }, [updateScenegraphOverlay]);

  const ensureTrafficParticleLayer = useCallback((map: maplibregl.Map) => {
    if (!map.getSource(TRAFFIC_PARTICLE_SOURCE_ID)) {
      map.addSource(TRAFFIC_PARTICLE_SOURCE_ID, {
        type: "geojson",
        data: emptyTrafficPointCollection(),
      });
    }

    if (!map.getLayer(TRAFFIC_PARTICLE_LAYER_ID)) {
      map.addLayer({
        id: TRAFFIC_PARTICLE_LAYER_ID,
        type: "circle",
        source: TRAFFIC_PARTICLE_SOURCE_ID,
        paint: {
          "circle-color": "#22d3ee",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3.2, 14, 5.8, 17, 8.6],
          "circle-opacity": 0.96,
          "circle-blur": 0.06,
          "circle-pitch-alignment": "map",
          "circle-pitch-scale": "map",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
    }
  }, []);

  const bringTrafficParticlesToFront = useCallback((map: maplibregl.Map) => {
    if (!map.getLayer(TRAFFIC_PARTICLE_LAYER_ID)) {
      return;
    }
    try {
      map.moveLayer(TRAFFIC_PARTICLE_LAYER_ID);
    } catch {
      // no-op
    }
  }, []);

  const updateTrafficParticleSource = useCallback(
    (
      map: maplibregl.Map,
      features: Array<GeoJSON.Feature<GeoJSON.Point, { particleId: string }>>,
    ) => {
      ensureTrafficParticleLayer(map);
      bringTrafficParticlesToFront(map);
      const source = map.getSource(TRAFFIC_PARTICLE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) {
        return;
      }
      source.setData({
        type: "FeatureCollection",
        features,
      });
    },
    [bringTrafficParticlesToFront, ensureTrafficParticleLayer],
  );

  const stopTrafficParticleAnimation = useCallback(() => {
    if (trafficAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(trafficAnimationFrameRef.current);
      trafficAnimationFrameRef.current = null;
    }
  }, []);

  const startTrafficParticleAnimation = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    ensureTrafficParticleLayer(map);
    stopTrafficParticleAnimation();
    trafficLastFrameRef.current = 0;
    if (trafficParticlesRef.current.length === 0) {
      updateTrafficParticleSource(map, []);
      return;
    }
    updateTrafficParticleSource(map, trafficParticlesToFeatures(trafficParticlesRef.current));

    const animate = (timestampMs: number) => {
      const activeMap = mapRef.current;
      const activeGraph = graphRef.current;
      if (!activeMap) {
        trafficAnimationFrameRef.current = null;
        return;
      }
      if (!activeGraph) {
        trafficAnimationFrameRef.current = null;
        return;
      }

      if (trafficLastFrameRef.current <= 0) {
        trafficLastFrameRef.current = timestampMs;
      }
      const deltaMs = timestampMs - trafficLastFrameRef.current;

      if (deltaMs >= TRAFFIC_PARTICLE_FRAME_MS) {
        trafficLastFrameRef.current = timestampMs;
        const particles = trafficParticlesRef.current;
        const deltaSec = deltaMs / 1000;
        trafficSimulationTimeRef.current += deltaSec;

        if (particles.length === 0) {
          updateTrafficParticleSource(activeMap, []);
        } else {
          advanceTrafficParticles(
            particles,
            activeGraph,
            trafficEdgeMetricsRef.current,
            trafficRoutePoolRef.current,
            trafficSimulationTimeRef.current,
            nodeNextReleaseRef.current,
            deltaSec,
          );
          updateTrafficParticleSource(activeMap, trafficParticlesToFeatures(particles));
        }
      }

      trafficAnimationFrameRef.current = window.requestAnimationFrame(animate);
    };

    trafficAnimationFrameRef.current = window.requestAnimationFrame(animate);
  }, [ensureTrafficParticleLayer, stopTrafficParticleAnimation, updateTrafficParticleSource]);

  const setPolygonBuildingSelection = useCallback(
    (map: maplibregl.Map, nextSelectedId: string | null) => {
      let selectedModel: BuildingModelType | null = null;
      let resolvedSelectedId: string | null = nextSelectedId;
      setPolygonBuildings((prev) => {
        if (nextSelectedId && !prev.has(nextSelectedId)) {
          resolvedSelectedId = null;
        }
        const next = new Map<string, GeoJSON.Feature>();
        for (const [id, feature] of prev.entries()) {
          const properties = asPropertiesRecord(feature.properties);
          const isSelected = id === resolvedSelectedId;
          if (isSelected) {
            selectedModel = asBuildingModelType(properties.modelType) ?? "building";
          }
          next.set(id, {
            ...feature,
            properties: {
              ...properties,
              selected: isSelected,
            },
          });
        }
        polygonBuildingsRef.current = next;
        updatePolygonBuildingsSource(map, next);
        updateScenegraphOverlay(next);
        return next;
      });
      setSelectedPolygonBuildingId(resolvedSelectedId);
      if (selectedModel) {
        setSelectedModelType(selectedModel);
      }
      if (resolvedSelectedId) {
        const selectedModelOption = getBuildingModelOption(selectedModel ?? "building");
        console.log("[BUILDING SELECT] Selected building", {
          id: resolvedSelectedId,
          modelType: selectedModelOption.id,
          modelLabel: selectedModelOption.label,
          modelUrl: selectedModelOption.modelUrl,
        });
      } else {
        console.log("[BUILDING SELECT] Cleared building selection");
      }
    },
    [updatePolygonBuildingsSource, updateScenegraphOverlay],
  );

  const addPolygonBuilding = useCallback(
    (map: maplibregl.Map, feature: GeoJSON.Feature) => {
      const buildingId = extractBuildingId(feature) ?? `palette-${Date.now()}`;
      const rawProperties = asPropertiesRecord(feature.properties);
      const modelType = asBuildingModelType(rawProperties.modelType) ?? selectedModelTypeRef.current;
      const scaleLength = readFeatureScaleFactorOrDefault(rawProperties, "scaleLength", 1);
      const scaleWidth = readFeatureScaleFactorOrDefault(rawProperties, "scaleWidth", 1);
      const scaleHeight = readFeatureScaleFactorOrDefault(rawProperties, "scaleHeight", 1);
      const rotationDeg = readFeatureRotationDegOrDefault(rawProperties, 0);
      const heightValue = Math.max(
        1,
        Number.parseFloat(String(rawProperties.height ?? BASE_BUILDING_HEIGHT_M * scaleHeight)) ||
          BASE_BUILDING_HEIGHT_M * scaleHeight,
      );

      setPolygonBuildings((prev) => {
        const next = new Map<string, GeoJSON.Feature>();
        for (const [id, existingFeature] of prev.entries()) {
          const existingProperties = asPropertiesRecord(existingFeature.properties);
          next.set(id, {
            ...existingFeature,
            properties: {
              ...existingProperties,
              selected: false,
            },
          });
        }

        next.set(buildingId, {
          ...feature,
          id: buildingId,
          properties: {
            ...rawProperties,
            id: buildingId,
            height: heightValue,
            type: rawProperties.type ?? "palette-building",
            baseHeight: rawProperties.baseHeight ?? 0,
            modelType,
            scaleLength,
            scaleWidth,
            scaleHeight,
            rotationDeg,
            selected: true,
          },
        });

        polygonBuildingsRef.current = next;
        updatePolygonBuildingsSource(map, next);
        updateScenegraphOverlay(next);
        return next;
      });

      setSelectedPolygonBuildingId(buildingId);
      setSelectedModelType(modelType);
      const modelOption = getBuildingModelOption(modelType);
      console.log("[BUILDING ADD] Added building", {
        id: buildingId,
        scaleLength,
        scaleWidth,
        scaleHeight,
        rotationDeg,
        modelType: modelOption.id,
        modelLabel: modelOption.label,
        modelUrl: modelOption.modelUrl,
      });
      return buildingId;
    },
    [updatePolygonBuildingsSource, updateScenegraphOverlay],
  );

  const evaluateTemplatePlacement = useCallback(
    (
      map: maplibregl.Map,
      center: [number, number],
      template: BuildingTemplate,
      options?: PlacementCheckOptions,
    ): PlacementCheckResult => {
      const snappedRotationDeg = snapToRoadOrientation(center, roadsRef.current) ?? 0;
      const rotationDeg = normalizeRotationDegrees(
        snappedRotationDeg + (options?.rotationOffsetDeg ?? 0),
      );
      const coordinates = rectangleCoordinatesFromCenter(
        center,
        template.widthM,
        template.depthM,
        rotationDeg,
      );
      const modelType = template.modelType ?? selectedModelTypeRef.current;
      const candidate = createPlacementFeature(
        `palette-preview-${Date.now()}`,
        coordinates,
        template.defaultHeightM,
        modelType,
        rotationDeg,
        false,
      );

      const overlapsUser = overlapsUserBuildings(candidate, polygonBuildingsRef.current);
      const candidateRings = extractPolygonRings(candidate);
      const roadPlacementAllowed = modelType === "construction-sign";
      const overlapsRoad =
        !roadPlacementAllowed && roadsRef.current && candidateRings.length > 0
          ? detectRoadClosuresFromBuildingRings(
              roadsRef.current,
              candidateRings,
              roadFeatureBBoxesRef.current,
            ).size > 0
          : false;
      const overlapsBasemap =
        options?.includeBasemap === false
          ? false
          : overlapsBasemapBuildings(map, candidate, [
              POLYGON_BUILDINGS_LAYER_ID,
              POLYGON_BUILDINGS_OUTLINE_LAYER_ID,
              RECTANGLE_PREVIEW_FILL_LAYER_ID,
              RECTANGLE_PREVIEW_LINE_LAYER_ID,
            ]);
      return {
        feature: candidate,
        overlapsUser,
        overlapsRoad,
        overlapsBasemap,
      };
    },
    [],
  );

  const collectBuildingRings = useCallback((): Array<[number, number][]> => {
    const rings: Array<[number, number][]> = [];

    for (const feature of polygonBuildingsRef.current.values()) {
      rings.push(...extractPolygonRings(feature));
    }

    const map = mapRef.current;
    if (!map) {
      return rings;
    }

    const customBuildingsSource = map.getSource("custom-buildings") as GeoJsonSourceWithData | undefined;
    const customBuildingsData = asFeatureCollection(customBuildingsSource?._data);
    if (customBuildingsData) {
      for (const feature of customBuildingsData.features) {
        rings.push(...extractPolygonRings(feature));
      }
    }

    return rings;
  }, []);

  const computeEffectiveClosedFeatures = useCallback(
    (roads: RoadCollection): Set<number> => {
      const buildingRings = collectBuildingRings();
      const buildingClosures = detectRoadClosuresFromBuildingRings(
        roads,
        buildingRings,
        roadFeatureBBoxesRef.current,
      );
      buildingClosedFeaturesRef.current = buildingClosures;
      return mergeClosedFeatureSets(manualClosedFeaturesRef.current, buildingClosures);
    },
    [collectBuildingRings],
  );

  const buildAdaptiveSamples = useCallback(
    (graph: Graph, closedFeatures: ReadonlySet<number>): { odPairs: ODPair[]; closureSeedNodes: number } => {
      const baseTripCount = Math.max(220, Math.min(520, Math.round(graph.edges.length / 25)));

      if (closedFeatures.size === 0) {
        return {
          odPairs: generateOD(graph, baseTripCount),
          closureSeedNodes: 0,
        };
      }

      const closureNodeIds = getClosedFeatureNodeIds(graph, closedFeatures);
      if (closureNodeIds.length === 0) {
        return {
          odPairs: generateOD(graph, baseTripCount),
          closureSeedNodes: 0,
        };
      }

      const closureScale = Math.min(1.5, 0.35 + closedFeatures.size * 0.08);
      const localTripCount = Math.max(120, Math.round(baseTripCount * closureScale));

      return {
        odPairs: [
          ...generateOD(graph, baseTripCount),
          ...generateODFromOrigins(graph, localTripCount, closureNodeIds),
        ],
        closureSeedNodes: closureNodeIds.length,
      };
    },
    [],
  );

  const runSimulation = useCallback(() => {
    console.log("[RECOMPUTE] Starting simulation...");
    const map = mapRef.current;
    const roads = roadsRef.current;
    const graph = graphRef.current;
    if (!map || !roads || !graph) {
      console.error("[RECOMPUTE] Missing map, roads, or graph");
      return;
    }

    console.log("[RECOMPUTE] Network stats:", {
      nodes: graph.nodes.size,
      edges: graph.edges.length,
      trips: odPairsRef.current.length,
      closed: manualClosedFeaturesRef.current.size + buildingClosedFeaturesRef.current.size,
      manualClosed: manualClosedFeaturesRef.current.size,
      buildingClosed: buildingClosedFeaturesRef.current.size,
    });

    setIsComputing(true);
    setShowResultsPanel(true);

    const effectiveClosedFeatures = computeEffectiveClosedFeatures(roads);
    const manualClosedCount = manualClosedFeaturesRef.current.size;
    const buildingClosedCount = buildingClosedFeaturesRef.current.size;

    const sampleSignature = Array.from(effectiveClosedFeatures)
      .sort((a, b) => a - b)
      .join(",");
    if (sampleSignature !== sampleSignatureRef.current) {
      const adaptiveSamples = buildAdaptiveSamples(graph, effectiveClosedFeatures);
      odPairsRef.current = adaptiveSamples.odPairs;
      closureSeedNodeCountRef.current = adaptiveSamples.closureSeedNodes;
      sampleSignatureRef.current = sampleSignature;
    }

    const start = performance.now();
    const result = assignTraffic(graph, effectiveClosedFeatures, odPairsRef.current, 2);
    const unreachableTrips = countDisconnectedTrips(
      graph,
      effectiveClosedFeatures,
      probePairsRef.current,
    );
    trafficEdgeMetricsRef.current = result.edgeMetrics;
    featureMetricsRef.current = result.featureMetrics;
    trafficRoutePoolRef.current = buildTrafficRoutePool(graph, odPairsRef.current, result.edgeMetrics);
    trafficParticlesRef.current = buildTrafficParticles(graph, trafficRoutePoolRef.current);
    trafficSimulationTimeRef.current = 0;
    nodeNextReleaseRef.current = new Map();
    startTrafficParticleAnimation();
    const updatedRoads = applyMetricsToRoads(roads, result.featureMetrics);
    updateRoadSourceData(map, updatedRoads);
    bringTrafficParticlesToFront(map);
    const runtimeMs = Math.round(performance.now() - start);
    const liveParticleCount = trafficParticlesRef.current.length;

    const newStats = {
      nodes: graph.nodes.size,
      directedEdges: graph.edges.length,
      trips: odPairsRef.current.length,
      probeTrips: probePairsRef.current.length,
      closed: effectiveClosedFeatures.size,
      closureSeedNodes: closureSeedNodeCountRef.current,
      runtimeMs,
      unreachable: unreachableTrips,
    };

    setStats(newStats);

    console.log("[RECOMPUTE] Simulation complete:", {
      runtime: `${runtimeMs}ms`,
      closedSegments: effectiveClosedFeatures.size,
      manualClosed: manualClosedCount,
      buildingClosed: buildingClosedCount,
      unreachableTrips,
      avgDelay: ((unreachableTrips / odPairsRef.current.length) * 100).toFixed(1) + "%",
    });

    setStatusText(
      `Heatmap updated in ${runtimeMs} ms (${effectiveClosedFeatures.size} closed = ${manualClosedCount} manual + ${buildingClosedCount} blocked by buildings, ${liveParticleCount} live vehicles).`,
    );
    setIsComputing(false);
  }, [
    bringTrafficParticlesToFront,
    buildAdaptiveSamples,
    computeEffectiveClosedFeatures,
    startTrafficParticleAnimation,
  ]);

  const scheduleSimulation = useCallback(
    (delayMs = 300) => {
      if (recomputeTimerRef.current !== null) {
        window.clearTimeout(recomputeTimerRef.current);
      }
      recomputeTimerRef.current = window.setTimeout(() => {
        recomputeTimerRef.current = null;
        runSimulation();
      }, delayMs);
    },
    [runSimulation],
  );

  const loadRoadNetwork = useCallback(
    async (map: maplibregl.Map) => {
      setStatusText("Loading downtown roads...");
      const response = await fetch("/data/roads_downtown.geojson");
      if (!response.ok) {
        throw new Error(`Unable to load roads_downtown.geojson (${response.status})`);
      }

      const raw = (await response.json()) as unknown;
      const roads = parseRoadCollection(raw);
      roadsRef.current = roads;
      roadFeatureBBoxesRef.current = computeLineFeatureBBoxes(roads);

      const graph = buildGraphFromGeoJSON(roads);
      graphRef.current = graph;

      const effectiveClosedFeatures = computeEffectiveClosedFeatures(roads);
      const adaptiveSamples = buildAdaptiveSamples(graph, effectiveClosedFeatures);
      odPairsRef.current = adaptiveSamples.odPairs;
      const stableProbeCount = Math.max(1200, Math.min(3200, Math.round(graph.nodes.size * 0.35)));
      probePairsRef.current = generateReachabilityProbe(graph, stableProbeCount);
      closureSeedNodeCountRef.current = adaptiveSamples.closureSeedNodes;
      sampleSignatureRef.current = "";

      const start = performance.now();
      const baseline = assignTraffic(graph, effectiveClosedFeatures, odPairsRef.current, 2);
      const unreachableTrips = countDisconnectedTrips(
        graph,
        effectiveClosedFeatures,
        probePairsRef.current,
      );
      trafficEdgeMetricsRef.current = baseline.edgeMetrics;
      featureMetricsRef.current = baseline.featureMetrics;
      trafficRoutePoolRef.current = buildTrafficRoutePool(graph, odPairsRef.current, baseline.edgeMetrics);
      trafficParticlesRef.current = buildTrafficParticles(graph, trafficRoutePoolRef.current);
      trafficSimulationTimeRef.current = 0;
      nodeNextReleaseRef.current = new Map();
      startTrafficParticleAnimation();
      const roadsWithMetrics = applyMetricsToRoads(roads, baseline.featureMetrics);
      addRoadLayers(map, roadsWithMetrics);
      bringTrafficParticlesToFront(map);
      const runtimeMs = Math.round(performance.now() - start);

      setStats({
        nodes: graph.nodes.size,
        directedEdges: graph.edges.length,
        trips: odPairsRef.current.length,
        probeTrips: probePairsRef.current.length,
        closed: effectiveClosedFeatures.size,
        closureSeedNodes: adaptiveSamples.closureSeedNodes,
        runtimeMs,
        unreachable: unreachableTrips,
      });
      setStatusText(
        `Loaded ${roads.features.length} roads, ${graph.nodes.size} nodes, ${odPairsRef.current.length} OD trips.`,
      );
    },
    [
      bringTrafficParticlesToFront,
      buildAdaptiveSamples,
      computeEffectiveClosedFeatures,
      startTrafficParticleAnimation,
    ],
  );

  useEffect(() => {
    if (!hasToken || !token) {
      setMapStyle(FALLBACK_STYLE_URL);
      return;
    }

    fetchAndConvertMapboxStyle("mapbox://styles/mapbox/streets-v11", token)
      .then((style) => setMapStyle(style))
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown style load error";
        setStatusText(`Mapbox style failed (${message}). Using fallback style.`);
        setMapStyle(FALLBACK_STYLE_URL);
      });
  }, [hasToken, token]);

  useEffect(() => {
    if (!mapStyle) {
      return;
    }

    const container = mapContainerRef.current;
    if (!container) {
      return;
    }

    const map = new maplibregl.Map({
      container,
      style: mapStyle as maplibregl.StyleSpecification | string,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      pitch: PITCH,
      bearing: BEARING,
      maxBounds: TORONTO_BOUNDS,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      canvasContextAttributes: {
        antialias: true,
      },
    });
   
    mapRef.current = map;
    const deckOverlay = new MapboxOverlay({ interleaved: false, layers: [] });
    deckOverlayRef.current = deckOverlay;
    map.addControl(deckOverlay);

    const handleStyleLoad = () => {
      ensurePolygonBuildingsLayer(map);
      ensureRectanglePreviewLayer(map);
      updatePolygonBuildingsSource(map, polygonBuildingsRef.current);
      updateScenegraphOverlay(polygonBuildingsRef.current);
      ensureTrafficParticleLayer(map);
      bringTrafficParticlesToFront(map);

      const layers = map.getStyle().layers || [];
      const labelLayerId = layers.find(
        (layer) => layer.type === "symbol" && layer.layout && layer.layout["text-field"],
      )?.id;

      if (!map.getLayer("add-3d-buildings")) {
        map.addLayer(
          {
            id: "add-3d-buildings",
            source: "composite",
            "source-layer": "building",
            filter: ["==", "extrude", "true"],
            type: "fill-extrusion",
            minzoom: 15,
            paint: {
              "fill-extrusion-color": "#aaa",
              "fill-extrusion-height": [
                "interpolate",
                ["linear"],
                ["zoom"],
                15,
                0,
                15.05,
                ["get", "height"],
              ],
              "fill-extrusion-base": [
                "interpolate",
                ["linear"],
                ["zoom"],
                15,
                0,
                15.05,
                ["get", "min_height"],
              ],
              "fill-extrusion-opacity": 0.6,
            },
          },
          labelLayerId,
        );
      }

      void refreshCustomBuildings();
      void loadRoadNetwork(map).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown road load error";
        setStatusText(`Road load failed: ${message}`);
      });

    };

    const handleMapClick = (event: maplibregl.MapMouseEvent) => {
      if (map.getLayer(POLYGON_BUILDINGS_LAYER_ID)) {
        const buildingFeatures = map.queryRenderedFeatures(event.point, {
          layers: [POLYGON_BUILDINGS_LAYER_ID],
        });
        if (buildingFeatures.length > 0) {
          const buildingId = extractBuildingId(buildingFeatures[0]);
          if (buildingId) {
            setPolygonBuildingSelection(map, buildingId);
          }
          return;
        }
      }

      if (selectedPolygonBuildingIdRef.current) {
        setPolygonBuildingSelection(map, null);
      }

      if (!map.getLayer(ROAD_LAYER_IDS.heat)) {
        return;
      }
      const tolerance = 8;
      const features = map.queryRenderedFeatures(
        [
          [event.point.x - tolerance, event.point.y - tolerance],
          [event.point.x + tolerance, event.point.y + tolerance],
        ],
        { layers: [ROAD_LAYER_IDS.heat] },
      ) as unknown as FeatureLike[];
      if (features.length === 0) {
        return;
      }

      let selectedFeature = features[0];
      let selectedDistance = featureDistance2InPixels(
        map,
        selectedFeature,
        event.point.x,
        event.point.y,
      );
      for (let idx = 1; idx < features.length; idx += 1) {
        const candidate = features[idx];
        const distance = featureDistance2InPixels(map, candidate, event.point.x, event.point.y);
        if (distance < selectedDistance) {
          selectedDistance = distance;
          selectedFeature = candidate;
        }
      }

      const featureIndex = extractFeatureIndex(selectedFeature);
      if (featureIndex === null) {
        return;
      }

      if (manualClosedFeaturesRef.current.has(featureIndex)) {
        manualClosedFeaturesRef.current.delete(featureIndex);
      } else {
        manualClosedFeaturesRef.current.add(featureIndex);
      }
      scheduleSimulation();
    };

    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      setCursorCoordinates({
        lng: Number(event.lngLat.lng.toFixed(6)),
        lat: Number(event.lngLat.lat.toFixed(6)),
      });

      if (map.getLayer(POLYGON_BUILDINGS_LAYER_ID)) {
        const buildingFeatures = map.queryRenderedFeatures(event.point, {
          layers: [POLYGON_BUILDINGS_LAYER_ID],
        });
        if (buildingFeatures.length > 0) {
          map.getCanvas().style.cursor = "pointer";
          return;
        }
      }

      if (!map.getLayer(ROAD_LAYER_IDS.heat)) {
        map.getCanvas().style.cursor = "";
        return;
      }
      const hovered = map.queryRenderedFeatures(event.point, {
        layers: [ROAD_LAYER_IDS.heat],
      });
      map.getCanvas().style.cursor = hovered.length > 0 ? "pointer" : "";
    };

    const handleMouseLeave = () => {
      setCursorCoordinates(null);
      map.getCanvas().style.cursor = "";
    };

    map.on("style.load", handleStyleLoad);
    map.on("click", handleMapClick);
    map.on("mousemove", handleMouseMove);
    map.on("mouseleave", handleMouseLeave);

    return () => {
      if (recomputeTimerRef.current !== null) {
        window.clearTimeout(recomputeTimerRef.current);
      }
      stopTrafficParticleAnimation();
      trafficParticlesRef.current = [];
      trafficRoutePoolRef.current = [];
      trafficEdgeMetricsRef.current = new Map();
      trafficSimulationTimeRef.current = 0;
      nodeNextReleaseRef.current = new Map();
      map.off("style.load", handleStyleLoad);
      map.off("click", handleMapClick);
      map.off("mousemove", handleMouseMove);
      map.off("mouseleave", handleMouseLeave);
      if (deckOverlayRef.current) {
        map.removeControl(deckOverlayRef.current);
        deckOverlayRef.current = null;
      }
      map.getCanvas().style.cursor = "";
      map.remove();
      mapRef.current = null;
    };
  }, [
    bringTrafficParticlesToFront,
    ensureRectanglePreviewLayer,
    ensurePolygonBuildingsLayer,
    ensureTrafficParticleLayer,
    loadRoadNetwork,
    mapStyle,
    refreshCustomBuildings,
    scheduleSimulation,
    setPolygonBuildingSelection,
    stopTrafficParticleAnimation,
    updatePolygonBuildingsSource,
    updateScenegraphOverlay,
  ]);

  const handleResetClosures = useCallback(() => {
    console.log("[RESET CLOSURES] Clearing all road closures...");
    if (manualClosedFeaturesRef.current.size === 0) {
      console.log("[RESET CLOSURES] No manual closures to reset");
      scheduleSimulation(0);
      return;
    }
    const closedCount = manualClosedFeaturesRef.current.size;
    manualClosedFeaturesRef.current.clear();
    console.log(`[RESET CLOSURES] Cleared ${closedCount} manual road closures`);
    scheduleSimulation(0);
  }, [scheduleSimulation]);

  const handleManualRecompute = useCallback(() => {
    console.log("[MANUAL RECOMPUTE] User triggered recompute");
    scheduleSimulation(0);
  }, [scheduleSimulation]);

  const handleSaveBuildings = useCallback(() => {
    const layout = buildLayoutExportFile(polygonBuildingsRef.current);
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const fileName = `toronto-layout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.json`;
    const fileBlob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const downloadUrl = URL.createObjectURL(fileBlob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);
    const countLabel = `${layout.buildings.length} building${layout.buildings.length === 1 ? "" : "s"}`;
    showTopPopup(`Saved ${countLabel} to file.`, "info");
    setStatusText(`Saved ${countLabel} to ${fileName}.`);
  }, [showTopPopup]);

  const handleLoadBuildingsClick = useCallback(() => {
    const input = layoutFileInputRef.current;
    if (!input) {
      return;
    }
    input.value = "";
    input.click();
  }, []);

  const handleLoadBuildingsFile = useCallback(
    async (event: ReactChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (!file) {
        return;
      }

      try {
        if (polygonBuildingsRef.current.size > 0) {
          const shouldReplace = window.confirm(
            "Loading a saved layout will replace your current placed buildings. Continue?",
          );
          if (!shouldReplace) {
            setStatusText("Load canceled.");
            return;
          }
        }

        const fileText = await file.text();
        const importedBuildings = parseLayoutFileBuildings(fileText);
        const nextBuildings = new Map<string, GeoJSON.Feature>();
        for (const imported of importedBuildings) {
          nextBuildings.set(imported.id, imported.feature);
        }

        polygonBuildingsRef.current = nextBuildings;
        setPolygonBuildings(nextBuildings);
        selectedPolygonBuildingIdRef.current = null;
        setSelectedPolygonBuildingId(null);

        const map = mapRef.current;
        if (map) {
          updatePolygonBuildingsSource(map, nextBuildings);
          updateScenegraphOverlay(nextBuildings);
        }

        scheduleSimulation(0);
        const countLabel = `${nextBuildings.size} building${nextBuildings.size === 1 ? "" : "s"}`;
        showTopPopup(`Loaded ${countLabel} from file.`, "info");
        setStatusText(`Loaded ${countLabel} from ${file.name}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to load layout file.";
        showTopPopup(`Load failed: ${message}`, "warning");
        setStatusText(`Load failed: ${message}`);
      } finally {
        input.value = "";
      }
    },
    [scheduleSimulation, showTopPopup, updatePolygonBuildingsSource, updateScenegraphOverlay],
  );

  const resolveTemplateFromDrag = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): BuildingTemplate => {
      const dragPayload = event.dataTransfer.getData(BUILDING_TEMPLATE_MIME);
      if (dragPayload) {
        try {
          const parsed = JSON.parse(dragPayload) as BuildingTemplate;
          if (parsed && typeof parsed.id === "string") {
            const template = getBuildingTemplate(parsed.id);
            draggingTemplateRef.current = template;
            return template;
          }
        } catch {
          // no-op
        }
      }
      const dragged = draggingTemplateRef.current;
      if (dragged) {
        return dragged;
      }
      return getBuildingTemplate(selectedTemplateIdRef.current);
    },
    [],
  );

  const getDropCenter = useCallback((event: ReactDragEvent<HTMLDivElement>): [number, number] | null => {
    const map = mapRef.current;
    if (!map) {
      return null;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const point: [number, number] = [event.clientX - bounds.left, event.clientY - bounds.top];
    const lngLat = map.unproject(point);
    return [lngLat.lng, lngLat.lat];
  }, []);

  const handleTemplateDragStart = useCallback((template: BuildingTemplate) => {
    setSelectedTemplateId(template.id);
    setSelectedModelType(template.modelType ?? "building");
    draggingTemplateRef.current = template;
    dragRotationOffsetDegRef.current = 0;
    setStatusText(`Drag ${template.label} onto the map.`);
  }, []);

  const cancelDragPreviewFrame = useCallback(() => {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
    dragPreviewPendingRef.current = null;
  }, []);

  const handleTemplateDragEnd = useCallback(() => {
    draggingTemplateRef.current = null;
    dragPreviewLatestRef.current = null;
    dragRotationOffsetDegRef.current = 0;
    cancelDragPreviewFrame();
    const map = mapRef.current;
    if (map) {
      clearRectanglePreview(map);
    }
  }, [cancelDragPreviewFrame, clearRectanglePreview]);

  const renderDragPreviewAt = useCallback(
    (center: [number, number], template: BuildingTemplate) => {
      const activeMap = mapRef.current;
      if (!activeMap) {
        return;
      }
      const check = evaluateTemplatePlacement(activeMap, center, template, {
        includeBasemap: false,
        rotationOffsetDeg: dragRotationOffsetDegRef.current,
      });
      updateRectanglePreview(activeMap, check.feature, check.overlapsUser || check.overlapsRoad);
    },
    [evaluateTemplatePlacement, updateRectanglePreview],
  );

  const handleMapDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const map = mapRef.current;
      const center = getDropCenter(event);
      if (!map || !center) {
        return;
      }
      const template = resolveTemplateFromDrag(event);
      dragPreviewLatestRef.current = { center, template };
      dragPreviewPendingRef.current = { center, template };
      if (dragPreviewFrameRef.current !== null) {
        return;
      }
      dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
        dragPreviewFrameRef.current = null;
        const pending = dragPreviewPendingRef.current;
        dragPreviewPendingRef.current = null;
        const activeMap = mapRef.current;
        if (!activeMap || !pending) {
          return;
        }
        renderDragPreviewAt(pending.center, pending.template);
      });
    },
    [getDropCenter, renderDragPreviewAt, resolveTemplateFromDrag],
  );

  const removePolygonBuildingById = useCallback(
    (buildingId: string, statusMessage?: string): boolean => {
      const map = mapRef.current;
      if (!map) {
        return false;
      }

      let removed = false;
      let removedSelected = false;
      setPolygonBuildings((prev) => {
        if (!prev.has(buildingId)) {
          return prev;
        }
        removed = true;
        removedSelected = selectedPolygonBuildingIdRef.current === buildingId;
        const next = new Map(prev);
        next.delete(buildingId);
        polygonBuildingsRef.current = next;
        updatePolygonBuildingsSource(map, next);
        updateScenegraphOverlay(next);
        return next;
      });

      if (removedSelected) {
        selectedPolygonBuildingIdRef.current = null;
        setSelectedPolygonBuildingId(null);
      }
      if (removed) {
        scheduleSimulation(0);
        if (statusMessage) {
          setStatusText(statusMessage);
        }
      }
      return removed;
    },
    [scheduleSimulation, updatePolygonBuildingsSource, updateScenegraphOverlay],
  );

  const handleMapDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      cancelDragPreviewFrame();
      const map = mapRef.current;
      const center = getDropCenter(event);
      if (!map || !center) {
        return;
      }
      const template = resolveTemplateFromDrag(event);
      const check = evaluateTemplatePlacement(map, center, template, {
        includeBasemap: false,
        rotationOffsetDeg: dragRotationOffsetDegRef.current,
      });
      clearRectanglePreview(map);
      draggingTemplateRef.current = null;
      dragPreviewLatestRef.current = null;
      dragRotationOffsetDegRef.current = 0;

      if (check.overlapsRoad) {
        showTopPopup("Invalid placement: you cannot place buildings on roads.", "warning");
        setStatusText("Placement blocked: building footprint intersects a road.");
        return;
      }

      if (check.overlapsUser) {
        showTopPopup("Invalid placement: overlaps an existing placed building.", "warning");
        setStatusText("Placement blocked: overlaps an existing building.");
        return;
      }

      const placedBuildingId = addPolygonBuilding(map, check.feature);
      setSelectedTemplateId(template.id);
      setSelectedModelType(template.modelType ?? "building");
      setStatusText(`Placing ${template.label}... validating overlap.`);
      scheduleSimulation(120);

      window.setTimeout(() => {
        const activeMap = mapRef.current;
        if (!activeMap) {
          return;
        }
        const placedFeature = polygonBuildingsRef.current.get(placedBuildingId);
        if (!placedFeature || placedFeature.geometry.type !== "Polygon") {
          return;
        }
        const overlapsBasemap = overlapsBasemapBuildings(
          activeMap,
          placedFeature as GeoJSON.Feature<GeoJSON.Polygon>,
          [
            POLYGON_BUILDINGS_LAYER_ID,
            POLYGON_BUILDINGS_OUTLINE_LAYER_ID,
            RECTANGLE_PREVIEW_FILL_LAYER_ID,
            RECTANGLE_PREVIEW_LINE_LAYER_ID,
          ],
        );
        if (overlapsBasemap) {
          showTopPopup("Invalid placement: overlaps a basemap building. Placement reverted.", "warning");
          removePolygonBuildingById(
            placedBuildingId,
            "Placement reverted: overlaps an existing basemap building.",
          );
          return;
        }
        setStatusText(
          `Placed ${template.label}. Use [ ] or R to rotate selected building, Backspace to delete.`,
        );
      }, 0);
    },
    [
      addPolygonBuilding,
      clearRectanglePreview,
      evaluateTemplatePlacement,
      getDropCenter,
      resolveTemplateFromDrag,
      scheduleSimulation,
      cancelDragPreviewFrame,
      removePolygonBuildingById,
      showTopPopup,
    ],
  );

  useEffect(() => () => {
    cancelDragPreviewFrame();
    if (topPopupTimerRef.current !== null) {
      window.clearTimeout(topPopupTimerRef.current);
      topPopupTimerRef.current = null;
    }
  }, [cancelDragPreviewFrame]);

  const handleDeleteSelectedBuilding = useCallback(() => {
    const selectedId = selectedPolygonBuildingIdRef.current;
    if (!selectedId) {
      return;
    }
    if (removePolygonBuildingById(selectedId, "Selected building deleted.")) {
      console.log("[BUILDING DELETE] Deleted selected building", { id: selectedId });
    }
  }, [removePolygonBuildingById]);

  const rotateSelectedBuilding = useCallback((deltaDeg: number) => {
    const map = mapRef.current;
    const selectedId = selectedPolygonBuildingIdRef.current;
    if (!map || !selectedId) {
      return;
    }

    setPolygonBuildings((prev) => {
      const selectedFeature = prev.get(selectedId);
      if (!selectedFeature || selectedFeature.geometry.type !== "Polygon") {
        return prev;
      }
      const next = new Map(prev);
      const properties = asPropertiesRecord(selectedFeature.properties);
      const rotated = transformRotate(selectedFeature as GeoJSON.Feature<GeoJSON.Polygon>, deltaDeg, {
        pivot: centroid(selectedFeature as GeoJSON.Feature<GeoJSON.Polygon>),
      }) as GeoJSON.Feature<GeoJSON.Polygon>;
      next.set(selectedId, {
        ...rotated,
        id: selectedId,
        properties: {
          ...properties,
          rotationDeg: normalizeRotationDegrees(readFeatureRotationDeg(properties) + deltaDeg),
          selected: true,
        },
      });
      polygonBuildingsRef.current = next;
      updatePolygonBuildingsSource(map, next);
      updateScenegraphOverlay(next);
      return next;
    });

    scheduleSimulation(0);
  }, [scheduleSimulation, updatePolygonBuildingsSource, updateScenegraphOverlay]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = target.tagName;
        const isEditableElement =
          target.isContentEditable ||
          tagName === "INPUT" ||
          tagName === "TEXTAREA" ||
          tagName === "SELECT";
        if (isEditableElement) {
          return;
        }
      }

      if (draggingTemplateRef.current && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        const delta = event.shiftKey ? 45 : 15;
        dragRotationOffsetDegRef.current = normalizeRotationDegrees(
          dragRotationOffsetDegRef.current + delta,
        );
        const latest = dragPreviewLatestRef.current;
        if (latest) {
          renderDragPreviewAt(latest.center, latest.template);
        }
        return;
      }

      if (!selectedPolygonBuildingIdRef.current) {
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        handleDeleteSelectedBuilding();
        return;
      }

      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        rotateSelectedBuilding(event.shiftKey ? ROTATION_STEP_LARGE_DEG : ROTATION_STEP_DEG);
        return;
      }

      if (event.key === "[") {
        event.preventDefault();
        rotateSelectedBuilding(-ROTATION_STEP_DEG);
        return;
      }

      if (event.key === "]") {
        event.preventDefault();
        rotateSelectedBuilding(ROTATION_STEP_DEG);
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [handleDeleteSelectedBuilding, renderDragPreviewAt, rotateSelectedBuilding]);

  return (
    <div className="app-shell">
      <div
        ref={mapContainerRef}
        className="map-container"
        onDragOver={handleMapDragOver}
        onDrop={handleMapDrop}
      />
      {topPopup ? (
        <div className={`top-popup top-popup-${topPopup.kind}`} role="alert" aria-live="assertive">
          {topPopup.message}
        </div>
      ) : null}
      <div className="layout-actions">
        <button type="button" onClick={handleSaveBuildings}>
          Save Buildings
        </button>
        <button type="button" onClick={handleLoadBuildingsClick}>
          Load Buildings
        </button>
      </div>
      <input
        ref={layoutFileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={handleLoadBuildingsFile}
      />

      <section className="controls">
        <h1>Toronto Reactive Traffic Heatmap</h1>
        <p className="status">{isComputing ? "Computing..." : statusText}</p>
        <div className="actions">
          <button type="button" onClick={handleManualRecompute}>
            Recompute
          </button>
          <button type="button" onClick={handleResetClosures}>
            Reset Closures
          </button>
        </div>
        <div className="stats">
          <div style={{ fontSize: "13px", color: "#374151", padding: "8px 0" }}>
            <strong style={{ color: "#111827" }}>Traffic Status:</strong> {stats.closed} road{stats.closed !== 1 ? 's' : ''} closed -{" "}
            {stats.unreachable > 0 ? (
              <span style={{ color: "#dc2626" }}>{((stats.unreachable / stats.trips) * 100).toFixed(1)}% trips affected</span>
            ) : (
              <span style={{ color: "#10b981" }}>minimal impact</span>
            )}
            {" "} - {stats.trips} simulated trips
          </div>
        </div>
        <p className="hint">
          Drag from the palette to place buildings. Click roads to toggle closures and click buildings to select.
        </p>
      </section>

      <section className="shape-panel">
        <BuildingPalette
          templates={BUILDING_TEMPLATES}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          onTemplateDragStart={handleTemplateDragStart}
          onTemplateDragEnd={handleTemplateDragEnd}
        />
      </section>

      <SimulationResultsPanel
        stats={stats}
        isVisible={showResultsPanel}
        onClose={() => setShowResultsPanel(false)}
        buildingCount={polygonBuildings.size}
        closedRoads={stats.closed}
        map={mapRef.current}
        centerPoint={(() => {
          // Calculate centroid of all placed buildings
          if (polygonBuildings.size === 0) return undefined;
          
          const buildings = Array.from(polygonBuildings.values());
          let totalLng = 0;
          let totalLat = 0;
          let pointCount = 0;
          
          buildings.forEach(feature => {
            if (feature.geometry.type === 'Polygon') {
              const coords = feature.geometry.coordinates[0]; // First ring
              coords.forEach((coord: number[]) => {
                totalLng += coord[0];
                totalLat += coord[1];
                pointCount++;
              });
            }
          });
          
          if (pointCount === 0) return undefined;
          
          const centroid: [number, number] = [totalLng / pointCount, totalLat / pointCount];
          console.log('[Nearby Buildings] Using construction site centroid:', centroid);
          console.log('[Nearby Buildings] Number of buildings:', polygonBuildings.size);
          
          return centroid;
        })()}
      />

      {cursorCoordinates && (
        <div className="coordinate-display">
          <div className="coordinate-label">Coordinates</div>
          <div className="coordinate-value">
            <span className="coord-lng">{cursorCoordinates.lng.toFixed(6)}</span>
            <span className="coord-separator">, </span>
            <span className="coord-lat">{cursorCoordinates.lat.toFixed(6)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

