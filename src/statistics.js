/**
 * The Statistics tab, and the verdict panel above it.
 *
 * Six questions are put to the same rows the table on the first tab is
 * showing, and every one of them is answered by the grid rather than by this
 * file:
 *
 *   1  What shape is a day's return? Is it normal, and how fat are the tails?
 *   2  Does volatility cluster — is the spread itself a stable process?
 *   3  Is a return predictable from the ones before it? Is its SIZE?
 *   4  Is the rate stationary? Is the return?
 *   5  How much of sterling's daily move is the dollar's?
 *   6  Which days do not belong, and what happened on them?
 *
 * Every number comes from one of three places, and each figure is shown beside
 * the call that produced it:
 *
 *   - a reduction, `grid.statistics.reduce(column, kernel)`;
 *   - a derived grid's own aggregate, `select: { sd: { of: 'ret', fn: 'stddev' } }`;
 *   - the statistics API proper: `interval`, `weightedQuantile`, `capability`,
 *     `acf`, `adf`, `regressionModel`, `correlation`, `anomalies`.
 *
 * Nothing here works out a mean, a spread, a slope, a control limit, an
 * autocorrelation or an outlier by hand. Where a figure this page wanted is not
 * reachable from the public API it is not quietly computed here: the page says
 * what is missing and the README records it as a finding.
 *
 * The one thing stated here that is not the grid's is a *model*, and it is
 * labelled as the model wherever it appears: a normal distribution with the
 * grid's own mean and standard deviation puts its 1% point at
 * `mean − 2.3263 σ`. That is the comparison the whole first analysis exists to
 * make, and it is a constant of the normal distribution, not a reading off this
 * data.
 *
 * Everything is rebuilt from the table's CURRENT rows, so changing the pair or
 * narrowing the dates moves every figure and rewrites every verdict.
 */

import {
  BLOCK_DAYS,
  PAIRS,
  blockRows,
  blockSpans,
  levelRows,
  noteFor,
  pairOf,
  returnRows,
} from './analysis.js';

/* The Jarque-Bera statistic above which a column is not plausibly normal: the
   0.95 point of a chi-squared with two degrees of freedom. The grid's own
   documentation states this cut, so this page uses the same one. */
const JARQUE_BERA_CUT = 5.99;

/* The 99% point of the standard normal. A constant of the model the returns
   are being compared against, not a figure read off the data. */
const NORMAL_Z99 = 2.3263478740408408;

/** How many lags the autocorrelation is taken out to. */
const MAX_LAG = 20;

/** How many anomalous days are listed. */
const TOP_ANOMALIES = 10;

/** The fewest returns an analysis will speak from. */
const MIN_RETURNS = 60;

/** Make an element with a class and optional text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A number to a fixed number of places, or a dash when there is not one. */
function num(value, places = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(places) : '-';
}

/** A log return said as a percentage, signed. */
function pct(value, places = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const shown = value * 100;
  return `${shown >= 0 ? '+' : ''}${shown.toFixed(places)}%`;
}

