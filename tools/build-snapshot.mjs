/**
 * Save the whole published history to `data/snapshot/`, so the dashboard opens
 * at once and works with no network at all.
 *
 * The API answers the entire series — every working day since 4 January 1999 —
 * in a single request, so this makes exactly one call and writes the answer to
 * disk unchanged. Nothing is reshaped on the way in: the file is what the API
 * said, so a reader can hold it against the API and see that it is.
 *
 * Run it with `npm run snapshot`. A nightly workflow runs the same thing and
 * commits the result when it has changed. It is a development tool: nothing the
 * page loads imports it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, FIRST_DAY, parseRates } from '../src/analysis.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const url = API.history(FIRST_DAY);
const started = Date.now();
console.log(`Reading the whole history from ${url}`);

const response = await fetch(url);
if (!response.ok) {
  console.error(`The API answered ${response.status} ${response.statusText}.`);
  process.exit(1);
}
const text = await response.text();
const payload = JSON.parse(text);

const rows = parseRates(payload);
if (!rows.length) {
  console.error('The API answered with no rates at all; the saved copy is left as it was.');
  process.exit(1);
}

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
const incomplete = rows.filter((row) => !row.complete).length;

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  bytes: text.length,
  days: rows.length,
  incompleteDays: incomplete,
  base: payload.base,
  symbols: Object.keys(payload.rates[rows[rows.length - 1].date] || {}).sort(),
  oldest: rows[0].date,
  newest: rows[rows.length - 1].date,
  url,
  source: 'European Central Bank euro foreign exchange reference rates, served by Frankfurter',
  sourceUrl: 'https://frankfurter.dev',
  ecbUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  licence:
    'The reference rates are published by the European Central Bank and may be reused with the source acknowledged. Frankfurter is open source and free to use.',
};

await mkdir(outDir, { recursive: true });
/* Written exactly as the API sent it, pretty-printing and all left alone: the
   saved copy is the API's answer, not this tool's rendering of it. */
await writeFile(join(outDir, 'rates.json'), text);
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(
  `\nSaved ${meta.days} publication days (${(meta.bytes / 1024).toFixed(0)} KB) in ${seconds}s.`,
);
console.log(`Oldest ${meta.oldest}, newest ${meta.newest}, base ${meta.base}.`);
console.log(`Symbols: ${meta.symbols.join(', ')}.`);
if (incomplete) console.log(`${incomplete} day(s) are missing at least one of the four rates.`);
