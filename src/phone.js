/**
 * A buyer's phone number in the one shape a courier label wants: digits only, Indonesian
 * numbers as 08... - "+62 822-7000-7777", "6282270007777" and "82270007777" are all
 * 082270007777. A foreign number keeps its country code as +<digits>.
 *
 * Only digits are read, so whatever a paste carries between them - spaces, dots, the
 * non-breaking hyphens WhatsApp copies (17 Oct, DP-261017-00006WH) - cannot reach a label.
 * Self-contained: the order form runs this same function in the browser.
 *
 * Returns '' for nothing typed, null for something that is not a phone number.
 */
export function phoneForCourier(value) {
  var raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  var digits = raw.replace(/[^0-9]/g, '');
  var foreign = raw.charAt(0) === '+' && digits.indexOf('62') !== 0;
  if (foreign) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.indexOf('62') === 0) digits = '0' + digits.slice(2);
  else if (digits.charAt(0) === '8') digits = '0' + digits;
  return /^0[1-9][0-9]{7,11}$/.test(digits) ? digits : null;
}
