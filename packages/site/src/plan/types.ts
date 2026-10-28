import type { CommandEnvelope } from '@flat/scene';
import type { Pt } from '../geo/polygon';

/**
 * Contract for turning a developer's plan (M6) into a draft Scene (step S9c: types only). The vision-LLM
 * orchestration (reading the PDF, proposing a trace) belongs in `apps/mcp`; this package holds the deterministic
 * half: scale, snapping and validation against the Scene schema.
 */

/** A page of a plan document and the scale that turns its pixels or PDF points into metres. */
export interface PlanSource {
  /** `pdf` pages are measured in PDF points (1/72 in); `raster` pages in pixels. */
  kind: 'pdf' | 'raster';
  /** Opaque reference to the document (a path or an asset id); this package never reads it. */
  ref: string;
  /** 1-based page number for `pdf`; 1 for a single raster. */
  page: number;
  /** Page size in the unit of `kind`. */
  width: number;
  height: number;
  /** Metres per page unit (from a printed scale bar or a known dimension). */
  metresPerUnit: number;
  /** How the scale was obtained, for audit: `scale-bar`, `known-dimension`, `printed-scale`, `manual`. */
  scaleSource: string;
}

/** A value read from the plan together with how sure the reader is, 0 (guess) to 1 (certain). */
export interface Traced<T> {
  value: T;
  confidence: number;
}

/** A wall centre line in plan metres (x right, y down), as read from the drawing. */
export interface TracedWall {
  id: string;
  start: Pt;
  end: Pt;
  thickness: Traced<number>;
  /** `load-bearing`, `partition`, `exterior`... as labelled on the plan, when it says. */
  kind?: string;
  confidence: number;
}

/** A door, window or other opening in a traced wall. */
export interface TracedOpening {
  id: string;
  wallId: string;
  /** Distance from the wall start to the opening centre, metres. */
  offset: number;
  width: Traced<number>;
  kind: 'door' | 'window' | 'passage';
  confidence: number;
}

/** A room outline with the label printed on the plan. */
export interface TracedRoom {
  id: string;
  polygon: Pt[];
  label?: string;
  /** Floor area printed on the plan (m2), kept to check the traced polygon against it. */
  printedAreaM2?: number;
  confidence: number;
}

/** Walls, openings and rooms of one plan page in plan metres. */
export interface PlanTrace {
  source: PlanSource;
  walls: TracedWall[];
  openings: TracedOpening[];
  rooms: TracedRoom[];
  /** Free-text problems found while tracing (unreadable scale, unclosed room...). */
  warnings: string[];
}

/**
 * Deterministic conversion of a trace into scene commands (scale already applied, coordinates snapped, result
 * validated against the Scene schema). Returns the envelopes in application order. This is the signature of the
 * future `traceToCommands` function (M6); there is no implementation yet, so only the type exists.
 */
export type TraceToCommands = (trace: PlanTrace) => CommandEnvelope[];
