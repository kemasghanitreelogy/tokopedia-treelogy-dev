import { svg, escape } from '../dashboard-page.js';
import { ROLES, MIN_PASSWORD_LENGTH } from '../users.js';

/**
 * The page an invitation link opens: the invitee chooses their own password.
 *
 * Standalone like the login page - there is no session yet, so there is no shell. The
 * form validates as the person types (length, match) and the server validates again on
 * submit; the browser's opinion is a courtesy, the server's is the rule.
 */

const head = (title) => `<!doctype html><html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} &mdash; Omnichannel Treelogy</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="mask-icon" href="/favicon.svg" color="#526547">
<meta name="theme-color" content="#141A17" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F4F5F0" media="(prefers-color-scheme: light)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#141A17;--panel:#1B2320;--panel-2:#222B27;--line:#2E3A34;--fg:#F1F3EE;--muted:#A7B3A6;--dim:#839187;
  --brand:#8FA97F;--fill-a:#5E7352;--fill-b:#3C4C36;--good:#6FBF8B;--warn:#E2B252;--bad:#E08573;
  --ease-out:cubic-bezier(.25,1,.5,1);--t-fast:160ms;--t-base:240ms;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#F4F5F0;--panel:#FFF;--panel-2:#F8F8F2;--line:#E1E4DA;--fg:#1E2A24;--muted:#57655A;
  --dim:#67776C;--brand:#526547;--fill-a:#526547;--fill-b:#3C4C36;--good:#2F7D4F;--warn:#8A5A12;--bad:#A8412E;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--fg);
  font:400 15px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:'';position:fixed;inset:-20% -20% auto;height:60vh;pointer-events:none;z-index:-1;
  background:radial-gradient(60% 70% at 50% 0%,color-mix(in srgb,var(--brand) 14%,transparent),transparent 70%)}
.card{width:100%;max-width:26rem;padding:2.25rem;background:var(--panel);border:1px solid var(--line);border-radius:18px;
  box-shadow:0 1px 2px rgba(0,0,0,.3),0 24px 48px -28px rgba(0,0,0,.55);animation:rise 420ms var(--ease-out) both}
.mark{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;margin:0 auto 1.1rem;color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.mark .ico{width:22px;height:22px}
h1{margin:0 0 .3rem;font-size:1.15rem;font-weight:600;text-align:center;letter-spacing:-.01em}
p.lead{margin:0 0 1.5rem;font-size:.86rem;color:var(--muted);text-align:center;line-height:1.55}
.you{display:flex;align-items:center;gap:.7rem;padding:.7rem .85rem;margin:0 0 1.25rem;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.you__av{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;flex:none;font-size:.72rem;font-weight:700;color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.you__t{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.you__n{font-weight:600;font-size:.9rem}
.you__e{font-size:.76rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.you__r{margin-left:auto;font-size:.66rem;letter-spacing:.06em;text-transform:uppercase;padding:.2rem .5rem;border-radius:6px;flex:none;
  color:var(--brand);background:color-mix(in srgb,var(--brand) 16%,transparent);font-weight:600}
label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:.4rem}
.pw{position:relative}
input{width:100%;font:inherit;font-size:.95rem;padding:.7rem 2.9rem .7rem .85rem;min-height:46px;border-radius:11px;
  border:1px solid var(--line);background:var(--panel-2);color:var(--fg);transition:border-color var(--t-fast)}
input:focus-visible{outline:2px solid var(--brand);outline-offset:1px;border-color:transparent}
input[aria-invalid="true"]{border-color:color-mix(in srgb,var(--bad) 60%,transparent)}
.toggle{position:absolute;right:.4rem;top:.35rem;width:38px;height:38px;border-radius:9px;border:0;background:transparent;color:var(--dim);
  display:grid;place-items:center;cursor:pointer}
.toggle:hover{color:var(--fg);background:var(--panel)}
.toggle:focus-visible{outline:2px solid var(--brand)}
.toggle .ico{width:18px;height:18px}
.gap{height:.9rem}
.meter{display:grid;grid-template-columns:repeat(4,1fr);gap:.3rem;margin:.55rem 0 0}
.meter i{height:4px;border-radius:2px;background:var(--line);transition:background var(--t-base)}
.meter[data-n="1"] i:nth-child(-n+1){background:var(--bad)}
.meter[data-n="2"] i:nth-child(-n+2){background:var(--warn)}
.meter[data-n="3"] i:nth-child(-n+3){background:var(--brand)}
.meter[data-n="4"] i{background:var(--good)}
.hint{margin:.35rem 0 0;font-size:.74rem;color:var(--dim);min-height:1.2em}
.hint.is-bad{color:var(--bad)} .hint.is-ok{color:var(--good)}
button.go{width:100%;margin-top:1.25rem;font:inherit;font-size:.95rem;font-weight:600;padding:.75rem;min-height:46px;border-radius:11px;
  cursor:pointer;color:#fff;border:1px solid transparent;background:linear-gradient(155deg,var(--fill-a),var(--fill-b));
  transition:filter var(--t-base) var(--ease-out),opacity var(--t-base)}
button.go:hover{filter:brightness(1.12)}
button.go:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
button.go:disabled{opacity:.45;cursor:not-allowed;filter:none}
.err{margin:0 0 1rem;padding:.6rem .8rem;border-radius:10px;font-size:.84rem;color:var(--bad);display:flex;gap:.5rem;align-items:flex-start;
  border:1px solid color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.err .ico{width:18px;height:18px;flex:none;margin-top:.1rem}
.foot{margin:1.2rem 0 0;font-size:.75rem;color:var(--dim);text-align:center;line-height:1.5}
.foot a{color:var(--muted)}
.dead{text-align:center}
.dead .mark{background:var(--panel-2);color:var(--warn);border:1px solid var(--line)}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>`;

