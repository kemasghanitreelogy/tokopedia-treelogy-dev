import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';

/**
 * Sending one email, over SMTP, with nothing but the standard library.
 *
 * The only mail this application sends is an invitation - a link, a name, a deadline.
 * That is a few hundred bytes to one recipient, which is not a reason to add a mail
 * library and its dependency tree to a deploy that pulls, tests and restarts itself.
 * What is here is the SMTP conversation an invitation needs and nothing else: implicit
 * TLS on 465 (Gmail, Workspace), STARTTLS on 587, AUTH PLAIN, one recipient, a
 * multipart body carried as base64 so line length and dot-stuffing can never bite.
 *
 * Nothing here retries. A failed send is reported to the caller, who shows the operator
 * a "kirim ulang" button - the human is the retry loop, and they can see the error.
 */

const get = (key) => process.env[key] ?? readEnv(ENV_LOCAL_PATH)[key] ?? readEnv(ENV_PATH)[key] ?? '';

/**
 * @returns {{host: string, port: number, user: string, pass: string, from: string, secure: 'tls'|'starttls'|'none'}}
 *
 * `secure` follows the port unless SMTP_SECURE says otherwise: 465 is TLS from the first
 * byte, everything else starts in the clear and upgrades. `none` exists for the test
 * server and must never be set in production.
 */
export function loadSmtpConfig() {
  const port = Number(get('SMTP_PORT')) || 465;
  const explicit = get('SMTP_SECURE').toLowerCase();
  const secure = explicit === 'tls' || explicit === 'starttls' || explicit === 'none'
    ? explicit
    : port === 465 ? 'tls' : 'starttls';
  return {
    host: get('SMTP_HOST'),
    port,
    user: get('SMTP_USER'),
    pass: get('SMTP_PASS'),
    from: get('SMTP_FROM') || get('SMTP_USER'),
    secure,
  };
}

export const isSmtpConfigured = (config = loadSmtpConfig()) => Boolean(config.host && config.from);

/** "Nama <a@b.c>" → "a@b.c"; a bare address passes through. */
export const addressOf = (value) => {
  const match = /<([^>]+)>/.exec(String(value ?? ''));
  return (match ? match[1] : String(value ?? '')).trim();
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const isEmail = (value) => EMAIL.test(String(value ?? '').trim());

/** RFC 2047 for headers that may carry a name with accents; ASCII goes through untouched. */
const headerText = (text) =>
  /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;

/** base64 in 76-column lines: never a line starting with '.', never a line over the limit. */
const wrapped = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

/**
 * The message as it goes on the wire. Exported for the tests, which read it back from a
 * fake server and check that the link and the name survived the encoding.
 */
export function buildMessage({ from, to, subject, text, html }) {
  const boundary = `=_${crypto.randomBytes(12).toString('hex')}`;
  const domain = addressOf(from).split('@')[1] || os.hostname();
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapped(body)}\r\n`;
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', text)}${html ? part('text/html', html) : ''}--${boundary}--\r\n`;
}

/* --------------------------------------------------------------- the wire */

class SmtpError extends Error {
  constructor(step, reply) {
    super(`SMTP ${step}: ${reply.trim()}`);
    this.name = 'SmtpError';
    this.reply = reply;
  }
}

/**
 * A line reader over a socket that understands multi-line replies.
 *
 * "250-STARTTLS" continues, "250 OK" ends. The whole reply is handed back as one string
 * so the caller can both check the code and grep the capabilities.
 */
function reader(initial) {
  let buffer = '';
  let waiting = null;
  const lines = [];
  // A reply that lands before anyone asked for it - the greeting usually does - waits here.
  const ready = [];
  let socket = null;

  const settle = (method, value) => {
    if (!waiting) { ready.push({ method, value }); return; }
    const w = waiting;
    waiting = null;
    w[method](value);
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      lines.push(line);
      // "250-STARTTLS" continues; a space after the code is the final line of the reply.
      if (/^\d{3} /.test(line)) settle('resolve', lines.splice(0).join('\n'));
    }
  };
  const onError = (error) => settle('reject', error);
  const onClose = () => settle('reject', new Error('SMTP: koneksi ditutup'));

  const attach = (next) => {
    if (socket) { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); }
    socket = next;
    buffer = '';
    lines.length = 0;
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  };
  attach(initial);

  return {
    next: () => new Promise((resolve, reject) => {
      const early = ready.shift();
      if (early) return early.method === 'resolve' ? resolve(early.value) : reject(early.value);
      waiting = { resolve, reject };
    }),
    /** After STARTTLS the plain socket carries ciphertext; only the TLS socket is read from now on. */
    rebind: attach,
  };
}

