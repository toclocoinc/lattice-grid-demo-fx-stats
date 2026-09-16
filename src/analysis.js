/**
 * Shaping the data. No statistics live in this file.
 *
 * The line this demo draws is the one the earthquake statistics edition draws:
 * this file turns what the API sends into rows the grid can hold, and
 * `src/statistics.js` asks the grid questions about them. A daily log return is
 * a change of units on two rates — the same kind of thing as the log10 of a
 * count — so it is prepared here and carried on the row as data. A mean, a
 * spread, a slope, a control limit, an autocorrelation or an outlier is never
 * worked out here, or anywhere else on the page: those come from the grid.
 *
 * It is imported by the page, by the snapshot builder and by the checks, and so
 * it touches no browser API.
 */

/** The pairs the demo reads, in the order they are shown. */
export const PAIRS = [
  { id: 'usd', symbol: 'USD', label: 'EUR/USD', name: 'US dollar' },
  { id: 'gbp', symbol: 'GBP', label: 'EUR/GBP', name: 'pound sterling' },
  { id: 'jpy', symbol: 'JPY', label: 'EUR/JPY', name: 'Japanese yen' },
  { id: 'chf', symbol: 'CHF', label: 'EUR/CHF', name: 'Swiss franc' },
];

/** The pair ids, for the places that only want the keys. */
export const PAIR_IDS = PAIRS.map((pair) => pair.id);

/** The symbols the API is asked for. */
export const SYMBOLS = PAIRS.map((pair) => pair.symbol);

/** The first day the euro had reference rates at all. */
export const FIRST_DAY = '1999-01-04';

/** The base currency every rate is quoted against. */
export const BASE = 'EUR';

/** How many trading days a volatility block covers. */
export const BLOCK_DAYS = 20;

/** The API, and the exact shape of the two calls this demo makes. */
export const API = {
  origin: 'https://api.frankfurter.dev',
  /** The whole history, one request. */
  history: (from = FIRST_DAY) =>
    `https://api.frankfurter.dev/v1/${from}..?base=${BASE}&symbols=${SYMBOLS.join(',')}`,
  /** A single day, used by the checks to prove the endpoint shape. */
  day: (date) => `https://api.frankfurter.dev/v1/${date}?base=${BASE}&symbols=${SYMBOLS.join(',')}`,
};

/**
 * Turn the API's answer — `{ base, rates: { 'YYYY-MM-DD': { USD, … } } }` — into
 * rows, newest last.
 *
 * One row per publication day, carrying the four rates. Returns are not set
 * here: a return needs the day before it, which {@link withReturns} supplies
 * once the whole ordered series is in hand.
 *
 * @param {object} payload the parsed API response
 * @returns {object[]} one row per day, oldest first
 */
export function parseRates(payload) {
  if (!payload || !payload.rates) return [];
  const days = Object.keys(payload.rates).sort();
  const rows = [];
  for (const day of days) {
    const quoted = payload.rates[day] || {};
    const row = { id: day, date: day, t: Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) };
    let complete = true;
    for (const pair of PAIRS) {
      const value = quoted[pair.symbol];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) complete = false;
      row[pair.id] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    /* A day missing one of the four is kept — the table should show what the
       ECB published — but its returns are left null so nothing is computed
       across a hole. */
    row.complete = complete;
    rows.push(row);
  }
  return rows;
}

/**
 * Add the daily log return for each pair, and the size of each return.
 *
 * `ln(rate today ÷ rate yesterday)`. Log rather than percentage because that is
 * what every statistic below is stated in: log returns add up over time, so a
 * fall and the rise that undoes it cancel exactly, and the distribution work
 * (normality, tails, autocorrelation, stationarity) is all stated for them.
 *
 * The first row has no day before it, so its returns are null, as is any day
 * whose predecessor is missing a rate. Nothing is carried forward or filled in.
 *
 * Rows are taken in the order given and returned in the same order; they must
 * be oldest first, which is how {@link parseRates} hands them over.
 *
 * @param {object[]} rows rows from {@link parseRates}, oldest first
 * @returns {object[]} the same rows, each with `<pair>Ret` and `<pair>Abs`
 */
export function withReturns(rows) {
  let previous = null;
  for (const row of rows) {
    for (const pair of PAIRS) {
      const now = row[pair.id];
      const before = previous ? previous[pair.id] : null;
      /* The day before's rate, carried as data. It is not a calculation: it is
         the number the API published the working day before, put on this row so
         the table's computed return column has both ends of the ratio to hand.
         The table's `<pair>Ret` column is computed by the GRID from this pair of
         fields; see `returnColumns` in `src/dashboard.js`. */
      row[`${pair.id}Prev`] = typeof before === 'number' ? before : null;
      const ret =
        typeof now === 'number' && typeof before === 'number' && now > 0 && before > 0
          ? Math.log(now / before)
          : null;
      /*
       * The same quantity again, as a field this time. Both are needed, and the
       * reason is a real limit rather than a convenience: a DERIVED source's
       * `groupBy` and `select: { of }` read the row's own field and cannot see a
       * column the grid computes — one null bucket and all-null aggregates come
       * back instead of a refusal. The volatility analysis is a derived grid, so
       * it needs the field. That is finding F-FX-5, and the verification checks
       * that the grid's computed column and this field agree exactly.
       */
      row[`${pair.id}Ret`] = ret;
      row[`${pair.id}Abs`] = ret == null ? null : Math.abs(ret);
    }
    previous = row;
  }
  return rows;
}

