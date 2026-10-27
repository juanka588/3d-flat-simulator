import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPrivateAddress, dnsAll } from './ssrf';
import { ProviderError } from './types';

/**
 * DNS-pinned `fetch` for pasted URLs (M6). The SSRF pre-check resolves a name, the runtime used to resolve it
 * AGAIN to connect, and a rebinding answer in that gap could point at 127.0.0.1 or 169.254.169.254. Here the
 * address the socket connects to IS the address that was vetted: the check runs inside the `lookup` hook of
 * the connection itself, on every address it will use. IP literals skip DNS (Node never calls `lookup` for
 * them), so they are checked up front. TLS still validates the certificate against the host name.
 *
 * https only, port 443 only, GET only, redirects are never followed (callers re-validate every hop).
 */

export interface PinnedFetchOptions {
  /** DNS: every address of a host (default `dns.lookup(all)`); tests inject a rebinding fake. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** The https client (tests); defaults to `https.request`. */
  request?: typeof httpsRequest;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

const notAllowed = (message: string, cause?: unknown) => new ProviderError('url_not_allowed', message, cause === undefined ? {} : { cause });

export function createPinnedFetch(opts: PinnedFetchOptions = {}): typeof fetch {
  const resolve = opts.lookup ?? dnsAll;
  const doRequest = opts.request ?? httpsRequest;

  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:') throw notAllowed(`only https URLs can be read (got ${url.protocol.replace(':', '')})`);
    if (url.port !== '' && url.port !== '443') throw notAllowed(`only port 443 is allowed (got ${url.port})`);
    if (url.username !== '' || url.password !== '') throw notAllowed('URLs with credentials are refused');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host)) throw notAllowed(`${url.hostname} is a private or loopback address`);

    let refused: ProviderError | undefined;
    const lookup = (hostname: string, options: { all?: boolean } | undefined, cb: LookupCallback) => {
      resolve(hostname).then(
        (addresses) => {
          const bad = addresses.find(isPrivateAddress);
          if (addresses.length === 0 || bad !== undefined) {
            refused = notAllowed(addresses.length === 0 ? `${hostname} does not resolve` : `${hostname} resolves to a private address (${bad})`);
            cb(Object.assign(new Error(refused.message), { code: 'EFLATPRIVATE' }));
            return;
          }
          if (options?.all) cb(null, addresses.map((address) => ({ address, family: isIP(address) })));
          else cb(null, addresses[0]!, isIP(addresses[0]!));
        },
        (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
      );
    };

    const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br' };
    for (const [k, v] of new Headers(init.headers)) headers[k] = v;

    return new Promise<Response>((resolveResponse, reject) => {
      const reqOptions: RequestOptions = {
        host,
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers,
        lookup: lookup as RequestOptions['lookup'],
        ...(isIP(host) ? {} : { servername: host }),
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      };
      const req = doRequest(reqOptions, (incoming) => {
        const status = incoming.statusCode ?? 502;
        const out = new Headers();
        for (const [k, v] of Object.entries(incoming.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) for (const x of v) out.append(k, x);
          else out.set(k, v);
        }
        let source: Readable = incoming;
        const encoding = (out.get('content-encoding') ?? '').toLowerCase();
        const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
        if (decoder) {
          source = incoming.pipe(decoder);
          incoming.on('error', (e) => decoder.destroy(e));
          out.delete('content-encoding');
          out.delete('content-length');
        }
        const nullBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
        if (nullBody) incoming.resume();
        const res = new Response(nullBody ? null : (Readable.toWeb(source) as ReadableStream<Uint8Array>), { status, statusText: incoming.statusMessage ?? '', headers: out });
        Object.defineProperty(res, 'url', { value: url.href });
        resolveResponse(res);
      });
      req.on('error', (e) => reject(refused ?? e));
      req.end();
    });
  }) as typeof fetch;
}
