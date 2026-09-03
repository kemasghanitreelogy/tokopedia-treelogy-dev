import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

/**
 * Minimal .env reader/writer that preserves comments, blank lines and key order.
 * Values are written unquoted unless they contain whitespace or a quote character.
 */

export function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readEnv(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'));
}

function format(value) {
  const str = String(value ?? '');
  return /[\s"'#]/.test(str) ? JSON.stringify(str) : str;
}

/**
 * Upsert `updates` into the .env at `path`. Existing keys are rewritten in place so
 * surrounding comments survive; new keys are appended under a generated section.
 */
export function updateEnv(path, updates) {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = original.split('\n');
  const pending = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${format(value)}`;
  });

  if (pending.size > 0) {
    while (rewritten.length > 0 && rewritten[rewritten.length - 1].trim() === '') {
      rewritten.pop();
    }
    rewritten.push('', `# --- written by tts cli on ${new Date().toISOString()} ---`);
    for (const [key, value] of pending) rewritten.push(`${key}=${format(value)}`);
  }

  const output = rewritten.join('\n').replace(/\n*$/, '\n');
  writeFileSync(path, output, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
}