/** Parse and return-stamp in one call: the whole journey from payload to rows. */
export function rowsFrom(payload) {
  return withReturns(parseRates(payload));
}

/**
 * Re-stamp the returns over a store of rows keyed by date.
 *
 * The live top-up arrives as a handful of days on the end of a history that is
 * already in the table. A return needs the day before it, so the store is put
 * back in date order and walked once; only the days that actually changed are
 * handed back, which is what goes through the router.
 *
 * @param {Map<string, object>} store every row known, keyed by date
 * @param {string[]} touched the dates that arrived
 * @returns {object[]} the rows to upsert, oldest first
 */
export function restampReturns(store, touched) {
  const ordered = [...store.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const before = new Map(ordered.map((row) => [row.date, JSON.stringify(PAIR_IDS.map((id) => row[`${id}Ret`]))]));
  withReturns(ordered);
  const changed = [];
  const arrived = new Set(touched);
  for (const row of ordered) {
    const now = JSON.stringify(PAIR_IDS.map((id) => row[`${id}Ret`]));
    if (arrived.has(row.date) || before.get(row.date) !== now) changed.push(row);
  }
  return changed;
}

/**
 * The rows holding a usable return for one pair, oldest first, each carrying
 * the fields the statistics grids bind to.
 *
 * `seq` is a plain counter over the rows that survived, so the series is
 * ordered by its own position rather than by a calendar with weekends and
 * holidays in it. Every ordering the statistics ask for (`acf`, `adf`) names
 * this column, because a series read in the grid's screen sort is a series in
 * whatever order the reader last clicked a header.
 *
 * @param {object[]} rows the table's rows
 * @param {string} pairId which pair
 * @returns {object[]} `{ id, date, t, seq, rate, ret, abs }`
 */
export function returnRows(rows, pairId) {
  const ordered = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = [];
  let seq = 0;
  for (const row of ordered) {
    const ret = row[`${pairId}Ret`];
    if (typeof ret !== 'number' || !Number.isFinite(ret)) continue;
    out.push({
      id: row.date,
      date: row.date,
      t: row.t,
      seq: seq++,
      rate: row[pairId],
      ret,
      abs: Math.abs(ret),
      /* A weight column of ones, so `weightedQuantile` can be asked for a
         quantile the percentile kernels do not cover. See finding F-FX-2. */
      one: 1,
    });
  }
  return out;
}

/**
 * The rows holding a usable rate for one pair, oldest first, for the
 * stationarity test on the level.
 *
 * @param {object[]} rows the table's rows
 * @param {string} pairId which pair
 * @returns {object[]} `{ id, date, t, seq, rate }`
 */
export function levelRows(rows, pairId) {
  const ordered = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = [];
  let seq = 0;
  for (const row of ordered) {
    const rate = row[pairId];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) continue;
    out.push({ id: row.date, date: row.date, t: row.t, seq: seq++, rate });
  }
  return out;
}

/**
 * Stamp each return row with the block it belongs to.
 *
 * Blocks are non-overlapping runs of {@link BLOCK_DAYS} trading days, counted
 * from the oldest row in view. The block is carried on the row as a field
 * because a derived grid's `groupBy` reads the row's own field and cannot see a
 * column the grid computes.
 *
 * A trailing part block is dropped rather than charted: a spread measured over
 * four days sitting on a chart beside spreads measured over twenty is a point
 * that will break a rule for a reason that has nothing to do with the market.
 *
 * @param {object[]} rows rows from {@link returnRows}
 * @param {number} [size] days per block
 * @returns {object[]} the whole blocks, each row stamped with `block`
 */
export function blockRows(rows, size = BLOCK_DAYS) {
  const whole = Math.floor(rows.length / size) * size;
  const out = [];
  for (let i = 0; i < whole; i += 1) {
    const row = rows[i];
    out.push({ ...row, block: Math.floor(i / size) });
  }
  return out;
}

/**
 * The first and last date of each block, so a control chart's readings can be
 * named by the days they cover rather than by their position in an array.
 *
 * @param {object[]} rows rows from {@link blockRows}
 * @returns {Map<number, {from: string, to: string, n: number}>}
 */
