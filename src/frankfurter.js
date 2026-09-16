/**
 * Reading the rates.
 *
 * The European Central Bank publishes one set of reference rates each working
 * day at about 16:00 Central European Time. Frankfurter serves that series as
 * JSON, from the euro's first day to today, in a single request — so this demo
 * does something the other demos in the track cannot: it holds the *whole*
 * history, and it holds it as a saved copy that a nightly job keeps current.
 *
 * Two calls, and only two:
 *
 *   1  the saved copy in `data/snapshot/rates.json`, which is the API's own
 *      answer for the whole history, written to disk unchanged;
 *   2  a live top-up, `…/v1/<last saved day>..`, which is every day the ECB has
 *      published since the copy was taken.
 *
 * The top-up starts on the last day the copy already holds rather than the day
 * after it. A daily return needs the day before it, so asking for one day of
 * overlap means the first new day has a predecessor to be measured against
 * without the browser having to reason about which one it was. The router keys
 * on the date, so the overlapping day arrives as a revision of a row already
 * there rather than as a duplicate.
 *
 * Nothing here computes anything. Shaping is `src/analysis.js`.
 */

import { API, FIRST_DAY, rowsFrom } from './analysis.js';

/** How long a request is given before it is treated as unreachable. */
export const TIMEOUT_MS = 20000;

/** A fetch with a deadline, so a hanging API cannot hang the page. */
async function get(url, signalTimeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalTimeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the saved copy that ships with the demo.
 *
 * @returns {Promise<{rows: object[], meta: object, payload: object}>}
 */
export async function loadSnapshot() {
  const [payload, meta] = await Promise.all(
    ['rates', 'meta'].map(async (name) => {
      const response = await fetch(`./data/snapshot/${name}.json`);
      if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
      return response.json();
    }),
  );
  return { rows: rowsFrom(payload), meta: { ...meta, live: false }, payload };
}

/**
 * Fetch the whole history straight from the API.
 *
 * Used by the snapshot builder, and by the page when it is asked to ignore the
 * saved copy entirely (`?source=live`).
 *
 * @param {object} [options]
 * @param {string} [options.from] the first day to ask for
 * @returns {Promise<{rows: object[], payload: object, url: string}>}
 */
export async function fetchHistory({ from = FIRST_DAY } = {}) {
  const url = API.history(from);
  const payload = await get(url);
  return { rows: rowsFrom(payload), payload, url };
}

/**
 * Fetch the days published since the saved copy was taken.
 *
 * @param {string} lastSaved the newest date the saved copy holds, `YYYY-MM-DD`
 * @returns {Promise<{payload: object, url: string, days: string[]}>}
 */
export async function fetchSince(lastSaved) {
  const url = API.history(lastSaved);
  const payload = await get(url);
  const days = Object.keys((payload && payload.rates) || {}).sort();
  return { payload, url, days };
}

/**
 * The newest date in a set of rows.
 *
 * @param {object[]} rows
 * @returns {string|null}
 */
export function newestDate(rows) {
  let newest = null;
  for (const row of rows) if (!newest || row.date > newest) newest = row.date;
  return newest;
}