/**
 * Connecting has its own deadline. A host that blocks outbound SMTP drops the SYN on the
 * floor and says nothing, and the kernel keeps retrying for two minutes - which is what a
 * browser spinner over a "Kirim undangan" click looked like. Ten seconds is generous for
 * a handshake and short enough that the operator reads an error instead of waiting.
 */
const openSocket = (config, timeoutMs) => new Promise((resolve, reject) => {
  const socket = config.secure === 'tls'
    ? tls.connect({ host: config.host, port: config.port, servername: config.host }, () => { socket.setTimeout(0); resolve(socket); })
    : net.connect({ host: config.host, port: config.port }, () => { socket.setTimeout(0); resolve(socket); });
  socket.once('error', reject);
  socket.setTimeout(timeoutMs, () => {
    socket.destroy(new Error(`SMTP: ${config.host}:${config.port} tidak tersambung dalam ${timeoutMs / 1000} detik - port SMTP keluar mungkin diblokir penyedia server`));
  });
});

const upgrade = (socket, config) => new Promise((resolve, reject) => {
  const secure = tls.connect({ socket, servername: config.host }, () => resolve(secure));
  secure.once('error', reject);
});

/**
 * @param {{to: string, subject: string, text: string, html?: string}} mail
 * @param {{config?: ReturnType<typeof loadSmtpConfig>, timeoutMs?: number}} [options]
 * @returns {Promise<{accepted: true, messageId?: string}>}
 * @throws on any refusal or network failure, with the server's reply in the message.
 */
export async function sendMail(mail, { config = loadSmtpConfig(), timeoutMs = 20_000, connectTimeoutMs = 10_000 } = {}) {
  if (!isSmtpConfigured(config)) throw new Error('SMTP belum dikonfigurasi (SMTP_HOST / SMTP_FROM)');
  if (!isEmail(mail.to)) throw new Error(`alamat tujuan tidak valid: ${mail.to}`);

  let socket = await openSocket(config, connectTimeoutMs);
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`SMTP: ${config.host} tidak menjawab dalam ${timeoutMs / 1000} detik`)));
  const io = reader(socket);

  const expect = (reply, codes, step) => {
    const code = reply.slice(0, 3);
    if (!codes.includes(code)) throw new SmtpError(step, reply);
    return reply;
  };
  const send = async (line, codes, step) => {
    socket.write(`${line}\r\n`);
    return expect(await io.next(), codes, step);
  };

  try {
    expect(await io.next(), ['220'], 'greeting');
    const me = os.hostname() || 'localhost';
    let ehlo = await send(`EHLO ${me}`, ['250'], 'EHLO');

    if (config.secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new Error(`SMTP: ${config.host} tidak menawarkan STARTTLS; kredensial tidak dikirim tanpa TLS`);
      await send('STARTTLS', ['220'], 'STARTTLS');
      const plain = socket;
      socket = await upgrade(plain, config);
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP: timeout')));
      io.rebind(socket);
      ehlo = await send(`EHLO ${me}`, ['250'], 'EHLO');
    }

    if (config.user) {
      const plain = Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString('base64');
      await send(`AUTH PLAIN ${plain}`, ['235'], 'AUTH');
    }

    await send(`MAIL FROM:<${addressOf(config.from)}>`, ['250'], 'MAIL FROM');
    await send(`RCPT TO:<${addressOf(mail.to)}>`, ['250', '251'], 'RCPT TO');
    await send('DATA', ['354'], 'DATA');
    const message = buildMessage({ from: config.from, ...mail });
    const accepted = await send(`${message}.`, ['250'], 'DATA');
    // The message is queued once DATA is acknowledged; the goodbye is a courtesy, and a
    // server that hangs up first is not a failure.
    await send('QUIT', ['221'], 'QUIT').catch(() => {});
    return { accepted: true, reply: accepted };
  } finally {
    socket.destroy();
  }
}
