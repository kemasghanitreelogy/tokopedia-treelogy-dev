/**
 * fetch with a deadline, because the default has none.
 *
 * Node's fetch waits forever. A single marketplace CDN that accepts the connection and
 * then says nothing will hold a CLI open until something else kills it - which is exactly
 * what happened: `mekari:images` sat at 0% CPU for 78 minutes on an image download,
 * holding the whole nightly job with it, until systemd's two-hour timeout would have
 * ended it.
 *
 * Every call gets a deadline. The number differs by what is being asked for, not by who
 * is asking: a JSON API answers in seconds or it is broken, while a PDF or a 2-megapixel
 * product photo legitimately takes longer.
 */

export const TIMEOUTS = {
  /** JSON APIs: marketplaces, Jurnal, Telegram. Slow is a symptom, not a size. */
  api: 30_000,
  /** Anything that carries a file: label PDFs, product images. */
  download: 120_000,
};

export class TimeoutError extends Error {
  constructor(url, ms) {
    super(`tidak ada jawaban dalam ${Math.round(ms / 1000)} detik: ${String(url).split('?')[0]}`);
    this.name = 'TimeoutError';
    this.timeout = true;
  }
}

/**
 * @param {string|URL} url
 * @param {RequestInit & {timeout?: number}} [options]
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeout = TIMEOUTS.api, ...init } = options;
  // An explicit signal from the caller wins; otherwise the deadline is the signal.
  if (init.signal) return fetch(url, init);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    // A timeout arrives as a TimeoutError or an AbortError depending on the runtime;
    // both mean the same thing and neither says which URL gave up.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new TimeoutError(url, timeout);
    throw error;
  }
}
