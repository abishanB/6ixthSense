import { bearing, lineString, nearestPointOnLine, point } from "@turf/turf";

export type BuildingModelType =
  | "building"
  | "large-building"
  | "schoolhouse"
  | "construction-sign"
  | "restaurant";

type RoadFeatureProperties = {
  highway?: string | string[];
};

type RoadCollection = GeoJSON.FeatureCollection<GeoJSON.LineString, RoadFeatureProperties>;

const ROAD_CLASS_RANK: Readonly<Record<string, number>> = {
  motorway: 5,
  trunk: 4,
  primary: 3,
  secondary: 2,
  tertiary: 1,
};

function normalizeDegrees(value: number): number {
  let normalized = ((value % 360) + 360) % 360;
  if (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

function roadClassRank(highway: string | string[] | undefined): number {
  if (Array.isArray(highway)) {
    return Math.max(...highway.map((value) => ROAD_CLASS_RANK[value] ?? 0), 0);
  }
  if (typeof highway === "string") {
    return ROAD_CLASS_RANK[highway] ?? 0;
  }
  return 0;
}

export function snapToRoadOrientation(
  center: [number, number],
  roads: RoadCollection | null,
  radiusM = 90,
): number | null {
  if (!roads || roads.features.length === 0) {
    return null;
  }

  const dropPoint = point(center);
  let bestScore = Number.POSITIVE_INFINITY;
  let bestBearing: number | null = null;

  for (const road of roads.features) {
    if (!road.geometry || road.geometry.type !== "LineString") {
      continue;
    }
    const coords = road.geometry.coordinates;
    if (coords.length < 2) {
      continue;
    }

    const rank = roadClassRank(road.properties?.highway);
    for (let i = 0; i < coords.length - 1; i += 1) {
      const a = coords[i];
      const b = coords[i + 1];
      if (!a || !b) {
        continue;
      }

      const segment = lineString([a, b]);
      const snapped = nearestPointOnLine(segment, dropPoint, { units: "meters" });
      const distanceM = Number(snapped.properties?.dist ?? Number.POSITIVE_INFINITY);
      if (!Number.isFinite(distanceM) || distanceM > radiusM) {
        continue;
      }

      // Keep closest segment but slightly favor higher-ranked roads.
      const score = distanceM - rank * 3;
      if (score < bestScore) {
        bestScore = score;
        bestBearing = bearing(point(a), point(b));
      }
    }
  }

  return bestBearing === null ? null : normalizeDegrees(bestBearing);
}
