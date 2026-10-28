import { URLSearchParams } from 'node:url';

export const GEOCODE_URL = 'https://data.geopf.fr/geocodage/search';

export type GetJson = (url: string, label: string) => Promise<unknown>;

export interface GeocodeResult {
  lat: number;
  lon: number;
  label: string;
  type: string;
  score: number;
}

/** Geoplateforme geocoder (Base Adresse Nationale): the best match for a free-text address. */
export async function geocode(query: string, getJson: GetJson): Promise<GeocodeResult> {
  const url = `${GEOCODE_URL}?${new URLSearchParams({ q: query, limit: '1' })}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await getJson(url, 'geocode')) as any;
  const f = json.features?.[0];
  if (!f) throw new Error(`No geocoding result for "${query}"`);
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties.label, type: f.properties.type, score: f.properties.score };
}
