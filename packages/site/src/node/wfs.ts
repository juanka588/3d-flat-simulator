import { URLSearchParams } from 'node:url';
import { DEG, R_EARTH } from '../geo/enu';
import type { GetJson } from './geocode';

export const WFS_URL = 'https://data.geopf.fr/wfs/ows';

/** IGN BD TOPO V3 `batiment` features inside a square of half-side `radius` metres around (lat, lon). */
export async function fetchBuildings(getJson: GetJson, lat: number, lon: number, radius: number, count = 2000): Promise<unknown> {
  const dLat = radius / (R_EARTH * DEG);
  const dLon = radius / (Math.cos(lat * DEG) * R_EARTH * DEG);
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(7)).join(',');
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: 'BDTOPO_V3:batiment',
    OUTPUTFORMAT: 'application/json',
    BBOX: `${bbox},urn:ogc:def:crs:EPSG::4326`,
    COUNT: String(count),
  });
  const json = (await getJson(`${WFS_URL}?${params}`, 'wfs')) as { features?: unknown[] };
  if ((json.features?.length ?? 0) >= count) console.error(`warning: ${count} features returned, result may be truncated`);
  return json;
}
