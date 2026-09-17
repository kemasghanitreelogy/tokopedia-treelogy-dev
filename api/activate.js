import { findInvite, activateUser, touchLogin } from '../src/users.js';
import { renderActivate, renderActivateInvalid } from '../src/pages/activate.js';
import { dashboardError } from '../src/dashboard-page.js';
import { isConfigured, issueSession, sessionCookie, readFormBody, callerIp } from '../src/dashboard-auth.js';
import { recordActivity } from '../src/audit.js';

/**
 * Where an invitation link lands: https://<host>/api/activate?token=…
 *
 * GET shows the invitee who they are about to become and asks for a password twice.
 * POST sets it, inside one store transaction, and signs them straight in - a person who
 * has just typed a password twice should not be asked for it a third time.
 *
 * The token is only ever compared by hash, never stored, and a link that does not match
 * an open invitation gets the same page whether it is wrong, used or expired: the page
 * cannot be used to probe which addresses were invited.
 */

const PATH = '/api/activate';
const DASHBOARD = '/api/dashboard';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const send = (status, html, headers = {}) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.end(html);
  };

  if (!isConfigured()) {
    send(500, dashboardError('Dashboard belum dikonfigurasi', 'Kredensial login belum disetel, jadi akun tidak bisa diaktifkan.'));
    return;
  }

  if (req.method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    const invitee = await findInvite(token).catch(() => null);
    if (!invitee) { send(404, renderActivateInvalid({ dashboardUrl: DASHBOARD })); return; }
    send(200, renderActivate({ invitee, token, action: PATH }));
    return;
  }

  if (req.method !== 'POST') {
    send(405, dashboardError('Metode tidak didukung', 'Halaman ini hanya menerima GET dan POST.'));
    return;
  }

  let form;
  try {
    form = await readFormBody(req);
  } catch {
    send(400, dashboardError('Permintaan tidak valid', 'Data formulir terlalu besar.'));
    return;
  }
  const token = form.get('token') ?? '';
  const invitee = await findInvite(token).catch(() => null);
  if (!invitee) { send(404, renderActivateInvalid({ dashboardUrl: DASHBOARD })); return; }

  let user;
  try {
    user = await activateUser({ token, password: form.get('password'), confirm: form.get('confirm') });
  } catch (error) {
    // The same form again, with the reason next to it; the token is still good.
    send(400, renderActivate({ invitee, token, action: PATH, error: error.message }));
    return;
  }

  await touchLogin(user.id);
  await recordActivity({
    actor: user, ip: callerIp(req), menu: 'users', action: 'activate', verb: 'activate',
    target: user.email, summary: `${user.name} mengaktifkan akunnya dan membuat password`,
    changes: [{ field: 'status', from: 'invited', to: 'active' }],
  });
  console.log(`activate: ${user.email} aktif sebagai ${user.role}`);

  res.statusCode = 303;
  res.setHeader('Location', `${DASHBOARD}?done=${encodeURIComponent(`Selamat datang, ${user.name}. Akun Anda aktif.`)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', sessionCookie(issueSession(user)));
  res.end();
}
