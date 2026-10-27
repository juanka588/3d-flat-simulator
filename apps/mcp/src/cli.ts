import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from './http';

/** Parses `--http`, `--port N`, `--host H` (also `--port=N`). Throws on bad input. */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): { http: boolean; port: number; host: string } {
  let http = false;
  let port = Number(env.FLAT_MCP_HTTP_PORT) || DEFAULT_HTTP_PORT;
  let host = env.FLAT_MCP_HTTP_HOST || DEFAULT_HTTP_HOST;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.split('=', 2) as [string, string | undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--http') http = true;
    else if (flag === '--port') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port expects an integer from 0 to 65535');
      port = n;
    } else if (flag === '--host') {
      const h = value();
      if (!h) throw new Error('--host expects a host name or address');
      host = h;
    } else throw new Error(`unknown argument ${arg}; usage: main.ts [--http [--port 8788] [--host 127.0.0.1]]`);
  }
  return { http, port, host };
}
