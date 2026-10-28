/**
 * The synthetic shop: static product pages the demo agent browses. It runs on its own origin, serves no script,
 * and sends a strict Content-Security-Policy, because one of its pages is deliberately hostile.
 * Every page says so: "Synthetic demo data".
 */
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { formatAmount } from '../domain/money.js';
import { type Product, PRODUCTS, productBySlug } from './catalog.js';

const CSS = `
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #faf8f3; color: #222; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .banner { background: #fff3cd; border-bottom: 1px solid #e6d9a6; padding: 8px 16px; font-size: 14px; }
  .card { background: #fff; border: 1px solid #e3ded2; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .price { font-size: 24px; font-weight: 600; }
  .merchant { color: #666; }
  a { color: #0b57d0; }
  button { background: #0b57d0; color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; font-size: 16px; }
`;

const layout = (title: string, body: unknown) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Synthetic Shop</title>
<style>${raw(CSS)}</style>
</head>
<body>
<div class="banner"><strong>Synthetic demo data.</strong> This shop, its merchants, products and prices are made up for the agent-spend-guard demo. Nothing here is for sale.</div>
<main>${body}</main>
</body>
</html>`;

export function createShopApp(): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/', (c) =>
    c.html(
      layout(
        'Products',
        html`<h1>Synthetic Shop</h1>
<p>Four products from four made-up merchants. One of these pages is hostile on purpose.</p>
${PRODUCTS.map(
  (p) => html`<div class="card">
  <div class="merchant">${p.merchant}</div>
  <h2><a href="/products/${p.slug}">${p.name}</a></h2>
  <div class="price">${formatAmount(p.priceMinor)} ${p.currency}</div>
</div>`,
)}`,
      ),
    ),
  );

  app.get('/products/:slug', (c) => {
    const product = productBySlug(c.req.param('slug'));
    if (!product) return c.notFound();
    return c.html(layout(product.name, productPage(product)));
  });

  app.get('/api/products', (c) =>
    c.json(PRODUCTS.map((p) => ({ slug: p.slug, merchant: p.merchant, name: p.name, category: p.category, price: formatAmount(p.priceMinor), currency: p.currency, url: `/products/${p.slug}` }))),
  );

  return app;
}

function productPage(p: Product) {
  return html`<p><a href="/">← All products</a></p>
<div class="card">
  <div class="merchant">Sold by ${p.merchant} · category: ${p.category}</div>
  <h1>${p.name}</h1>
  <div class="price">${formatAmount(p.priceMinor)} ${p.currency}</div>
  <p>${p.blurb}</p>
  <button type="button" disabled>Add to cart (demo only)</button>
  ${p.hiddenText === undefined ? '' : html`<div style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;" aria-hidden="true">${p.hiddenText}</div>`}
</div>`;
}
