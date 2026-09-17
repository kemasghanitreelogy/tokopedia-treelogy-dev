import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail, buildMessage, loadSmtpConfig, isSmtpConfigured, addressOf, isEmail } from '../src/mail/smtp.js';
import { invitationMail } from '../src/mail/invitation.js';

/**
 * A fake SMTP server: enough of RFC 5321 to accept one message and hand it back.
 * `refuse` makes it answer a step with a 5xx so the client's error path is exercised.
 */
function fakeSmtp({ refuse = null } = {}) {
  const seen = { commands: [], data: '', auth: null };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.on('error', () => {});
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 2.0.0 queued as 42\r\n'); } else seen.data += `${line}\r\n`;
          continue;
        }
        seen.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (refuse && line.toUpperCase().startsWith(refuse)) { socket.write('550 5.1.1 no\r\n'); continue; }
        if (verb === 'EHLO') socket.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') { seen.auth = Buffer.from(line.split(' ')[2], 'base64').toString('utf8'); socket.write('235 2.7.0 ok\r\n'); }
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 ok\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('500 what\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      seen,
      config: { host: '127.0.0.1', port: server.address().port, user: 'kemas@treelogy.com', pass: 'app-pass', from: 'Treelogy <kemas@treelogy.com>', secure: 'none' },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const decodeParts = (raw) =>
  [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));

test('a message is delivered over the SMTP conversation Gmail expects, with AUTH PLAIN', async () => {
  const smtp = await fakeSmtp();
  try {
    const result = await sendMail({ to: 'dewi@treelogy.com', subject: 'Undangan', text: 'halo', html: '<b>halo</b>' }, { config: smtp.config });
    assert.equal(result.accepted, true);
    const verbs = smtp.seen.commands.map((c) => c.split(' ')[0].toUpperCase());
    assert.deepEqual(verbs, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    assert.equal(smtp.seen.auth, '\0kemas@treelogy.com\0app-pass');
    assert.ok(smtp.seen.commands.includes('MAIL FROM:<kemas@treelogy.com>'), 'alamat dipisahkan dari nama tampilan');
    assert.ok(smtp.seen.commands.includes('RCPT TO:<dewi@treelogy.com>'));
    assert.match(smtp.seen.data, /^From: Treelogy <kemas@treelogy.com>\r\n/);
    assert.match(smtp.seen.data, /Subject: Undangan\r\n/);
    assert.match(smtp.seen.data, /Content-Type: multipart\/alternative/);
    assert.deepEqual(decodeParts(smtp.seen.data), ['halo', '<b>halo</b>']);
  } finally {
    await smtp.close();
  }
});

test('a refused recipient surfaces the server reply and never hangs', async () => {
  const smtp = await fakeSmtp({ refuse: 'RCPT' });
  try {
    await assert.rejects(sendMail({ to: 'nobody@treelogy.com', subject: 's', text: 't' }, { config: smtp.config, timeoutMs: 2000 }), /RCPT TO: 550/);
  } finally {
    await smtp.close();
  }
});

test('the wire format survives non-ASCII subjects and long bodies', () => {
  const link = `https://api.treelogy-services.my.id/api/activate?token=${'x'.repeat(200)}`;
  const raw = buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'Undangan untuk Déwi', text: `buka ${link}`, html: `<a href="${link}">${link}</a>` });
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 998 && !line.startsWith('.'), 'baris aman untuk SMTP');
  assert.deepEqual(decodeParts(raw), [`buka ${link}`, `<a href="${link}">${link}</a>`]);
});

test('configuration follows the port unless told otherwise, and helpers parse addresses', () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: '' });
    delete process.env.SMTP_SECURE;
    let c = loadSmtpConfig();
    assert.equal(c.secure, 'tls');
    assert.equal(c.from, 'u', 'tanpa SMTP_FROM, alamat pengirim = SMTP_USER');
    assert.equal(isSmtpConfigured(c), true);
    process.env.SMTP_PORT = '587';
    assert.equal(loadSmtpConfig().secure, 'starttls');
    process.env.SMTP_SECURE = 'tls';
    assert.equal(loadSmtpConfig().secure, 'tls');
    assert.equal(isSmtpConfigured({ host: '', from: 'x' }), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
  assert.equal(addressOf('Nama <a@b.c>'), 'a@b.c');
  assert.equal(addressOf('a@b.c'), 'a@b.c');
  assert.equal(isEmail('dewi@treelogy.com'), true);
  assert.equal(isEmail('dewi@'), false);
});

test('the invitation mail carries the link, the name, the role and the deadline in both parts', () => {
  const mail = invitationMail({
    name: 'Dewi', role: 'operator', link: 'https://x.test/api/activate?token=abc', expiresAt: 1789000000,
    inviter: { name: 'Kemas', email: 'kemas@treelogy.com' },
  });
  assert.match(mail.subject, /Dewi/);
  for (const body of [mail.text, mail.html]) {
    assert.match(body, /https:\/\/x\.test\/api\/activate\?token=abc/);
    assert.match(body, /Kemas/);
    assert.match(body, /Operator/);
    assert.match(body, /WIB/);
  }
  assert.ok(!mail.html.includes('<script'));
  const hostile = invitationMail({ name: '<img src=x>', role: 'viewer', link: 'https://x', expiresAt: 1, inviter: { email: 'a@b' } });
  assert.ok(!hostile.html.includes('<img'), 'nama diloloskan, bukan disisipkan');
});
