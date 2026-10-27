import { describe, expect, it } from 'vitest';
import { PAYPAL_SANDBOX_BASE_URL, SandboxOnlyError, assertSandboxUrl, loadPayPalConfig } from '../../src/paypal/env.js';

const SECRET = 'EsuperSecretValue000000000000';
const good = { PAYPAL_ENV: 'SANDBOX', PAYPAL_CLIENT_ID: 'AclientIdValue000000000', PAYPAL_CLIENT_SECRET: SECRET };

describe('loadPayPalConfig', () => {
  it('accepts SANDBOX and hard-codes the sandbox base URL', () => {
    const cfg = loadPayPalConfig(good);
    expect(cfg.baseUrl).toBe('https://api-m.sandbox.paypal.com');
    expect(cfg.baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
    expect(cfg.clientId).toBe(good.PAYPAL_CLIENT_ID);
  });

  it.each(['LIVE', 'PRODUCTION', 'sandbox', 'Sandbox', ' SANDBOX', '', undefined])('refuses PAYPAL_ENV=%j', (value) => {
    expect(() => loadPayPalConfig({ ...good, PAYPAL_ENV: value })).toThrow(SandboxOnlyError);
  });

  it('refuses missing or blank credentials', () => {
    expect(() => loadPayPalConfig({ ...good, PAYPAL_CLIENT_ID: undefined })).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() => loadPayPalConfig({ ...good, PAYPAL_CLIENT_SECRET: '   ' })).toThrow(/PAYPAL_CLIENT_SECRET/);
  });

  it('never echoes values in its error messages', () => {
    for (const env of [{ ...good, PAYPAL_ENV: 'LIVE' }, { ...good, PAYPAL_CLIENT_SECRET: undefined }]) {
      let message = '';
      try {
        loadPayPalConfig(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(good.PAYPAL_CLIENT_ID);
      expect(message).not.toContain('LIVE');
    }
  });
});

describe('assertSandboxUrl', () => {
  it('accepts the sandbox host over https', () => {
    expect(() => assertSandboxUrl('https://api-m.sandbox.paypal.com/v1/oauth2/token')).not.toThrow();
  });

  it.each([
    'https://api-m.paypal.com/v2/checkout/orders',
    'https://api.paypal.com/v1/oauth2/token',
    'http://api-m.sandbox.paypal.com/v1/oauth2/token',
    'https://api-m.sandbox.paypal.com.evil.example/v1',
    'https://evil.example/api-m.sandbox.paypal.com',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertSandboxUrl(url)).toThrow(SandboxOnlyError);
  });
});
