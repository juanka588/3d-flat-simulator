import type { Pt } from '../geo/polygon';

/**
 * Contract for official cadastral data (step S9c: types only, no network code). Geometry only: parcels and building
 * footprints. Owner names, addresses of people and any other personal data are deliberately not modelled, so no
 * implementation can carry them through this interface.
 *
 * What the cadastre does NOT contain: interior plans. It gives the outer envelope of a building and the land around
 * it, used to check and fit a flat's traced envelope; the interior comes from the developer's plan (the M6 parser).
 */

/** A cadastral parcel. Coordinates are WGS84 `[lon, lat]` pairs (GeoJSON order), outer ring first, then holes. */
export interface CadastreParcel {
  /** Official parcel identifier (commune INSEE code + section + number), e.g. `92007000AB0021`. */
  id: string;
  /** Outer ring then inner rings, each closed or open, in `[lon, lat]`. */
  rings: Pt[][];
  /** Parcel area in square metres as published by the source, when given. */
  areaM2?: number;
}

/** A building footprint known to the cadastre, in WGS84 `[lon, lat]`. */
export interface CadastreBuilding {
  /** Identifier in the source dataset. */
  id: string;
  /** Id of the parcel it stands on, when the source links them. */
  parcelId?: string;
  /** Outer ring then inner rings (courtyards), in `[lon, lat]`. */
  rings: Pt[][];
}

/** Provenance a source must give for every response, so the licence and the date travel with the data. */
export interface CadastreAttribution {
  /** Human-readable source name, e.g. `IGN API Carto cadastre`. */
  source: string;
  /** Licence name and URL (Licence Ouverte Etalab 2.0 for the French open data). */
  licence: string;
  /** ISO date (`YYYY-MM-DD`) the data was fetched. */
  fetched: string;
}

/**
 * A provider of cadastral geometry. Implementations (to be chosen in a spike: IGN API Carto *cadastre*, or the
 * Géoplateforme WFS layer `CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle`) live in `@flat/site/node`; this
 * interface lives in the universal entry so that scene-side code can depend on it without any network access.
 */
export interface CadastreSource {
  /** The parcel containing a WGS84 point, or null when there is none. */
  parcelAt(lat: number, lon: number): Promise<CadastreParcel | null>;
  /** The building footprints standing on a parcel. */
  buildingsOnParcel(parcelId: string): Promise<CadastreBuilding[]>;
  /** Where the data of this source comes from. */
  readonly attribution: CadastreAttribution;
}
