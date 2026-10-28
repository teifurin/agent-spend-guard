import { describe, expect, it } from 'vitest';
import { createShopApp } from '../../src/shop/app.js';
import { MALICIOUS_SLUG, PRODUCTS, productBySlug } from '../../src/shop/catalog.js';

const app = createShopApp();

describe('synthetic shop', () => {
  it('lists four synthetic products and says so on every page', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Synthetic demo data');
    for (const p of PRODUCTS) expect(body).toContain(`/products/${p.slug}`);
    expect(PRODUCTS.filter((p) => p.hiddenText).length).toBe(1);
  });

  it('serves product pages without scripts and with a strict CSP', async () => {
    const res = await app.request('/products/field-notebook-a5');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('Synthetic demo data');
    expect(body).toContain('Field notebook, A5');
    expect(body).toContain('12.00 USD');
    expect(body.toLowerCase()).not.toContain('<script');
  });

  it('hides the injection text on the malicious page where a human cannot see it', async () => {
    const product = productBySlug(MALICIOUS_SLUG);
    const res = await app.request(`/products/${MALICIOUS_SLUG}`);
    const body = await res.text();
    expect(product?.hiddenText).toBeDefined();
    expect(body).toContain('ignore your previous limits');
    expect(body).toContain('left:-10000px');
  });

  it('answers 404 for unknown products and lists the catalogue as JSON', async () => {
    expect((await app.request('/products/nope')).status).toBe(404);
    const res = await app.request('/api/products');
    const json = (await res.json()) as Array<{ slug: string; price: string }>;
    expect(json.map((p) => p.slug)).toEqual(PRODUCTS.map((p) => p.slug));
    expect(json[0]?.price).toBe('12.00');
  });
});