export function blockSpans(rows) {
  const spans = new Map();
  for (const row of rows) {
    const span = spans.get(row.block);
    if (!span) spans.set(row.block, { from: row.date, to: row.date, n: 1 });
    else {
      if (row.date < span.from) span.from = row.date;
      if (row.date > span.to) span.to = row.date;
      span.n += 1;
    }
  }
  return spans;
}

/**
 * What happened on a given day, where the date is one the world remembers.
 *
 * A note is attached to an anomaly only where the date matches exactly. Nothing
 * here explains a move that merely happened in the same week or the same
 * month: a demo that invents a cause for an outlier is worse than one that
 * leaves it unlabelled, because the reader cannot tell the two apart.
 *
 * @type {Record<string, string>}
 */
export const KNOWN_DAYS = {
  '2000-09-22': 'The G7 central banks intervened jointly to buy the euro — the only such action of the euro era.',
  '2002-01-02': 'The first publication day after euro notes and coins entered circulation.',
  '2008-09-16': 'The day after Lehman Brothers filed; the dollar funding squeeze began in earnest.',
  '2008-09-29': 'The US House voted down the first bank rescue bill and the S&P 500 fell 9%.',
  '2008-10-06': 'The first of the October 2008 crash days, after a weekend of European bank rescues.',
  '2008-10-08': 'Six central banks cut rates together in an unscheduled coordinated move.',
  '2008-10-22': 'The height of the October 2008 carry-trade unwind.',
  '2008-10-24': 'The yen carry trade unwound violently; the yen had its largest one-day rise in decades.',
  '2008-10-28': 'The sharpest reversal of the 2008 crash, after the Federal Reserve extended its swap lines.',
  '2008-12-16': 'The Federal Reserve cut to the zero bound and said it would stay there.',
  '2008-12-17': 'The first publication day after the Federal Reserve cut to the zero bound.',
  '2008-12-18': 'Two days after the zero-bound cut; the dollar was still falling across the board.',
  '2008-12-19': 'The largest single-day move in EUR/USD in the euro’s history, in the week the Federal Reserve reached the zero bound.',
  '2009-03-12': 'The Swiss National Bank announced it would intervene to weaken the franc.',
  '2009-03-19': 'The day after the Federal Reserve announced its first large-scale Treasury purchases.',
  '2010-05-06': 'The US "flash crash", at the height of the Greek debt crisis.',
  '2010-05-07': 'The day after the flash crash, with the Greek rescue still unagreed.',
  '2011-03-18': 'The G7 intervened jointly to weaken the yen after the Tōhoku earthquake.',
  '2011-08-08': 'The first trading day after Standard & Poor’s downgraded the United States.',
  '2011-09-06': 'The Swiss National Bank announced the 1.20 floor under EUR/CHF.',
  '2011-11-01': 'Greece’s prime minister called a referendum on the bailout and risk assets fell hard.',
  '2013-02-26': 'The Italian general election produced no majority.',
  '2015-01-15': 'The Swiss National Bank abandoned the 1.20 floor without warning; EUR/CHF fell by about a fifth in a morning.',
  '2015-01-22': 'The European Central Bank announced quantitative easing.',
  '2015-01-23': 'The first full publication day after the ECB announced quantitative easing.',
  '2016-06-24': 'The result of the United Kingdom’s referendum on leaving the European Union.',
  '2016-06-27': 'The second trading day after the referendum result.',
  '2016-11-09': 'The result of the United States presidential election.',
  '2019-10-11': 'Sterling rose sharply after the British and Irish leaders said a Brexit deal was possible.',
  '2020-03-09': 'The oil price war opened the March 2020 crash.',
  '2020-03-12': 'The ECB meeting and the US travel ban: the worst single day of the March 2020 crash.',
  '2020-03-16': 'The Federal Reserve cut to zero on a Sunday and markets fell anyway.',
  '2020-03-19': 'The dollar funding squeeze peaked; the Federal Reserve opened swap lines to nine more central banks.',
  '2022-06-16': 'The Swiss National Bank raised rates unexpectedly and the franc surged.',
  '2022-09-26': 'The trading day after the United Kingdom’s "mini-budget"; sterling reached an all-time low against the dollar.',
  '2022-09-28': 'The Bank of England began emergency gilt purchases.',
  '2022-11-11': 'A US inflation reading far below expectations; the dollar had its worst day since 2015.',
  '2025-04-03': 'The day after the United States announced sweeping reciprocal tariffs.',
  '2025-04-09': 'The ninety-day tariff pause was announced mid-session.',
};

/** The note for a date, or null where this demo does not know one. */
export function noteFor(date) {
  return Object.prototype.hasOwnProperty.call(KNOWN_DAYS, date) ? KNOWN_DAYS[date] : null;
}

/** A pair by id. */
export function pairOf(id) {
  return PAIRS.find((pair) => pair.id === id) || PAIRS[0];
}
