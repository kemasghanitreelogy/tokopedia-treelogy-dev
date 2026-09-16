/**
 * Server-side paging for the dashboard's long lists.
 *
 * A thirty-day range is a couple of thousand orders. Rendering them all made a page of
 * two megabytes that the browser then filtered in JavaScript; the honest version is to
 * send one page at a time and keep every bit of state - filters, page, page size - in
 * the URL, so a page can be bookmarked, shared, reloaded and walked back through history.
 *
 * `page` is 1-based and clamped, so a stale link to page 40 of a list that now has
 * three pages shows the last page rather than an empty one.
 */

export const PER_PAGE_OPTIONS = [25, 50, 100, 250];
export const DEFAULT_PER_PAGE = 50;
export const PAGE_PARAM = 'page';
export const PER_PAGE_PARAM = 'per';

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** @param {URLSearchParams} params */
export function parsePaging(params, { perPage: fallback = DEFAULT_PER_PAGE } = {}) {
  const per = toInt(params.get(PER_PAGE_PARAM), fallback);
  return {
    page: toInt(params.get(PAGE_PARAM), 1),
    perPage: PER_PAGE_OPTIONS.includes(per) ? per : fallback,
  };
}

/**
 * @template T
 * @param {T[]} items
 * @returns {{items: T[], page: number, pages: number, total: number, from: number, to: number, perPage: number}}
 */
export function paginate(items, { page = 1, perPage = DEFAULT_PER_PAGE } = {}) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return {
    items: slice,
    page: current,
    pages,
    total,
    from: total ? start + 1 : 0,
    to: start + slice.length,
    perPage,
  };
}

/** The current query minus paging, as the base every page link is built on. */
export function withoutPaging(params) {
  const copy = new URLSearchParams(params);
  copy.delete(PAGE_PARAM);
  copy.delete(PER_PAGE_PARAM);
  return copy.toString();
}

/** A link to one page; page one and the default size are left implicit so links stay short. */
export function pageHref(baseQuery, page, perPage = DEFAULT_PER_PAGE) {
  const params = new URLSearchParams(baseQuery);
  if (page > 1) params.set(PAGE_PARAM, String(page));
  if (perPage !== DEFAULT_PER_PAGE) params.set(PER_PAGE_PARAM, String(perPage));
  return `?${params.toString()}`;
}

/**
 * Which page numbers to show: always the first and last, and a window around the
 * current one, with `null` where numbers are skipped. Never more than nine entries, so
 * the control has the same width on page 2 and page 200.
 */
export function pageWindow(page, pages, radius = 2) {
  if (pages <= 7 + 2 * (radius - 1)) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages]);
  for (let p = page - radius; p <= page + radius; p++) if (p >= 1 && p <= pages) set.add(p);
  // Keep the window the same size at the edges, so the control does not shrink there.
  if (page - radius <= 2) for (let p = 2; p <= 2 + 2 * radius; p++) set.add(p);
  if (page + radius >= pages - 1) for (let p = pages - 1 - 2 * radius; p < pages; p++) if (p >= 1) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push(null);
    out.push(sorted[i]);
  }
  return out;
}