/** The same, without the sign: a size rather than a move. */
function size(value, places = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${(Math.abs(value) * 100).toFixed(places)}%`;
}

/** A whole number with thousands separators. */
function count(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the statistics panel into `host`.
 *
 * @param {object} options
 * @param {HTMLElement} options.host where the panel is drawn
 * @param {object} options.grid the rates table, whose current rows are the input
 * @param {Function} options.createHeadlessGrid the headless grid factory
 * @param {Function} options.createChart the charts module's factory
 * @param {string} options.pair which pair the host is showing
 * @param {Function} options.onPair called when the panel's pair buttons are used
 * @param {object[]} options.ranges the date ranges the host offers
 * @param {Function} options.onRange called when the panel's range buttons are used
 * @returns {object} `{ el, refresh, state, destroy }`
 */
export function buildStatistics({
  host,
  grid,
  createHeadlessGrid,
  createChart,
  pair,
  onPair,
  ranges,
  onRange,
}) {
  const root = el('div', 'stats');

  /* ---------------- the controls ---------------- */

  let pairId = pair || PAIRS[0].id;
  let rangeId = (ranges && ranges[0] && ranges[0].id) || 'all';

  const controls = el('div', 'stats-controls');
  controls.append(el('span', 'actions-label', 'Pair'));
  const pairButtons = new Map();
  for (const entry of PAIRS) {
    const button = el('button', 'action toggle', entry.label);
    button.type = 'button';
    button.dataset.pair = entry.id;
    button.addEventListener('click', () => {
      if (onPair) onPair(entry.id);
    });
    pairButtons.set(entry.id, button);
    controls.append(button);
  }

  controls.append(el('span', 'actions-gap'));
  controls.append(el('span', 'actions-label', 'Dates'));
  const rangeButtons = new Map();
  for (const entry of ranges || []) {
    const button = el('button', 'action toggle', entry.label);
    button.type = 'button';
    button.dataset.range = entry.id;
    button.addEventListener('click', () => {
      if (onRange) onRange(entry.id);
    });
    rangeButtons.set(entry.id, button);
    controls.append(button);
  }

  const basis = el('span', 'stats-basis');
  controls.append(basis);
  root.append(controls);

  /** Show which pair and which range are in force. */
  const paint = () => {
    for (const [id, button] of pairButtons) {
      const on = id === pairId;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const [id, button] of rangeButtons) {
      const on = id === rangeId;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  };

  /* ---------------- the verdict panel ---------------- */

  const verdictPanel = el('section', 'verdict');
  verdictPanel.setAttribute('aria-label', 'What the figures say');
  verdictPanel.append(el('h2', null, 'What the figures say'));
  const verdictList = el('ol', 'verdict-list');
  verdictPanel.append(verdictList);
  root.append(verdictPanel);

  /* ---------------- the six analyses ---------------- */

  const board = el('div', 'stats-board');
  root.append(board);
  host.append(root);

  /* Everything built on the last pass, torn down before the next one: a chart
     left bound to a grid that has gone is a leak and a wrong picture. */
  let built = { charts: [], grids: [] };
  const state = { analyses: {}, verdicts: [], rows: 0, error: null, passes: 0, pair: pairId };

  const own = (thing, kind) => {
    built[kind].push(thing);
    return thing;
  };

  /** A headless grid over prepared rows, owned by this pass. */
  const dataset = (rows, columns, extra) =>
    own(createHeadlessGrid({ rowKey: 'id', columns, rows, ...(extra || {}) }), 'grids');

  /** A headless grid derived from another, owned by this pass. */
  const derive = (from, source, columns) =>
    own(
      createHeadlessGrid({ source: { mode: 'derived', from, follow: 'all', ...source }, columns }),
      'grids',
    );

  /** Read a grid's rows out as plain objects, leaving any group rows behind. */
  const readRows = (source) => {
    const out = [];
    source.rows.forEach((row) => {
      if (!row || row.group || !row.data) return;
      out.push(row.data);
    });
    return out;
  };

  /**
   * Draw one chart into a card, or say why it could not be drawn.
   *
   * A chart that throws must not take the rest of the page down with it: five
   * working analyses beside one honest failure is a better page than a blank
   * one.
   */
  const chartInto = (container, spec, label) => {
    try {
      const chart = createChart({ container, ...spec });
      built.charts.push(chart);
      return chart;
    } catch (error) {
      container.append(el('p', 'chart-error', `${label} could not be drawn: ${error.message}`));
      console.error('[fx statistics]', label, error);
      return null;
    }
  };

  /** One analysis card: a heading, a sentence, its charts and its figures. */
  const card = (id, title, lede) => {
    const section = el('section', 'stats-card');
    section.dataset.analysis = id;
    section.append(el('h3', null, title));
    if (lede) section.append(el('p', 'stats-lede', lede));
    const plots = el('div', 'stats-plots');
    section.append(plots);
    const figures = el('dl', 'stats-figures');
    section.append(figures);
    board.append(section);
    return {
      section,
      plots,
      plot(height) {
        const box = el('div', 'stats-plot');
        if (height) box.style.height = `${height}px`;
        plots.append(box);
        return box;
      },
      figure(label, value, source) {
        figures.append(el('dt', null, label));
        const dd = el('dd', null, String(value));
        if (source) {
          const note = el('code', 'stats-source', source);
          dd.append(document.createTextNode(' '));
          dd.append(note);
        }
        figures.append(dd);
      },
      list() {
        const ul = el('ul', 'stats-list');
        section.append(ul);
        return ul;
      },
      note(text) {
        section.append(el('p', 'stats-note', text));
      },
    };
  };

  /** The columns every per-pair return grid carries. */
  const RETURN_COLUMNS = [
    { id: 'seq', field: 'seq', title: 'Position', type: 'number' },
    { id: 'date', field: 'date', title: 'Date' },
    { id: 'rate', field: 'rate', title: 'Rate', type: 'number' },
    { id: 'ret', field: 'ret', title: 'Log return', type: 'number' },
    { id: 'abs', field: 'abs', title: 'Size of return', type: 'number' },
    { id: 'one', field: 'one', title: 'Weight', type: 'number' },
  ];

  /* ------------------------------------------------------------------ */
  /* 1. What shape is a day's return?                                    */
  /* ------------------------------------------------------------------ */

  function distribution(input, verdicts) {
    const entry = pairOf(pairId);
    const box = card(
      'distribution',
      `What shape is a day in ${entry.label}?`,
      'Nearly every textbook model of a currency starts by assuming the daily return is normal. ' +
        'This is the cheapest test of that assumption there is: draw the returns, put a density ' +
        'curve over them, plot them against a normal, and ask Jarque-Bera what it thinks. ' +
        'What matters is not the middle, which always looks fine, but the tails — because the ' +
        'tails are where the money is lost.',
    );

    const rows = input.returns;
    if (rows.length < MIN_RETURNS) {
      box.note(`Only ${count(rows.length)} days with a return in view: too few to read a shape from.`);
      return { ok: false, reason: 'too few returns' };
    }

    const source = dataset(rows, RETURN_COLUMNS);
    const S = source.statistics;

    const interval = S.interval('ret', { kind: 'mean', confidence: 0.95 });
    const sd = S.reduce('ret', 'stddev');
    const skew = S.reduce('ret', 'skewness');
    const kurt = S.reduce('ret', 'kurtosis');
    const jb = S.reduce('ret', 'jarqueBera');
    const median = S.reduce('ret', 'median');
    /*
     * The 1% and 99% points. The percentile kernels run p25, p75, p90, p95 and
     * p99, so the upper tail has a kernel and the lower one does not.
     * `weightedQuantile` takes any quantile, so a column of ones is carried on
     * the row and the grid is asked for the quantile it will answer. That is
     * finding F-FX-2: the two calls use different interpolations, and this page
     * uses one of them for both tails so the pair are comparable.
     */
    const q01 = S.weightedQuantile('ret', 'one', 0.01);
    const q99 = S.weightedQuantile('ret', 'one', 0.99);

    /* The model: a normal with the grid's own mean and standard deviation. */
    const mean = interval ? interval.mean : null;
    const normalLow = typeof sd === 'number' && typeof mean === 'number' ? mean - NORMAL_Z99 * sd : null;
    const normalHigh = typeof sd === 'number' && typeof mean === 'number' ? mean + NORMAL_Z99 * sd : null;
    const tailRatio =
      normalLow && normalHigh && q01 != null && q99 != null
        ? (Math.abs(q01) + Math.abs(q99)) / (Math.abs(normalLow) + Math.abs(normalHigh))
        : null;

    chartInto(
      box.plot(220),
      {
        grid: source,
        type: 'histogram',
        /* The column being binned, named as the measure. A histogram counts for
           itself; giving it a category on `x` and a count on `y` would chart one
           bar per distinct value instead, which is a different chart. */
        y: 'ret',
        buckets: 60,
        /* The grid's kernel density estimate over the same column: a curve with
           no bin edges, so what is in the data and what is in the binning can be
           told apart. */
        curve: true,
        title: `${entry.label}: daily log returns, with a density curve`,
        axis: { x: 'Daily log return', y: 'Days' },
        legend: false,
      },
      'The return histogram',
    );

    chartInto(
      box.plot(220),
      {
        grid: source,
        type: 'qq',
        y: 'ret',
        title: `${entry.label}: returns against a normal distribution`,
        axis: { x: 'Normal quantile', y: 'Log return' },
        legend: false,
      },
      'The normal quantile plot',
    );

    const notNormal = typeof jb === 'number' && jb > JARQUE_BERA_CUT;

    box.figure('Days with a return', count(rows.length), "reduce('ret', 'count')");
    box.figure('Mean daily return', pct(mean, 4), "interval('ret', {kind:'mean'})");
    box.figure(
      '95% interval on the mean',
      interval ? `${pct(interval.lower, 4)} to ${pct(interval.upper, 4)}` : '-',
      'interval().lower / .upper',
    );
    box.figure('Median daily return', pct(median, 4), "reduce('ret', 'median')");
    box.figure('Standard deviation', size(sd, 3), "reduce('ret', 'stddev')");
    box.figure('Skewness', num(skew, 3), "reduce('ret', 'skewness')");
    box.figure('Excess kurtosis', num(kurt, 2), "reduce('ret', 'kurtosis')");
    box.figure('Jarque-Bera', count(Math.round(jb)), "reduce('ret', 'jarqueBera')");
    box.figure('1% of days are below', pct(q01, 3), "weightedQuantile('ret', 'one', 0.01)");
    box.figure('A normal would put that at', pct(normalLow, 3), `the model: mean − ${num(NORMAL_Z99, 4)} σ`);
    box.figure('1% of days are above', pct(q99, 3), "weightedQuantile('ret', 'one', 0.99)");
    box.figure('A normal would put that at', pct(normalHigh, 3), `the model: mean + ${num(NORMAL_Z99, 4)} σ`);
    box.note(
      'The density curve is the grid’s own kernel density estimate, which has no bin edges and so ' +
        'says which part of the shape is the data’s. The normal it is being compared against is ' +
        'stated as figures rather than drawn over it: a histogram takes `curve: true` for its own ' +
        'density and has no way to overlay a named reference distribution, which is finding ' +
        'F-FX-3. Nothing is drawn here by hand to fill the gap.',
    );

    verdicts.push({
      text: notNormal
        ? `A day in ${entry.label} is not normally distributed, and it is not close. Jarque-Bera ` +
          `over ${count(rows.length)} days is ${count(Math.round(jb))} against a cut of 5.99, and the ` +
          `excess kurtosis is ${num(kurt, 1)} — a normal’s is nought. The middle of the ` +
          'distribution looks perfectly well behaved; it is the tails that are wrong.'
        : `Jarque-Bera over these ${count(rows.length)} days is ${num(jb, 1)}, below the 5.99 cut, so ` +
          'normality is not ruled out on this stretch. That is unusual for a daily currency return ' +
          'and worth a second look at how few days are in view.',
      source: "grid.statistics.reduce('ret', 'jarqueBera')",
    });

    verdicts.push({
      text:
        `One day in a hundred, ${entry.label} falls more than ${size(q01, 2)} or rises more than ` +
        `${size(q99, 2)}. A normal distribution with the same mean and the same standard deviation ` +
        `of ${size(sd, 3)} would put those two days at ${size(normalLow, 2)} and ${size(normalHigh, 2)}. ` +
        `${
          tailRatio && tailRatio > 1.05
            ? `The real tails are about ${num(tailRatio, 2)} times as far out as the model’s, which ` +
              'is the whole reason a normal is the wrong model for a currency: it does not merely ' +
              'get the extremes slightly wrong, it does not think they can happen.'
            : tailRatio && tailRatio < 0.95
              ? 'The real tails are closer in than the model’s, which a short and quiet stretch will do.'
              : 'The two agree closely over this stretch.'
        }`,
      source: "grid.statistics.weightedQuantile('ret', 'one', 0.01 | 0.99) against the normal model",
    });

    return {
      ok: true,
      pair: pairId,
      n: rows.length,
      mean,
      lower: interval ? interval.lower : null,
      upper: interval ? interval.upper : null,
      median,
      sd,
      skewness: skew,
      kurtosis: kurt,
      jarqueBera: jb,
      notNormal,
      q01,
      q99,
      normalLow,
      normalHigh,
      tailRatio,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Does volatility cluster?                                         */
  /* ------------------------------------------------------------------ */

  function volatility(input, verdicts) {
    const entry = pairOf(pairId);
    const box = card(
      'volatility',
      'Is the spread itself steady?',
      `Divide the days into runs of ${BLOCK_DAYS} — about a trading month — and measure the ` +
        'standard deviation of each run. A control chart then asks the question a control chart ' +
        'always asks: is this one process doing the same thing every month, or does it move? Its ' +
        'limits come from the month-to-month jump rather than the overall spread, so a shift ' +
        'cannot widen the limits that are meant to catch it.',
    );

    const blocks = blockRows(input.returns, BLOCK_DAYS);
    if (blocks.length < BLOCK_DAYS * 8) {
      box.note(
        `Only ${Math.floor(blocks.length / BLOCK_DAYS)} whole runs of ${BLOCK_DAYS} days are in ` +
          'view, which is too few for control limits to mean anything.',
      );
      return { ok: false, reason: 'too few blocks' };
    }

    const spans = blockSpans(blocks);
    const source = dataset(blocks, [
      { id: 'block', field: 'block', title: 'Run', type: 'number' },
      { id: 'ret', field: 'ret', title: 'Log return', type: 'number' },
    ]);

    /* The spread of each run, computed by the grid one run at a time. */
    const perBlock = derive(
      source,
      { groupBy: 'block', select: { sd: { of: 'ret', fn: 'stddev' }, n: { fn: 'count' } } },
      [
        { id: 'block', field: 'block', title: 'Run', type: 'number' },
        { id: 'sd', field: 'sd', title: 'Standard deviation', type: 'number' },
        { id: 'n', field: 'n', title: 'Days', type: 'number' },
      ],
    );

    const readings = readRows(perBlock)
      .filter((row) => typeof row.block === 'number' && typeof row.sd === 'number')
      .sort((a, b) => a.block - b.block)
      .map((row) => {
        const span = spans.get(row.block) || { from: '?', to: '?' };
        return { id: `run-${row.block}`, block: row.block, sd: row.sd, from: span.from, to: span.to };
      });

    if (readings.length < 8) {
      box.note('Fewer than eight runs hold a spread, so no control limits are quoted.');
      return { ok: false, reason: 'too few readings' };
    }

    /*
     * The tolerance. The control limits and the rule breaks are facts about
     * these readings and need no customer specification, but `capability`
     * returns null without one, so the honest floor is declared: a standard
     * deviation cannot be less than nought. It is one-sided, so no Cp comes out
     * of it and none is shown. That is finding F-FX-4.
     */
    const chartGrid = dataset(readings, [
      { id: 'label', field: 'to', title: 'Run ending' },
      { id: 'sd', field: 'sd', title: 'Standard deviation', type: 'number', spec: { lower: 0 } },
    ]);

    const nelson = chartGrid.statistics.capability('sd', { lower: 0, rules: 'nelson' });
    const western = chartGrid.statistics.capability('sd', { lower: 0, rules: 'westernElectric' });
    if (!nelson || !nelson.limits) {
      box.note('The control limits were refused on these readings.');
      return { ok: false, reason: 'no limits' };
    }

    chartInto(
      box.plot(260),
      {
        grid: chartGrid,
        type: 'control',
        y: 'sd',
        rules: 'nelson',
        spec: { lower: 0 },
        title: `${entry.label}: the standard deviation of each ${BLOCK_DAYS}-day run`,
        axis: { x: { labels: false }, y: 'Standard deviation of the daily return' },
        legend: false,
      },
      'The control chart',
    );

    /* A violation names its reading by position, so the position is turned back
       into the days that reading covers. */
    const beyond = [];
    const byRule = new Map();
    for (const violation of nelson.violations) {
      byRule.set(violation.rule, (byRule.get(violation.rule) || 0) + 1);
      if (violation.rule !== 1) continue;
      const reading = readings[violation.index];
      if (reading) beyond.push({ from: reading.from, to: reading.to, sd: reading.sd });
    }
    beyond.sort((a, b) => b.sd - a.sd);

    const highest = [...readings].sort((a, b) => b.sd - a.sd)[0];
    const lowest = [...readings].sort((a, b) => a.sd - b.sd)[0];
    const inControl = readings.filter(
      (row) => row.sd >= nelson.limits.lower && row.sd <= nelson.limits.upper,
    ).length;

    box.figure('Runs charted', count(readings.length), `${BLOCK_DAYS} days each`);
    box.figure('Centre line', size(nelson.limits.centre, 3), "capability('sd').limits.centre");
    box.figure(
      'Control limits',
      `${size(nelson.limits.lower, 3)} to ${size(nelson.limits.upper, 3)}`,
      'limits.lower / .upper',
    );
    box.figure('Sigma, from the moving range', size(nelson.limits.sigma, 4), 'limits.sigma');
    box.figure(
      'Runs inside the limits',
      `${count(inControl)} of ${count(readings.length)}`,
      'limits.lower / .upper',
    );
    box.figure('Nelson breaks', count(nelson.violations.length), "capability({rules:'nelson'})");
    box.figure(
      'Western Electric breaks',
      western ? count(western.violations.length) : '-',
      "capability({rules:'westernElectric'})",
    );
    box.figure(
      'Beyond three sigma (rule 1)',
      count(byRule.get(1) || 0),
      'violations[].rule === 1',
    );
    box.figure(
      'Nine in a row on one side (rule 2)',
      count(byRule.get(2) || 0),
      'violations[].rule === 2',
    );
    box.figure('Calmest run', `${size(lowest.sd, 3)}, ${lowest.from} to ${lowest.to}`, 'derived select {sd}');
    box.figure('Wildest run', `${size(highest.sd, 3)}, ${highest.from} to ${highest.to}`, 'derived select {sd}');

    const worst = box.list();
    for (const item of beyond.slice(0, 6)) {
      worst.append(
        el('li', null, `${item.from} to ${item.to} — standard deviation ${size(item.sd, 3)}, beyond three sigma`),
      );
    }
    if (!beyond.length) worst.append(el('li', null, 'No run went beyond three sigma.'));

    box.note(
      `The runs do not overlap. A rolling ${BLOCK_DAYS}-day window is the usual way to draw this, ` +
        'and it is not available: the grid’s rolling column family runs `rollingSum`, `rollingAvg`, ' +
        '`rollingMin`, `rollingMax` and `rollingQuantile`, and has no `rollingStddev`, so a rolling ' +
        'spread cannot be had from the public API as a series. That is finding F-FX-1, and it is ' +
        'not worked around here. Non-overlapping runs are the better chart anyway: consecutive ' +
        'overlapping windows share nineteen days in twenty, so the points would be autocorrelated ' +
        'by construction and every control rule about runs and trends would fire on the overlap ' +
        'rather than on the market.',
    );

    verdicts.push({
      text:
        `${entry.label}’s volatility is not a steady process, and the chart says so loudly. Over ` +
        `${count(readings.length)} runs of ${BLOCK_DAYS} days the centre line sits at ` +
        `${size(nelson.limits.centre, 3)} a day with limits of ${size(nelson.limits.lower, 3)} to ` +
        `${size(nelson.limits.upper, 3)}, and ${count(nelson.violations.length)} readings break a ` +
        `Nelson rule — ${count(byRule.get(1) || 0)} of them beyond three sigma and ` +
        `${count(byRule.get(2) || 0)} of them nine or more in a row on one side of the line. ` +
        `${
          beyond.length
            ? `The wildest run was ${beyond[0].from} to ${beyond[0].to} at ${size(beyond[0].sd, 3)} a day, ` +
              `against ${size(nelson.limits.centre, 3)} in an ordinary month.`
            : 'No single run cleared three sigma; the breaks are all runs and trends.'
        } Those long one-sided runs are the finding: quiet months come after quiet months and wild ` +
        'months after wild ones. Volatility clusters.',
      source: "grid.statistics.capability('sd', { lower: 0, rules: 'nelson' })",
    });

    return {
      ok: true,
      pair: pairId,
      readings: readings.length,
      centre: nelson.limits.centre,
      upper: nelson.limits.upper,
      lower: nelson.limits.lower,
      sigma: nelson.limits.sigma,
      inControl,
      nelson: nelson.violations.length,
      western: western ? western.violations.length : null,
      rule1: byRule.get(1) || 0,
      rule2: byRule.get(2) || 0,
      beyond: beyond.slice(0, 6),
      highest: { sd: highest.sd, from: highest.from, to: highest.to },
      lowest: { sd: lowest.sd, from: lowest.from, to: lowest.to },
      sds: readings.map((row) => row.sd),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Is a return predictable? Is its SIZE?                            */
  /* ------------------------------------------------------------------ */

  function autocorrelation(input, verdicts) {
    const entry = pairOf(pairId);
    const box = card(
      'autocorrelation',
      'Is tomorrow readable from today?',
      'Autocorrelation asks whether a series carries information about its own future. Run it ' +
        'twice on the same days: once on the return, which is the direction and the size ' +
        'together, and once on the size of the return with the direction thrown away. The two ' +
        'answers are not the same answer, and the difference between them is the single most ' +
        'useful fact about a financial series.',
    );

    const rows = input.returns;
    if (rows.length < MIN_RETURNS) {
      box.note('Too few days in view to take an autocorrelation from.');
      return { ok: false, reason: 'too few returns' };
    }

    const source = dataset(rows, RETURN_COLUMNS);
    const S = source.statistics;

    /* `orderBy` is required and never guessed: a series read in the grid's
       screen sort would be a series in whatever order a header was last
       clicked. `seq` is the position of the day in the series. */
    const ofReturn = S.acf({ of: 'ret', orderBy: 'seq', maxlag: MAX_LAG });
    const ofSize = S.acf({ of: 'abs', orderBy: 'seq', maxlag: MAX_LAG });
    if (!ofReturn || !ofSize) {
      box.note('The autocorrelation was refused on these days.');
      return { ok: false, reason: 'no acf' };
    }

    const outside = (result) =>
      result.acf.slice(1).filter((value) => Math.abs(value) > result.bounds.upper).length;
    const returnOutside = outside(ofReturn);
    const sizeOutside = outside(ofSize);

    /* Both series on one chart, as the grid's own series split: one row per lag
       per series, `series` naming the column that divides them. The d.ts says
       in as many words to feed the arrays to a bar chart over explicit points
       with the band as reference lines, so that is what this is. */
    const bars = [];
    for (let lag = 1; lag <= MAX_LAG; lag += 1) {
      bars.push({ id: `ret-${lag}`, lag, kind: 'The return', value: ofReturn.acf[lag] });
      bars.push({ id: `abs-${lag}`, lag, kind: 'Its size', value: ofSize.acf[lag] });
    }
    const barGrid = dataset(bars, [
      { id: 'lag', field: 'lag', title: 'Lag (days)', type: 'number' },
      { id: 'kind', field: 'kind', title: 'Series' },
      { id: 'value', field: 'value', title: 'Autocorrelation', type: 'number' },
    ]);

    chartInto(
      box.plot(250),
      {
        grid: barGrid,
        type: 'bar',
        x: 'lag',
        y: 'value',
        series: 'kind',
        reference: [
          { value: ofReturn.bounds.upper, label: '+1.96/√n' },
          { value: ofReturn.bounds.lower, label: '−1.96/√n' },
        ],
        title: `${entry.label}: autocorrelation of the return and of its size`,
        axis: { x: 'Lag in trading days', y: 'Autocorrelation' },
        legend: { position: 'top' },
      },
      'The autocorrelation chart',
    );

    box.figure('Days in the series', count(ofReturn.n), 'acf().n');
    box.figure('Lags taken', String(ofReturn.nlags), 'acf().nlags');
    box.figure(
      'White-noise band',
      `±${num(ofReturn.bounds.upper, 4)}`,
      'acf().bounds — the ±1.96/√n approximation',
    );
    box.figure('Return, lag 1', num(ofReturn.acf[1], 4), 'acf({of:"ret"}).acf[1]');
    box.figure('Return, lag 5', num(ofReturn.acf[5], 4), 'acf({of:"ret"}).acf[5]');
    box.figure(
      'Return: lags outside the band',
      `${returnOutside} of ${ofReturn.nlags}`,
      'acf().acf against acf().bounds',
    );
    box.figure('Size, lag 1', num(ofSize.acf[1], 4), 'acf({of:"abs"}).acf[1]');
    box.figure('Size, lag 5', num(ofSize.acf[5], 4), 'acf({of:"abs"}).acf[5]');
    box.figure('Size, lag 20', num(ofSize.acf[MAX_LAG], 4), `acf({of:"abs"}).acf[${MAX_LAG}]`);
    box.figure(
      'Size: lags outside the band',
      `${sizeOutside} of ${ofSize.nlags}`,
      'acf().acf against acf().bounds',
    );
    box.figure('Return, partial at lag 1', num(ofReturn.pacf[1], 4), 'acf().pacf[1]');
    box.note(
      'The band is the grid’s own ±1.96/√n approximation and the result says so: `approximate` ' +
        'comes back true, so a lag just outside it is not a discovery. Under pure chance about one ' +
        `lag in twenty would fall outside, which over ${MAX_LAG} lags is one.`,
    );

    verdicts.push({
      text:
        `The return on ${entry.label} is very nearly unpredictable from its own past: of ` +
        `${ofReturn.nlags} lags, ${returnOutside} clear the ±${num(ofReturn.bounds.upper, 3)} ` +
        `white-noise band, and lag 1 is ${num(ofReturn.acf[1], 4)} — indistinguishable from nought. ` +
        `The SIZE of the return is a different series entirely: ${sizeOutside} of ${ofSize.nlags} ` +
        `lags clear the band, lag 1 is ${num(ofSize.acf[1], 3)} and lag ${MAX_LAG} is still ` +
        `${num(ofSize.acf[MAX_LAG], 3)}. ${
          sizeOutside > returnOutside
            ? 'So: which way it moves tomorrow is not readable from today, but how far it moves is. ' +
              'That is the same fact analysis 2 found from the other end, and it is why every ' +
              'volatility model that has ever been used exists.'
            : 'On this stretch the two look alike, which is unusual and is worth reading against ' +
              'how few days are in view.'
        }`,
      source: "grid.statistics.acf({ of: 'ret' | 'abs', orderBy: 'seq' })",
    });

    return {
      ok: true,
      pair: pairId,
      n: ofReturn.n,
      lags: ofReturn.nlags,
      bound: ofReturn.bounds.upper,
      returnAcf: ofReturn.acf.slice(0, MAX_LAG + 1),
      sizeAcf: ofSize.acf.slice(0, MAX_LAG + 1),
      returnPacf: ofReturn.pacf.slice(0, MAX_LAG + 1),
      returnOutside,
      sizeOutside,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Is the rate stationary? Is the return?                           */
  /* ------------------------------------------------------------------ */

  function stationarity(input, verdicts) {
    const entry = pairOf(pairId);
    const box = card(
      'stationarity',
      'Does the rate have a level to come back to?',
      'A stationary series has a level it returns to; a non-stationary one wanders, and a ' +
        'correlation taken between two wandering series is very likely to be an artefact of the ' +
        'wandering rather than a relationship. The Augmented Dickey-Fuller test asks which kind a ' +
        'series is. Run it on the rate and then on the return, and the standard practice of ' +
        'modelling returns rather than levels stops being a convention and becomes a result.',
    );

    if (input.levels.length < MIN_RETURNS || input.returns.length < MIN_RETURNS) {
      box.note('Too few days in view to test for stationarity.');
      return { ok: false, reason: 'too few days' };
    }

    const levelGrid = dataset(input.levels, [
      { id: 'seq', field: 'seq', title: 'Position', type: 'number' },
      { id: 'date', field: 'date', title: 'Date' },
      { id: 'rate', field: 'rate', title: 'Rate', type: 'number' },
    ]);
    const returnGrid = dataset(input.returns, RETURN_COLUMNS);

    const onLevel = levelGrid.statistics.adf({ of: 'rate', orderBy: 'seq' });
    const onReturn = returnGrid.statistics.adf({ of: 'ret', orderBy: 'seq' });
    if (!onLevel || !onReturn) {
      box.note('The stationarity test was refused on these days.');
      return { ok: false, reason: 'no adf' };
    }

    /* These two do not paint on 1.62.1 either, for the reason the note in
       `src/dashboard.js` gives: the renderer's downsample step leaks the LTTB
       index into each point's `x`, so a dense line lands off-plot. Grid card
       1344, fixed in 1.63. Left as written rather than worked around. */
    chartInto(
      box.plot(220),
      {
        grid: levelGrid,
        type: 'line',
        x: 'date',
        y: 'rate',
        title: `${entry.label}: the rate itself`,
        axis: { x: { labels: false }, y: 'Rate' },
        legend: false,
      },
      'The level',
    );

    chartInto(
      box.plot(220),
      {
        grid: returnGrid,
        type: 'line',
        x: 'date',
        y: 'ret',
        title: `${entry.label}: the daily return`,
        axis: { x: { labels: false }, y: 'Log return' },
        reference: [{ value: 0 }],
        legend: false,
      },
      'The return',
    );

    const say = (result) =>
      `${num(result.statistic, 2)} against ${num(result.criticalValues['5%'], 2)} at 5%`;

    box.figure('The rate: ADF statistic', num(onLevel.statistic, 3), "adf({of:'rate', orderBy:'seq'})");
    box.figure('The rate: verdict', onLevel.verdict, 'adf().verdict');
    box.figure('The rate: approximate p', num(onLevel.pValue, 4), 'adf().pValue — interpolated');
    box.figure('The rate: lags chosen by AIC', String(onLevel.usedLag), 'adf().usedLag');
    box.figure('The rate: observations', count(onLevel.nobs), 'adf().nobs');
    box.figure('The return: ADF statistic', num(onReturn.statistic, 3), "adf({of:'ret', orderBy:'seq'})");
    box.figure('The return: verdict', onReturn.verdict, 'adf().verdict');
    box.figure('The return: approximate p', num(onReturn.pValue, 4), 'adf().pValue — interpolated');
    box.figure('The return: lags chosen by AIC', String(onReturn.usedLag), 'adf().usedLag');
    box.figure(
      'Critical values (1%, 5%, 10%)',
      `${num(onLevel.criticalValues['1%'], 3)}, ${num(onLevel.criticalValues['5%'], 3)}, ${num(
        onLevel.criticalValues['10%'],
        3,
      )}`,
      'adf().criticalValues — MacKinnon, constant + trend',
    );
    box.note(
      'The p-value is interpolated across MacKinnon’s critical-value ladder rather than taken from ' +
        'the response surface, and the result says so in `pApproximate`. The statistic and the ' +
        'critical values are the readings to quote; the p-value is a convenience.',
    );

    verdicts.push({
      text:
        `The ${entry.label} rate is ${onLevel.verdict}: ADF is ${say(onLevel)}, so ` +
        `${
          onLevel.stationary
            ? 'over this stretch it does have a level to come back to — which is not the usual ' +
              'answer for an exchange rate and is worth reading against how narrow the window is.'
            : 'the null of a unit root is not rejected. It wanders; it has no level it is obliged ' +
              'to return to.'
        } Difference it once — which is what a daily return is — and ADF becomes ` +
        `${say(onReturn)}: ${onReturn.verdict}. ${
          !onLevel.stationary && onReturn.stationary
            ? 'That single fact is why every serious piece of currency analysis is done on returns ' +
              'rather than on rates, and here it is a result rather than a convention.'
            : 'The two agree more than usual on this stretch.'
        }`,
      source: "grid.statistics.adf({ of: 'rate' | 'ret', orderBy: 'seq' })",
    });

    return {
      ok: true,
      pair: pairId,
      level: {
        statistic: onLevel.statistic,
        pValue: onLevel.pValue,
        usedLag: onLevel.usedLag,
        nobs: onLevel.nobs,
        stationary: onLevel.stationary,
        verdict: onLevel.verdict,
        critical5: onLevel.criticalValues['5%'],
      },
      returns: {
        statistic: onReturn.statistic,
        pValue: onReturn.pValue,
        usedLag: onReturn.usedLag,
        nobs: onReturn.nobs,
        stationary: onReturn.stationary,
        verdict: onReturn.verdict,
        critical5: onReturn.criticalValues['5%'],
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5. How much of sterling's day is the dollar's?                      */
  /* ------------------------------------------------------------------ */

  function crossPair(input, verdicts) {
    const box = card(
      'cross-pair',
      'How much of sterling’s day is the dollar’s?',
      'EUR/GBP and EUR/USD share a leg, so they are not independent. Regress one day’s sterling ' +
        'return on the same day’s dollar return and the slope says how much of sterling’s move ' +
        'travels with the dollar’s — and, just as usefully, how much does not.',
    );

    const rows = input.pairs;
    if (rows.length < MIN_RETURNS) {
      box.note('Too few days hold both returns to fit anything to.');
      return { ok: false, reason: 'too few pairs' };
    }

    const source = dataset(rows, [
      { id: 'usdRet', field: 'usdRet', title: 'EUR/USD return', type: 'number' },
      { id: 'gbpRet', field: 'gbpRet', title: 'EUR/GBP return', type: 'number' },
      { id: 'date', field: 'date', title: 'Date' },
    ]);
    const S = source.statistics;

    const model = S.regressionModel({ predictors: ['usdRet'], response: 'gbpRet', confidence: 0.95 });
    if (!model) {
      box.note('The fit was refused on these days, so no slope is quoted.');
      return { ok: false, reason: 'no model' };
    }
    const slope = model.coefficients.find((c) => c.name === 'usdRet');
    const pearson = S.correlation('usdRet', 'gbpRet');
    const spearman = S.spearman('usdRet', 'gbpRet');

    chartInto(
      box.plot(280),
      {
        grid: source,
        type: 'scatter',
        x: 'usdRet',
        y: 'gbpRet',
        /* Bound to the columns rather than handed in as points, which is safe
           here: there are thousands of distinct x values, so the axis is
           continuous and `fit` and `band` both apply. */
        fit: true,
        /* The ribbon is the fitted model's own pointwise interval, not a second
           slope drawn here. */
        band: model.band,
        canvas: true,
        title: 'Each day: the EUR/USD return against the EUR/GBP return',
        axis: { x: 'EUR/USD daily log return', y: 'EUR/GBP daily log return' },
        legend: false,
      },
      'The regression chart',
    );

    box.figure('Days fitted', count(model.n), 'regressionModel().n');
    box.figure('Slope', num(slope.estimate, 4), 'regressionModel().coefficients');
    box.figure(
      '95% interval on the slope',
      slope.lower == null ? '-' : `${num(slope.lower, 4)} to ${num(slope.upper, 4)}`,
      'coefficient.lower / .upper',
    );
    box.figure('Standard error of the slope', num(slope.stdError, 5), 'coefficient.stdError');
    box.figure('R²', num(model.r2, 4), 'regressionModel().r2');
    box.figure('Pearson correlation', num(pearson, 4), "correlation('usdRet', 'gbpRet')");
    box.figure('Spearman correlation', num(spearman, 4), "spearman('usdRet', 'gbpRet')");
    box.figure(
      'Breusch-Pagan on the residuals',
      model.heteroscedasticity
        ? `${num(model.heteroscedasticity.statistic, 2)}, ${
            model.heteroscedasticity.heteroscedastic ? 'heteroscedastic' : 'no evidence'
          }`
        : '-',
      'regressionModel().heteroscedasticity',
    );
    box.note(
      'The shaded ribbon is the model’s own pointwise confidence band, handed to the chart as ' +
        '`band: model.band`, so the picture and the figures beneath it are one computation rather ' +
        'than a slope fitted twice. It is an interval on the fitted LINE, not a prediction ' +
        'interval for a day: most days sit well outside it, and should.',
    );

    verdicts.push({
      text:
        `A one per cent day in EUR/USD comes with a ${num(slope.estimate, 3)} per cent day in ` +
        `EUR/GBP, and the fit puts that slope between ${num(slope.lower, 3)} and ` +
        `${num(slope.upper, 3)} over ${count(model.n)} days. ` +
        `${
          slope.lower != null && slope.lower > 0 && slope.upper < 1
            ? 'The interval clears nought and sits well below one, so the two move together and ' +
              'sterling moves less than the dollar does — it is nearer the euro.'
            : slope.lower != null && slope.lower > 1
              ? 'The interval sits above one: sterling moved further than the dollar over this stretch.'
              : 'The interval spans values that make no single reading safe.'
        } But the line only accounts for ${num(model.r2 * 100, 1)}% of sterling: ` +
        `${num((1 - model.r2) * 100, 1)}% of what EUR/GBP did on these days had nothing to do with ` +
        `the dollar at all.${
          model.heteroscedasticity && model.heteroscedasticity.heteroscedastic
            ? ' The residuals are heteroscedastic by Breusch-Pagan, which is the same clustering ' +
              'the volatility chart found showing up in a third place.'
            : ''
        }`,
      source: "grid.statistics.regressionModel({ predictors: ['usdRet'], response: 'gbpRet' })",
    });

    return {
      ok: true,
      n: model.n,
      slope: slope.estimate,
      lower: slope.lower,
      upper: slope.upper,
      stdError: slope.stdError,
      r2: model.r2,
      pearson,
      spearman,
      heteroscedastic: model.heteroscedasticity ? model.heteroscedasticity.heteroscedastic : null,
      bandPoints: model.band ? model.band.points.length : 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 6. Which days do not belong?                                        */
  /* ------------------------------------------------------------------ */

  function anomalies(input, verdicts) {
    const entry = pairOf(pairId);
    const box = card(
      'anomalies',
      'Which days do not belong?',
      'The modified z-score measures each day against the median and the spread around it, so one ' +
        'enormous day cannot widen the ruler it is being measured with — which on a currency is ' +
        'not a nicety, it is the whole difference between finding the outliers and having them ' +
        'hide each other. Every day it flags is a day something happened.',
    );

    const rows = input.returns;
    if (rows.length < MIN_RETURNS) {
      box.note('Too few days in view to score.');
      return { ok: false, reason: 'too few returns' };
    }

    const source = dataset(rows, RETURN_COLUMNS);
    const report = source.statistics.anomalies({ columns: ['ret'], method: 'modifiedZScore' });
    if (!report) {
      box.note('The anomaly scan was refused on these days.');
      return { ok: false, reason: 'no report' };
    }

    const worst = report.rows.slice(0, TOP_ANOMALIES).map((row) => {
      const why = row.why && row.why[0] ? row.why[0] : null;
      return {
        date: row.rowKey,
        ret: why ? why.value : null,
        score: row.score,
        note: noteFor(row.rowKey),
      };
    });

    box.figure(
      'Days flagged',
      `${count(report.flagged)} of ${count(report.n)}`,
      "anomalies({columns:['ret'], method:'modifiedZScore'})",
    );
    box.figure('Share of days flagged', `${num((report.flagged / report.n) * 100, 2)}%`, 'flagged ÷ n');
    box.figure('Method', report.method, 'anomalies().method');
    if (worst.length) {
      box.figure(
        'Biggest day',
        `${worst[0].date}, ${pct(worst[0].ret, 2)}, score ${num(worst[0].score, 1)}`,
        'anomalies().rows[0]',
      );
    }
    const named = worst.filter((row) => row.note).length;
    box.figure('Of the ten listed, days this demo can name', String(named), 'a fixed table of dates');

    const list = box.list();
    for (const row of worst) {
      const item = el('li');
      item.append(el('strong', null, row.date));
      item.append(
        document.createTextNode(` — ${pct(row.ret, 2)}, modified z ${num(row.score, 1)}. `),
      );
      item.append(
        el(
          'span',
          row.note ? 'anomaly-note' : 'anomaly-note anomaly-unknown',
          row.note || 'This demo has no note for this date, so it offers none.',
        ),
      );
      list.append(item);
    }
    if (!worst.length) list.append(el('li', null, 'No day in view was flagged.'));

    box.note(
      'The notes are a fixed table of dates in the source, matched on the exact publication day ' +
        'and on nothing else. A day that is not in the table is shown without an explanation ' +
        'rather than given one that fits: a demo that invents a cause for an outlier is worse than ' +
        'one that leaves it bare, because a reader cannot tell the two apart. The ECB publishes at ' +
        'about 16:00 Central European Time, so an American announcement in the afternoon lands on ' +
        'the NEXT day’s rate — which is why several of these dates are one day after the event ' +
        'they are named for.',
    );

    verdicts.push({
      text:
        `${count(report.flagged)} of ${count(report.n)} days in view — ` +
        `${num((report.flagged / report.n) * 100, 1)}% — are flagged as outliers by the modified ` +
        `z-score.${
          worst.length
            ? ` The biggest is ${worst[0].date}: ${pct(worst[0].ret, 2)}, a modified z of ` +
              `${num(worst[0].score, 1)}.${worst[0].note ? ` ${worst[0].note}` : ''}`
            : ''
        } A normal distribution would put about ${num(0.7, 1)}% of days past the same cut, so ` +
        `${
          report.flagged / report.n > 0.01
            ? 'there are several times more extreme days here than a normal would allow — the same ' +
              'fat tails the first analysis measured, arriving with dates attached.'
            : 'the count is close to what a normal would allow over this stretch.'
        }`,
      source: "grid.statistics.anomalies({ columns: ['ret'], method: 'modifiedZScore' })",
    });

    return {
      ok: true,
      pair: pairId,
      n: report.n,
      flagged: report.flagged,
      method: report.method,
      worst,
      named,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Putting it together                                                 */
  /* ------------------------------------------------------------------ */

  /** Throw away everything the last pass built. */
  function teardown() {
    for (const chart of built.charts) {
      try {
        chart.destroy();
      } catch {}
    }
    for (const instance of built.grids) {
      try {
        instance.destroy();
      } catch {}
    }
    built = { charts: [], grids: [] };
    board.textContent = '';
    verdictList.textContent = '';
  }

  /** Read the table as it stands and rebuild every analysis from it. */
  function refresh() {
    teardown();
    state.passes += 1;
    state.error = null;
    paint();

    let rows;
    try {
      rows = readRows(grid);
    } catch (error) {
      state.error = String((error && error.message) || error);
      board.append(el('p', 'chart-error', `The table could not be read: ${state.error}`));
      return state;
    }

    const input = {
      rows,
      returns: returnRows(rows, pairId),
      levels: levelRows(rows, pairId),
      pairs: rows
        .filter((row) => typeof row.usdRet === 'number' && typeof row.gbpRet === 'number')
        .map((row) => ({ id: row.date, date: row.date, usdRet: row.usdRet, gbpRet: row.gbpRet })),
    };

    state.rows = rows.length;
    state.pair = pairId;
    state.range = rangeId;
    const first = rows.length ? rows.reduce((a, b) => (a.date < b.date ? a : b)).date : null;
    const last = rows.length ? rows.reduce((a, b) => (a.date > b.date ? a : b)).date : null;
    basis.textContent = rows.length
      ? `${count(rows.length)} publication days in view, ${first} to ${last}`
      : 'Nothing in view';

    const verdicts = [];
    const analyses = {};
    const run = (id, fn) => {
      try {
        analyses[id] = fn(input, verdicts);
      } catch (error) {
        analyses[id] = { ok: false, reason: String((error && error.message) || error) };
        board.append(el('p', 'chart-error', `${id} could not be computed: ${analyses[id].reason}`));
        console.error('[fx statistics]', id, error);
      }
    };

    run('distribution', distribution);
    run('volatility', volatility);
    run('autocorrelation', autocorrelation);
    run('stationarity', stationarity);
    run('crossPair', crossPair);
    run('anomalies', anomalies);

    for (const verdict of verdicts) {
      const item = el('li');
      item.append(el('span', 'verdict-text', verdict.text));
      item.append(el('code', 'verdict-source', verdict.source));
      verdictList.append(item);
    }
    if (!verdicts.length) {
      verdictList.append(el('li', null, 'Nothing in view to read a verdict from.'));
    }

    state.analyses = analyses;
    state.verdicts = verdicts;
    state.first = first;
    state.last = last;
    return state;
  }

  /* The panel is only ever built when its tab is first opened, so the first
     pass happens here. */
  refresh();

  return {
    el: root,
    refresh,
    state,
    pair: () => pairId,
    setPair(id) {
      pairId = id;
      return refresh();
    },
    range: () => rangeId,
    setRange(id) {
      rangeId = id;
      return refresh();
    },
    destroy() {
      teardown();
      root.remove();
    },
  };
}
