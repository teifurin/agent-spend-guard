import { createHash } from 'node:crypto';
import { assertSandboxUrl, type PayPalConfig } from './env.js';
import { Redactor } from './redact.js';

export interface PayPalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
}

/** An error response from PayPal. Carries the PayPal error name, debug_id and issues; never headers or tokens. */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly paypalName: string,
    readonly paypalMessage: string,
    readonly debugId: string | undefined,
    readonly details: PayPalErrorDetail[],
  ) {
    super(`PayPal ${status} ${paypalName}: ${paypalMessage}${debugId ? ` (debug_id ${debugId})` : ''}`);
    this.name = 'PayPalApiError';
  }
}

/**
 * The call to PayPal produced no answer this client can read: no connection, a body that could not be read, or a body
 * that is not JSON. The message is fixed text chosen here; nothing from the wire or from the underlying error reaches
 * it, so it can be logged and shown as is. The executor treats it as an open outcome, not as a rejection (D16).
 */
export class PayPalTransportError extends Error {
  constructor(readonly phase: 'connect' | 'read' | 'parse') {
    super(phase === 'connect' ? 'PayPal could not be reached' : phase === 'read' ? 'the answer from PayPal could not be read' : 'PayPal answered with a body that is not JSON');
    this.name = 'PayPalTransportError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  /** PayPal-Request-Id for idempotent creates. Build it with requestIdFor(). */
  requestId?: string;
  headers?: Record<string, string>;
}

export interface PayPalClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Receives one redacted line per request; silent by default. */
  log?: (line: string) => void;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Minimal PayPal REST client: OAuth token cache, idempotency header, redaction of credentials in errors,
 * and a hard sandbox-only guard on every URL it calls. Redirects are never followed (they could leave the sandbox
 * host), and every error that leaves this class is either a PayPalApiError with each field redacted or a
 * PayPalTransportError with fixed text: nothing read from the wire reaches a log or a page unredacted.
 */
export class PayPalClient {
  readonly redactor = new Redactor();
  private token: CachedToken | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly cfg: PayPalConfig,
    deps: PayPalClientDeps = {},
  ) {
    assertSandboxUrl(cfg.baseUrl);
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.redactor.add(cfg.clientSecret, cfg.clientId);
  }

  /** Returns a cached access token, fetching a new one when none is cached or it is about to expire. */
  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) return this.token.value;

    const url = `${this.cfg.baseUrl}/v1/oauth2/token`;
    assertSandboxUrl(url);
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    this.redactor.add(basic);
    const res = await this.connect(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      // ignoreCache=true asks PayPal for a newly minted token rather than the one it cached for this client. The cached
      // token keeps the permissions the app had when it was minted (up to nine hours), so a feature switched on
      // afterwards, such as "Save payment methods" (Vault), would otherwise stay invisible until it expires.
      body: 'grant_type=client_credentials&ignoreCache=true',
    });
    const text = await this.read(res);
    if (!res.ok) throw this.toError(res.status, text);
    const json = this.parse<{ access_token: string; expires_in: number; scope?: string }>(text);
    this.token = { value: json.access_token, expiresAt: this.now() + json.expires_in * 1000 };
    this.redactor.add(json.access_token);
    this.log(`POST /v1/oauth2/token -> ${res.status} (token expires in ${json.expires_in}s${describeVaultScope(json.scope)})`);
    return json.access_token;
  }

  /** Sends an authenticated JSON request to the sandbox. Retries once with a fresh token on 401. */
  async request<T = unknown>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<{ status: number; data: T }> {
    const url = `${this.cfg.baseUrl}${path}`;
    assertSandboxUrl(url);
    let res = await this.send(url, method, opts);
    if (res.status === 401) {
      this.token = undefined;
      res = await this.send(url, method, opts);
    }
    const text = await this.read(res);
    if (!res.ok) throw this.toError(res.status, text);
    this.log(`${method} ${path} -> ${res.status}`);
    return { status: res.status, data: (text ? this.parse<T>(text) : undefined) as T };
  }

  private async send(url: string, method: HttpMethod, opts: RequestOptions): Promise<Response> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      ...opts.headers,
    };
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    return this.connect(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  /** The transport boundary: a redirect is refused (it could leave the sandbox host, D1) and a thrown connection error becomes fixed text. */
  private async connect(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error' });
    } catch {
      throw new PayPalTransportError('connect');
    }
  }

  private async read(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      throw new PayPalTransportError('read');
    }
  }

  /** JSON.parse without its error message, which quotes a piece of the text it choked on. */
  private parse<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PayPalTransportError('parse');
    }
  }

  private toError(status: number, bodyText: string): PayPalApiError {
    const scrub = (s: string | undefined): string | undefined => (s === undefined ? undefined : this.redactor.redact(s));
    const j = parseJsonObject(bodyText);
    // Redact first, cut second: a registered value cut in half would no longer match as a whole.
    if (!j) return new PayPalApiError(status, 'UNKNOWN_ERROR', this.redactor.redact(bodyText).slice(0, 300), undefined, []);

    // Every string PayPal sent goes through the redactor, the error name and the debug id included: no field is trusted to be clean.
    const rawDetails = Array.isArray(j.details) ? (j.details as Array<Record<string, unknown>>) : [];
    return new PayPalApiError(
      status,
      scrub(str(j.name) ?? str(j.error)) ?? 'UNKNOWN_ERROR',
      scrub(str(j.message) ?? str(j.error_description)) ?? '',
      scrub(str(j.debug_id)),
      rawDetails.map((d) => ({ issue: scrub(str(d.issue)), description: scrub(str(d.description)), field: scrub(str(d.field)) })),
    );
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Whether the token carries the vault permission, which the sandbox app grants under "Save payment methods". PayPal
 * lists the granted permissions as scope URIs; the fake and the tests may omit the field.
 */
function describeVaultScope(scope: string | undefined): string {
  if (typeof scope !== 'string') return '';
  return scope.includes('vault') ? '; vault scope: yes' : '; vault scope: NO, enable "Save payment methods" on the sandbox app and restart';
}

/**
 * Deterministic PayPal-Request-Id: the same (scope, key) always maps to the same id, so a retried call
 * cannot create a second order, capture or refund. Scope keeps ids for different operations apart.
 */
export function requestIdFor(scope: string, key: string): string {
  const digest = createHash('sha256').update(`${scope}\n${key}`).digest('hex').slice(0, 32);
  return `asg-${scope}-${digest}`;
}
