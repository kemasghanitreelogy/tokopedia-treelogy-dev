const ESC = '\u001b[';
const color = (code, text) => `${ESC}${code}m${text}${ESC}0m`;

export const mask = (value, keep = 4) => {
  const str = String(value ?? '');
  if (!str) return '(empty)';
  if (str.length <= keep * 2) return `${'*'.repeat(str.length)} (len ${str.length})`;
  return `${str.slice(0, keep)}...${str.slice(-keep)} (len ${str.length})`;
};

export const ok = (text) => `  ${color(32, 'OK')}    ${text}`;
export const fail = (text) => `  ${color(31, 'FAIL')}  ${text}`;
export const warn = (text) => `  ${color(33, 'WARN')}  ${text}`;
export const info = (text) => `  ${color(36, '..')}    ${text}`;

export function humanTime(epochSeconds) {
  if (!epochSeconds) return 'unknown';
  const date = new Date(epochSeconds * 1000);
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  const rel = (value, unit) =>
    value >= 0 ? `in ${value}${unit}` : `${Math.abs(value)}${unit} ago`;

  if (Math.abs(minutes) < 60) return `${date.toISOString()} (${rel(minutes, 'm')})`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return `${date.toISOString()} (${rel(hours, 'h')})`;
  return `${date.toISOString()} (${rel(Math.round(hours / 24), 'd')})`;
}