/** The link is unknown, already used, or past its deadline. */
export function renderActivateInvalid({ dashboardUrl = '/api/dashboard' } = {}) {
  return `${head('Tautan tidak berlaku')}
<main class="card dead">
  <div class="mark">${svg('warn')}</div>
  <h1>Tautan undangan tidak berlaku</h1>
  <p class="lead">Tautan ini sudah dipakai atau kedaluwarsa.</p>
  <p class="foot"><a href="${escape(dashboardUrl)}">Masuk ke dashboard</a></p>
</main>
</body></html>`;
}

/**
 * @param {{invitee: {name: string, email: string, role: string}, token: string, error?: string|null, action?: string}} props
 */
export function renderActivate({ invitee, token, error = null, action = '/api/activate' }) {
  const initial = String(invitee.name || invitee.email).trim().split(/[\s@._-]+/).filter(Boolean);
  const av = (initial.length > 1 ? initial[0][0] + initial[initial.length - 1][0] : (initial[0] ?? '?').slice(0, 2)).toUpperCase();
  return `${head('Aktifkan akun')}
<main class="card">
  <div class="mark">${svg('key')}</div>
  <h1>Buat password Anda</h1>
  <div class="you" aria-label="Akun yang diaktifkan">
    <span class="you__av" aria-hidden="true">${escape(av)}</span>
    <span class="you__t"><span class="you__n">${escape(invitee.name)}</span><span class="you__e">${escape(invitee.email)}</span></span>
    <span class="you__r">${escape(ROLES[invitee.role]?.label ?? invitee.role)}</span>
  </div>
  ${error ? `<p class="err" role="alert">${svg('warn')}<span>${escape(error)}</span></p>` : ''}
  <form method="post" action="${escape(action)}" id="f" novalidate>
    <input type="hidden" name="token" value="${escape(token)}">
    <input type="hidden" name="email" value="${escape(invitee.email)}" autocomplete="username">
    <label for="password">Password baru</label>
    <div class="pw">
      <input id="password" name="password" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" autofocus
        placeholder="Minimal ${MIN_PASSWORD_LENGTH} karakter" aria-describedby="pw-hint">
      <button class="toggle" type="button" data-toggle="password" aria-label="Tampilkan password" aria-pressed="false">${svg('eye')}</button>
    </div>
    <div class="meter" id="meter" data-n="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <p class="hint" id="pw-hint"></p>
    <div class="gap"></div>
    <label for="confirm">Ulangi password</label>
    <div class="pw">
      <input id="confirm" name="confirm" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password"
        placeholder="Ketik sekali lagi" aria-describedby="cf-hint">
      <button class="toggle" type="button" data-toggle="confirm" aria-label="Tampilkan password" aria-pressed="false">${svg('eye')}</button>
    </div>
    <p class="hint" id="cf-hint"></p>
    <button class="go" type="submit" id="go">Aktifkan &amp; masuk</button>
  </form>
</main>
<script>
(function () {
  var pw = document.getElementById('password'), cf = document.getElementById('confirm');
  var meter = document.getElementById('meter'), pwHint = document.getElementById('pw-hint'), cfHint = document.getElementById('cf-hint');
  var go = document.getElementById('go'), MIN = ${MIN_PASSWORD_LENGTH};
  var eye = ${JSON.stringify(svg('eye'))}, eyeOff = ${JSON.stringify(svg('eyeOff'))};

  function strength(v) {
    if (!v) return 0;
    var n = 0;
    if (v.length >= MIN) n++;
    if (v.length >= 12) n++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v) || /\\d/.test(v)) n++;
    if (v.length >= 16 || /[^A-Za-z0-9]/.test(v)) n++;
    return Math.min(4, n);
  }
  function check() {
    var v = pw.value, c = cf.value;
    var n = strength(v);
    meter.setAttribute('data-n', String(n));
    var pwOk = v.length >= MIN;
    if (!v) { pwHint.textContent = ''; pwHint.className = 'hint'; }
    else if (!pwOk) { pwHint.textContent = 'Kurang ' + (MIN - v.length) + ' karakter lagi.'; pwHint.className = 'hint is-bad'; }
    else { pwHint.textContent = ['', 'Lemah', 'Cukup', 'Bagus', 'Kuat'][n]; pwHint.className = 'hint ' + (n >= 3 ? 'is-ok' : ''); }
    pw.setAttribute('aria-invalid', v && !pwOk ? 'true' : 'false');
    var match = c.length > 0 && c === v;
    if (!c) { cfHint.textContent = ''; cfHint.className = 'hint'; }
    else if (!match) { cfHint.textContent = 'Belum sama.'; cfHint.className = 'hint is-bad'; }
    else { cfHint.textContent = 'Sama.'; cfHint.className = 'hint is-ok'; }
    cf.setAttribute('aria-invalid', c && !match ? 'true' : 'false');
    go.disabled = !(pwOk && match);
  }
  pw.addEventListener('input', check); cf.addEventListener('input', check); check();

  document.querySelectorAll('[data-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var field = document.getElementById(btn.dataset.toggle);
      var show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      btn.innerHTML = show ? eyeOff : eye;
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
      field.focus();
    });
  });

  document.getElementById('f').addEventListener('submit', function () {
    go.disabled = true; go.textContent = 'Mengaktifkan…';
  });
})();
</script>
</body></html>`;
}
