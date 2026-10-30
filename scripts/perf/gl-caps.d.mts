export const GL_CAPS_INIT: string;
export const GL_PRESETS: Record<string, Record<string, unknown>>;
export function installGlCaps(target: { addInitScript: (...args: any[]) => Promise<unknown> }, preset: string | Record<string, unknown>): Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
