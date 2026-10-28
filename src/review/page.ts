/**
 * Fetches the product page a request points at, so the reviewer can see what the agent saw (hidden text included).
 *
 * `source_url` is agent-supplied, so this is the one place the guard makes an outbound request to a URL it did not
 * choose. Guards against server-side request forgery (THREAT_MODEL.md): only origins on an allowlist (by default the
 * synthetic shop), http/https only, no redirects followed, a byte cap, a time cap, HTML only. The page is data.
 */
import { extractText } from './text.js';

export interface PageText {
  url: string;
  /** Extracted text, hidden text included, cut at `maxChars`. */
  text: string;
  truncated: boolean;
}

export type PageProblem = 'invalid_url' | 'origin_not_allowed' | 'redirected' | 'http_error' | 'not_html' | 'unreachable' | 'timeout';

export type PageResult = { ok: true; page: PageText } | { ok: false; problem: PageProblem; detail?: string };

export type PageFetcher = (url: string, signal: AbortSignal) => Promise<PageResult>;

export interface PageFetcherOptions {
  /** Origins (scheme://host:port) the guard may fetch from. Anything else is refused without a request. */
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
  /** Stop reading after this many bytes. */
  maxBytes?: number;
  /** Keep at most this many characters of extracted text. */
  maxChars?: number;
  timeoutMs?: number;
}

export const PAGE_TEXT_MAX_CHARS = 4000;

/** Normalizes to `scheme://host[:port]`; returns null for anything that is not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function createPageFetcher(opts: PageFetcherOptions): PageFetcher {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const allowed = new Set(opts.allowedOrigins.map(originOf).filter((o): o is string => o !== null));
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxChars = opts.maxChars ?? PAGE_TEXT_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? 3000;

  return async (url, signal) => {
    const origin = originOf(url);
    if (origin === null) return { ok: false, problem: 'invalid_url' };
    if (!allowed.has(origin)) return { ok: false, problem: 'origin_not_allowed', detail: origin };

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: ac.signal, headers: { Accept: 'text/html' } });
      if (res.status >= 300 && res.status < 400) return { ok: false, problem: 'redirected' };
      if (!res.ok) return { ok: false, problem: 'http_error', detail: String(res.status) };
      const type = res.headers.get('content-type') ?? '';
      if (!/^text\/html\b/i.test(type)) return { ok: false, problem: 'not_html', detail: type.split(';')[0] };
      const { bytes, truncated } = await readCapped(res, maxBytes);
      const text = extractText(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      const cut = text.length > maxChars;
      return { ok: true, page: { url, text: cut ? text.slice(0, maxChars) : text, truncated: truncated || cut } };
    } catch (err) {
      if (signal.aborted) throw err; // the reviewer itself was cancelled; let the pipeline see it
      const timedOut = ac.signal.aborted;
      return { ok: false, problem: timedOut ? 'timeout' : 'unreachable', detail: timedOut ? undefined : err instanceof Error ? err.name : undefined };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, Math.max(0, room)));
      total += Math.max(0, room);
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}
