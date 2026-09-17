import { ROLES } from '../users.js';

/**
 * The invitation as the invitee's inbox shows it.
 *
 * Plain HTML with inline styles and a text alternative: mail clients strip stylesheets,
 * dark-mode inverts backgrounds, and a link that also appears as bare text survives both.
 * No images, no tracking, nothing loaded from anywhere - the mail is the link.
 */

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const expiryText = (expiresAt) =>
  new Date(expiresAt * 1000).toLocaleString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
  }) + ' WIB';

/**
 * @param {{name: string, role: string, link: string, expiresAt: number, inviter: {name?: string, email: string}}} input
 * @returns {{subject: string, text: string, html: string}}
 */
export function invitationMail({ name, role, link, expiresAt, inviter }) {
  const roleLabel = ROLES[role]?.label ?? role;
  const roleDesc = ROLES[role]?.desc ?? '';
  const by = inviter?.name || inviter?.email || 'admin';
  const until = expiryText(expiresAt);
  const subject = `Undangan dashboard Treelogy untuk ${name}`;

  const text = [
    `Halo ${name},`,
    '',
    `${by} mengundang Anda ke dashboard omnichannel Treelogy sebagai ${roleLabel}.`,
    roleDesc,
    '',
    'Buka tautan ini untuk membuat password dan mengaktifkan akun Anda:',
    link,
    '',
    `Tautan berlaku sampai ${until}. Setelah itu minta undangan baru ke ${by}.`,
    '',
    'Kalau Anda tidak mengenal undangan ini, abaikan saja email ini; tidak ada akun yang dibuat sebelum tautannya dibuka.',
    '',
    'Treelogy Moringa',
  ].join('\n');

  const html = `<!doctype html><html lang="id"><body style="margin:0;padding:0;background:#f4f5f0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e2a24">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f0;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #e1e4da;border-radius:16px">
  <tr><td style="padding:32px 32px 8px">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="width:40px;height:40px;border-radius:11px;background:#526547;color:#ffffff;font-weight:700;font-size:18px;text-align:center;vertical-align:middle">T</td>
      <td style="padding-left:12px;font-size:13px;color:#57655a;letter-spacing:.06em;text-transform:uppercase">Treelogy &middot; Omnichannel</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 32px 0;font-size:22px;font-weight:600;letter-spacing:-.01em">Halo ${escape(name)},</td></tr>
  <tr><td style="padding:12px 32px 0;font-size:15px;line-height:1.6;color:#1e2a24">
    <b>${escape(by)}</b> mengundang Anda ke dashboard omnichannel Treelogy sebagai
    <span style="display:inline-block;padding:2px 8px;border-radius:6px;background:#eef2ea;color:#3c4c36;font-weight:600;font-size:13px">${escape(roleLabel)}</span>.
  </td></tr>
  ${roleDesc ? `<tr><td style="padding:8px 32px 0;font-size:13px;line-height:1.6;color:#57655a">${escape(roleDesc)}</td></tr>` : ''}
  <tr><td style="padding:24px 32px 0" align="left">
    <a href="${escape(link)}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:#526547;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">Buat password &amp; aktifkan akun</a>
  </td></tr>
  <tr><td style="padding:20px 32px 0;font-size:13px;line-height:1.6;color:#57655a">
    Tautan berlaku sampai <b style="color:#1e2a24">${escape(until)}</b>. Kalau tombolnya tidak bisa diklik, salin alamat ini ke browser:<br>
    <a href="${escape(link)}" style="color:#0e7a6b;word-break:break-all">${escape(link)}</a>
  </td></tr>
  <tr><td style="padding:24px 32px 32px;font-size:12px;line-height:1.6;color:#67776c;border-top:1px solid #e1e4da;margin-top:24px">
    Kalau Anda tidak mengenal undangan ini, abaikan email ini. Tidak ada akun yang dibuat sebelum tautannya dibuka.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
