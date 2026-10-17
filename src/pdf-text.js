/**
 * Text the PDF standard fonts can draw.
 *
 * Labels and invoices use Helvetica, which only knows WinAnsi (Windows-1252). One
 * character outside it - a non-breaking hyphen U+2011 pasted into an address on 17 Oct -
 * makes pdf-lib throw, and the throw took the whole print run down with it. Look-alikes
 * become their plain form, anything else that cannot be drawn is left out.
 */

const LOOK_ALIKES = [
  [/[‐‑‒−﹘﹣－]/g, '-'],
  [/[  -   　]/g, ' '],
  [/[′＇]/g, "'"],
  [/[″＂]/g, '"'],
  [/[​-‍⁠﻿­]/g, ''],
  [/[\t\r\v\f]/g, ' '],
];

// The 32 places where Windows-1252 differs from Latin-1, 0x80-0x9F.
const CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

const drawable = (ch) => {
  const code = ch.codePointAt(0);
  return ch === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || CP1252.has(ch);
};

/**
 * Look-alikes folded to their plain form, nothing else touched. WhatsApp copies a phone
 * number as "+62 822\u20117000\u20117777" - non-breaking hyphens - and that is how
 * one reached a label on 17 Oct.
 */
export function plainText(value) {
  let text = String(value ?? '');
  for (const [pattern, plain] of LOOK_ALIKES) text = text.replace(pattern, plain);
  return text;
}

export function printable(value) {
  return [...plainText(value)].filter(drawable).join('');
}

/** The same order with every string in it made printable; numbers and the rest untouched. */
export function printableDeep(value) {
  if (typeof value === 'string') return printable(value);
  if (Array.isArray(value)) return value.map(printableDeep);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printableDeep(v)]));
  }
  return value;
}
