import { describe, expect, it } from 'vitest';
import { Redactor, mask } from '../../src/paypal/redact.js';

describe('Redactor', () => {
  it('scrubs bearer and basic authorization values', () => {
    const r = new Redactor();
    expect(r.redact('Authorization: Bearer A21AAabc.def-ghi_jkl')).toBe('Authorization: Bearer [REDACTED]');
    expect(r.redact('Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')).toBe('Authorization: Basic [REDACTED]');
  });

  it('scrubs access_token fields in JSON bodies', () => {
    const r = new Redactor();
    expect(r.redact('{"access_token":"A21AAsecret","expires_in":3600}')).toBe('{"access_token":"[REDACTED]","expires_in":3600}');
  });

  it('scrubs registered secrets wherever they appear', () => {
    const r = new Redactor();
    r.add('EsuperSecretValue0000', 'AclientIdValue0000');
    expect(r.redact('id=AclientIdValue0000 secret=EsuperSecretValue0000 again EsuperSecretValue0000')).toBe(
      'id=[REDACTED] secret=[REDACTED] again [REDACTED]',
    );
  });

  it('ignores empty and very short values so ordinary words survive', () => {
    const r = new Redactor();
    r.add(undefined, '', 'ok', 'short');
    expect(r.redact('ok short fine')).toBe('ok short fine');
  });
});

describe('mask', () => {
  it('keeps only the edges of an identifier', () => {
    expect(mask('jwgvx42xyz')).toBe('jwg...yz');
    expect(mask('abc')).toBe('...');
  });
});
