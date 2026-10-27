import { readFileSync } from 'node:fs';

/** Parses a dotenv file (`KEY=value`, optional quotes, `#` comments). Missing or unreadable file = empty. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|FEED_URL|AUTH)/i;
const SECRET_QUERY = /([?&](?:token|key|apikey|api_key|secret|password|auth|access_token|signature)=)[^&\s"']+/gi;

export interface Secrets {
  /** A credential by variable name (process env wins over `.env.local`). Never log the result. */
  get(name: string): string | undefined;
  /** Replaces every known secret value, bearer token and secret-looking query parameter. */
  redact(text: string): string;
}

/** Credentials come only from the environment or the gitignored `apps/server/.env.local`, and are redacted in logs. */
export function createSecrets(env: Record<string, string | undefined>, fileValues: Record<string, string> = {}): Secrets {
  const merged: Record<string, string | undefined> = { ...fileValues, ...env };
  const values = Object.entries(merged)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 6)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  return {
    get: (name) => merged[name],
    redact(text) {
      let out = text;
      for (const v of values) out = out.split(v).join('[redacted]');
      return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]').replace(SECRET_QUERY, '$1[redacted]');
    },
  };
}
