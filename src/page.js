/** Server-rendered pages for the OAuth callback. No secrets are ever interpolated. */

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const shell = (title, mark, heading, lines) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#14171a; --muted:#5b6470;
          --line:rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#1a1d23; --fg:#e8eaed; --muted:#98a2b3; --line:#2a2f38; }
  }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:1.5rem;
         background:var(--bg); color:var(--fg);
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { width:100%; max-width:34rem; padding:2.5rem; border-radius:16px;
          background:var(--card); border:1px solid var(--line); text-align:center; }
  .mark { font-size:2.75rem; line-height:1; }
  h1 { font-size:1.3rem; margin:.85rem 0 .6rem; letter-spacing:-.01em; }
  p { margin:.3rem 0; color:var(--muted); font-size:.95rem; }
  dl { margin:1.5rem 0 0; padding-top:1.25rem; border-top:1px solid var(--line);
       display:grid; grid-template-columns:auto 1fr; gap:.5rem 1.25rem; text-align:left; }
  dt { color:var(--muted); font-size:.85rem; }
  dd { margin:0; font-size:.9rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
       overflow-wrap:anywhere; }
</style>
<div class="card"><div class="mark">${mark}</div><h1>${escape(heading)}</h1>${lines}</div>`;

function success(shop) {
  const details = shop
    ? `<dl>
      <dt>Shop</dt><dd>${escape(shop.name ?? shop.shop_name ?? 'unnamed')}</dd>
      <dt>Shop ID</dt><dd>${escape(shop.id ?? shop.shop_id ?? '-')}</dd>
      <dt>Region</dt><dd>${escape(shop.region ?? '-')}</dd>
    </dl>`
    : '<p>The shop list came back empty; check the terminal.</p>';

  return shell(
    'Authorized',
    '&#9989;',
    'Authorized',
    `<p>Tokens were issued and stored securely.</p>
     <p>You can close this tab &mdash; your terminal will pick them up automatically.</p>
     ${details}`,
  );
}

function error(heading, detail) {
  return shell('Authorization failed', '&#9888;&#65039;', heading, `<p>${detail}</p>`);
}

export const page = { success, error, escape };
