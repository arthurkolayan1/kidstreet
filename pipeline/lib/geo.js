// Minimal geometry helpers: point-in-polygon + centroid + bbox.
// Used to join point-sources (crimes, schools, stations, playgrounds) to ward
// polygons LOCALLY instead of issuing one live query per ward per source.

// Ray-casting point-in-polygon. `poly` is an array of [lng, lat] rings (outer ring only is fine for our use).
export function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// geometry: GeoJSON Polygon or MultiPolygon coordinates array
export function pointInGeometry(pt, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(pt, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInPolygonCoords(pt, poly));
  }
  return false;
}

function pointInPolygonCoords(pt, polygonCoords) {
  // polygonCoords[0] = outer ring, rest = holes
  if (!pointInRing(pt, polygonCoords[0])) return false;
  for (let i = 1; i < polygonCoords.length; i++) {
    if (pointInRing(pt, polygonCoords[i])) return false; // inside a hole
  }
  return true;
}

export function bboxOfGeometry(geometry) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const visit = (ring) => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  };
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(visit);
  if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach((p) => p.forEach(visit));
  return [minLng, minLat, maxLng, maxLat];
}

export function centroidOfGeometry(geometry) {
  // Area-weighted centroid of the outer ring(s) — good enough for ward-sized polygons.
  let cx = 0, cy = 0, area = 0;
  const processRing = (ring) => {
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      x += (x0 + x1) * cross;
      y += (y0 + y1) * cross;
    }
    return { a: a / 2, x, y };
  };
  const rings = geometry.type === 'Polygon'
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map((p) => p[0]);
  for (const ring of rings) {
    const { a, x, y } = processRing(ring);
    cx += x;
    cy += y;
    area += a;
  }
  if (area === 0) {
    // fallback: bbox center
    const [minLng, minLat, maxLng, maxLat] = bboxOfGeometry(geometry);
    return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  }
  return { lng: cx / (6 * area), lat: cy / (6 * area) };
}

// Haversine distance in meters
export function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
