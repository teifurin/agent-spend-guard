const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const BASIC = /Basic\s+[A-Za-z0-9+/=]+/g;
const ACCESS_TOKEN_FIELD = /("access_token"\s*:\s*")[^"]*(")/g;
const MIN_SECRET_LENGTH = 8; // shorter values would also wipe ordinary words

/** Scrubs credentials from text destined for logs, errors or the terminal. */
export class Redactor {
  private readonly secrets: string[] = [];

  /** Registers values that must never appear in output. Empty and very short values are ignored. */
  add(...values: Array<string | undefined>): void {
    for (const v of values) {
      if (v && v.length >= MIN_SECRET_LENGTH && !this.secrets.includes(v)) this.secrets.push(v);
    }
  }

  redact(text: string): string {
    let out = text
      .replace(BEARER, 'Bearer [REDACTED]')
      .replace(BASIC, 'Basic [REDACTED]')
      .replace(ACCESS_TOKEN_FIELD, '$1[REDACTED]$2');
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }
}

/** Shows only the first three and last two characters of an identifier, e.g. "jwg...42". */
export function mask(id: string): string {
  if (id.length <= 6) return '...';
  return `${id.slice(0, 3)}...${id.slice(-2)}`;
}
