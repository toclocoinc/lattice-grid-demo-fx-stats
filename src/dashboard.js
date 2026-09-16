/**
 * The views: the router, the rates table, the bound tiles, the charts and the
 * tabs.
 *
 * One stream of publication days goes in. A table, a strip of tiles and four
 * charts come out of it, and a Statistics tab puts six questions to whatever
 * the table currently matches.
 */

import { BLOCK_DAYS, PAIRS, pairOf } from './analysis.js';
import { buildStatistics } from './statistics.js';

/** The date ranges the page offers, newest era first after "everything". */
export const RANGES = [
  { id: 'all', label: 'All of it', from: null },
  { id: 'crisis', label: 'Since 2008', from: '2008-01-01' },
  { id: 'modern', label: 'Since 2015', from: '2015-01-01' },
  { id: 'recent', label: 'Last 5 years', from: null, years: 5 },
];

/** Make an element with a class and optional text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A whole number with thousands separators. */
function commas(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

/** A rate, to the places that pair is quoted in. */
function rateText(value, places) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(places) : '-';
}

/** The first day of a range, resolved against today where it is relative. */
export function rangeFrom(range) {
  if (!range) return null;
  if (range.years) {
    const now = new Date();
    const then = new Date(Date.UTC(now.getUTCFullYear() - range.years, now.getUTCMonth(), now.getUTCDate()));
    return then.toISOString().slice(0, 10);
  }
  return range.from;
}

/**
 * The columns of the rates table.
 *
 * Four rates, and four log returns the GRID computes from them. A computed
 * column names what it reads in `deps` and is handed those values; it is not a
 * field on the row, which is why the whole statistics surface can read it
 * (`reduce`, `acf`, `adf`, `anomalies`, `regressionModel` all work against one)
 * but a derived source cannot (finding F-FX-5).
 */
function rateColumns() {
  const columns = [
    {
      id: 'date',
      field: 'date',
      title: 'Date',
      width: 116,
      pinned: 'left',
      sort: 'desc',
    },
  ];
  for (const pair of PAIRS) {
    const places = pair.id === 'jpy' ? 2 : 4;
    columns.push({
      id: pair.id,
      field: pair.id,
      title: pair.label,
      type: 'number',
      width: 104,
      align: 'right',
      format: { type: 'number', decimals: places },
    });
    columns.push({
      id: `${pair.id}Ret`,
      title: `${pair.label} return`,
      type: 'number',
      width: 122,
      align: 'right',
      /*
       * Computed by the grid, from the rate and the rate the working day
       * before. `ln(today ÷ yesterday)`: log returns add up over time, which is
       * why every statistic on the Statistics tab is stated for them.
       *
       * `pure` says the result depends on nothing but the declared deps, so the
       * grid may cache it per row.
       */
      value: {
        deps: [pair.id, `${pair.id}Prev`],
        pure: true,
        compute: (deps) => {
          const now = deps[pair.id];
          const before = deps[`${pair.id}Prev`];
          if (typeof now !== 'number' || typeof before !== 'number' || now <= 0 || before <= 0) return null;
          return Math.log(now / before);
        },
      },
      format: (params) =>
        typeof params.value === 'number' && Number.isFinite(params.value)
          ? `${params.value >= 0 ? '+' : ''}${(params.value * 100).toFixed(3)}%`
          : '',
    });
  }
  return columns;
}

/** Colour a return by its direction, and a big one more strongly. */
function formattingRules() {
  const rules = [];
  for (const pair of PAIRS) {
    rules.push(
      { columns: [`${pair.id}Ret`], when: { op: 'lt', value: -0.01 }, style: { color: '#b4232b', fontWeight: '600' } },
      { columns: [`${pair.id}Ret`], when: { op: 'gt', value: 0.01 }, style: { color: '#1a6b3c', fontWeight: '600' } },
    );
  }
  return rules;
}

/**
 * Build the whole dashboard into `root`.
 *
 * @param {object} options
 * @returns {object} the handle the page and the checks read
 */
export function buildDashboard({
  root,
  createGrid,
  createChart,
  createKPI,
  createTabs,
  createDataRouter,
  createHeadlessGrid,
  rows,
  meta,
}) {
  root.textContent = '';

  const built = {
    root,
    store: new Map(),
    charts: [],
    status: { arrivals: 0, revisions: 0, dropped: 0, lastFetch: null, liveDays: 0 },
    meta,
  };

  let pairId = PAIRS[0].id;
  let rangeId = RANGES[0].id;

  /* ---------------- the masthead ---------------- */

  const header = el('header', 'head');
  header.append(el('h1', null, 'Twenty-seven years of exchange rates, and what the numbers say'));
  header.append(
    el(
      'p',
      'head-lede',
      'Every euro reference rate the European Central Bank has published since the euro began, read ' +
        'from the Frankfurter API in your browser — and then a Statistics tab that puts the grid’s ' +
        'statistics engine to work on the same rows and writes out what it finds in plain English.',
    ),
  );
  const provenance = el('div', 'head-note');
  const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
  if (meta.live) modePill.prepend(el('span', 'dot'));
  const freshness = el('span', 'freshness', 'Reading the saved copy...');
  provenance.append(modePill, freshness);
  header.append(provenance);
  root.append(header);

  /* ---------------- the tiles ---------------- */

  const kpiHost = el('section', 'kpi-strip');
  kpiHost.setAttribute('aria-label', 'Headline figures');
  const panelHost = el('div', 'kpi-panel');
  const namedTile = el('div', 'kpi-named');
  const namedValue = el('div', 'kpi-named-value', 'No data');
  const namedLabel = el('div', 'kpi-named-label', 'Largest daily move in view');
  namedTile.append(namedValue, namedLabel);
  kpiHost.append(panelHost, namedTile);
  root.append(kpiHost);

  /* ---------------- the charts ---------------- */

  const chartHost = el('section', 'chart-wrap');
  chartHost.setAttribute('aria-label', 'Charts');
  const chartBoxes = [];
  for (let i = 0; i < 4; i += 1) {
    const box = el('div', 'chart-box');
    chartHost.append(box);
    chartBoxes.push(box);
  }
  root.append(chartHost);

  /* ---------------- the controls ---------------- */

  const actions = el('div', 'actions');
  actions.append(el('span', 'actions-label', 'Pair'));
  const pairButtons = new Map();
  for (const pair of PAIRS) {
    const button = el('button', 'action toggle', pair.label);
    button.type = 'button';
    button.dataset.pair = pair.id;
    button.addEventListener('click', () => setPair(pair.id));
    pairButtons.set(pair.id, button);
    actions.append(button);
  }
  actions.append(el('span', 'actions-gap'));
  actions.append(el('span', 'actions-label', 'Dates'));
  const rangeButtons = new Map();
  for (const range of RANGES) {
    const button = el('button', 'action toggle', range.label);
    button.type = 'button';
    button.dataset.range = range.id;
    button.addEventListener('click', () => setRange(range.id));
    rangeButtons.set(range.id, button);
    actions.append(button);
  }
  root.append(actions);

  /* ---------------- the tables ---------------- */

  const tabsHost = el('section', 'tabs-host');
  root.append(tabsHost);

  /* Set while the statistics panel is being mounted, so its first pass is not
     immediately followed by a second. */
  let statisticsJustBuilt = false;

  const tabs = createTabs(tabsHost, {
    createGrid,
    ariaLabel: 'Exchange rate views',
    tabs: [
      {
        id: 'rates',
        label: 'Rates',
        badge: true,
        config: {
          rowKey: 'id',
          columns: rateColumns(),
          rows: [],
          height: 420,
          title: 'One row per publication day',
          theme: 'navy',
          rowNumbers: false,
          columnMenu: true,
          statusBar: true,
          formatting: { rules: formattingRules() },
        },
      },
      {
        /*
         * Not a grid: `view` mounts whatever factory it is given in the tab's
         * panel, so the statistics readout is a tab like any other rather than
         * a second page. It is built the first time the tab is opened, which is
         * why nothing here reaches for it before then.
         */
        id: 'statistics',
        label: 'Statistics',
        ariaLabel: 'Statistics and verdicts',
        view: (element) => {
          statisticsJustBuilt = true;
          const panel = buildStatistics({
            host: element,
            grid: built.grid,
            createHeadlessGrid,
            createChart,
            pair: pairId,
            onPair: (id) => setPair(id),
            ranges: RANGES,
            onRange: (id) => setRange(id),
          });
          built.statistics = panel;
          return panel;
        },
      },
    ],
  });
  built.tabs = tabs;
  built.grid = tabs.tab('rates');

  /* ---------------- the router ---------------- */

  /*
   * One stream in, the table out of it.
   *
   * `seq: 'revision'` is a counter this page stamps on every row it sends, so
   * the top-up's copy of a day always outranks the saved copy's: the ECB
   * revises a published rate only very rarely, but when it does, the newer
   * reading must win however the two happened to arrive.
   */
  const router = createDataRouter({
    key: () => 'rates',
    rowKey: 'id',
    seq: 'revision',
  });
  built.router = router;
  router.attach(built.grid, () => true);

  /* A route that renders nothing: it counts what arrives, for the readout
     under the masthead. */
  router.subscribe(() => true, (change) => {
    built.status.arrivals += (change.add || []).length;
    built.status.revisions += (change.update || []).length;
  });

  /**
   * Seed the table with the saved copy.
   *
   * ONE `rows.load`, through the router's own load. Sending seven thousand days
   * in as `apply({ add })` batches would be quadratic — each batch is matched
   * against everything already there — and on a history this long that is the
   * difference between a page that opens at once and a page that appears to
   * hang.
   */
  const load = (incoming) => {
    let revision = 0;
    for (const row of incoming) {
      row.revision = revision;
      built.store.set(row.id, row);
    }
    router.load([...built.store.values()]);
    built.status.arrivals = incoming.length;
    return incoming.length;
  };

  /**
   * Put later days through the router as a change, not a reload.
   *
   * @param {object[]} incoming rows to upsert
   * @returns {number} how many were applied
   */
  const ingest = (incoming) => {
    if (!incoming || !incoming.length) return 0;
    const revision = Date.now();
    for (const row of incoming) {
      row.revision = revision;
      built.store.set(row.id, row);
    }
    router.apply(incoming.map((row) => ({ op: 'upsert', row })));
    built.status.dropped = router.dropped || 0;
    return incoming.length;
  };

  built.load = load;
  built.ingest = ingest;

  load(rows);

  /* ---------------- the tiles, bound to the table ---------------- */

  const kpi = createKPI(panelHost, {
    /*
     * Bound to the table. The panel reads what the table currently matches and
     * follows it on its own: the date filter, an arrival and a revision all
     * reach the tiles without the host handing it anything.
     */
    grid: built.grid,
    rowKey: 'id',
    /* The fields the custom tiles and the named reading below need on each
       projected row. */
    fields: ['date', ...PAIRS.map((pair) => pair.id), ...PAIRS.map((pair) => `${pair.id}Ret`)],
    columns: 5,
    ariaLabel: 'Headline figures',
    tiles: [
      { id: 'days', label: 'Publication days in view', aggregation: 'count', format: 'number' },
      {
        id: 'latest',
        label: 'Latest EUR/USD',
        aggregation: 'custom',
        format: { type: 'number', decimals: 4 },
        compute: (tileRows) => {
          let newest = null;
          for (const row of tileRows) if (!newest || row.date > newest.date) newest = row;
          return newest && typeof newest.usd === 'number' ? newest.usd : null;
        },
      },
      {
        id: 'high',
        label: 'Strongest euro against the dollar',
        aggregation: 'max',
        field: 'usd',
        format: { type: 'number', decimals: 4 },
      },
      {
        id: 'low',
        label: 'Weakest euro against the dollar',
        aggregation: 'min',
        field: 'usd',
        format: { type: 'number', decimals: 4 },
      },
      {
        id: 'biggest',
        label: 'Biggest daily move in view',
        aggregation: 'custom',
        format: { type: 'number', decimals: 2 },
        compute: (tileRows) => {
          let worst = 0;
          for (const row of tileRows) {
            for (const pair of PAIRS) {
              const value = row[`${pair.id}Ret`];
              if (typeof value === 'number' && Math.abs(value) > Math.abs(worst)) worst = value;
            }
          }
          return worst ? Math.abs(worst) * 100 : null;
        },
      },
    ],
  });
  built.kpi = kpi;

  /**
   * Name the biggest day in view.
   *
   * The one figure that is not a tile: it is a phrase with a date and a pair in
   * it, and a tile shows a number. So it is drawn by hand, from the bound
   * panel's own rows rather than from a second walk of the table, each time the
   * panel says it has re-read the table.
   */
  const refreshNamedTile = () => {
    let best = null;
    kpi.rows.forEach((row) => {
      for (const pair of PAIRS) {
        const value = row[`${pair.id}Ret`];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        if (!best || Math.abs(value) > Math.abs(best.value)) best = { value, pair, date: row.date };
      }
    });
    if (!best) {
      namedValue.textContent = 'No data';
      namedLabel.textContent = 'Largest daily move in view';
      return;
    }
    namedValue.textContent = `${best.pair.label} ${best.value >= 0 ? '+' : ''}${(best.value * 100).toFixed(2)}%`;
    namedLabel.textContent = `Largest daily move in view, ${best.date}`;
  };
  kpi.on('change', refreshNamedTile);
  refreshNamedTile();

  /* ---------------- the charts, bound to the table ---------------- */

  /** Tear the charts down and draw them again for the current pair. */
  function drawCharts() {
    for (const chart of built.charts) {
      try {
        chart.destroy();
      } catch {}
    }
    built.charts = [];
    for (const box of chartBoxes) box.textContent = '';

    const pair = pairOf(pairId);
    const specs = [
      {
        type: 'line',
        x: 'date',
        y: pair.id,
        title: `${pair.label}, every publication day`,
        axis: { x: { labels: false }, y: pair.label },
        canvas: true,
        legend: false,
      },
      {
        type: 'line',
        x: 'date',
        y: `${pair.id}Ret`,
        title: `${pair.label}: the daily return`,
        axis: { x: { labels: false }, y: 'Log return' },
        reference: [{ value: 0 }],
        canvas: true,
        legend: false,
      },
      {
        type: 'histogram',
        y: `${pair.id}Ret`,
        buckets: 48,
        curve: true,
        title: `${pair.label}: how often a day of each size`,
        axis: { x: 'Daily log return', y: 'Days' },
        legend: false,
      },
      {
        type: 'correlogram',
        columns: PAIRS.map((entry) => `${entry.id}Ret`),
        method: 'pearson',
        values: true,
        title: 'How the four returns move together',
        legend: false,
      },
    ];

    specs.forEach((spec, index) => {
      try {
        built.charts.push(createChart({ grid: built.grid, container: chartBoxes[index], ...spec }));
      } catch (error) {
        chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
        console.error('[fx demo] chart', index, error);
      }
    });
  }

  /* ---------------- the controls, wired ---------------- */

  /** Show which pair and which range are in force. */
  function paintControls() {
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
  }

  /** Change the pair the charts and the statistics are about. */
  function setPair(id) {
    if (!PAIRS.some((pair) => pair.id === id)) return;
    pairId = id;
    built.pair = id;
    paintControls();
    drawCharts();
    if (built.statistics) built.statistics.setPair(id);
  }

  /**
   * Narrow the table to a date range.
   *
   * A named predicate on the table itself, so everything bound to the table —
   * the tiles, the four charts, the row badge and the statistics panel —
   * follows it without being told.
   */
  function setRange(id) {
    const range = RANGES.find((entry) => entry.id === id);
    if (!range) return;
    rangeId = id;
    built.range = id;
    const from = rangeFrom(range);
    built.grid.filters.where('range', from ? (row) => row.date >= from : null);
    paintControls();
    if (built.statistics) built.statistics.setRange(id);
  }

  built.setPair = setPair;
  built.setRange = setRange;
  built.drawCharts = drawCharts;
  built.rangeFrom = () => rangeFrom(RANGES.find((entry) => entry.id === rangeId));

  paintControls();
  drawCharts();

  /* ---------------- the statistics tab's refresh ---------------- */

  /** Rebuild the statistics panel, unless it has only just been built. */
  function refreshStatistics() {
    if (!built.statistics) return;
    if (statisticsJustBuilt) {
      statisticsJustBuilt = false;
      return;
    }
    built.statistics.refresh();
  }
  built.refreshStatistics = refreshStatistics;

  tabs.on('tab:changed', (event) => {
    if (event.id === 'statistics') refreshStatistics();
  });

  /* ---------------- what the masthead says ---------------- */

  /**
   * Say where the rows came from and how current they are.
   *
   * @param {object} status
   */
  function setFreshness(status) {
    const parts = [];
    parts.push(`${commas(built.grid.rows.totalCount())} publication days`);
    if (status && status.liveDays != null && status.liveDays > 0) {
      parts.push(`${commas(status.liveDays)} of them fetched live just now`);
    } else if (status && status.liveDays === 0 && meta.toppedUp) {
      parts.push('nothing new since the saved copy was taken');
    }
    if (status && status.fellBack) parts.push('the API could not be reached, so this is the saved copy alone');
    if (meta.snapshotTaken) parts.push(`saved copy taken ${meta.snapshotTaken}`);
    freshness.textContent = parts.join(' · ');
  }
  built.setFreshness = setFreshness;
  setFreshness({});

  /* The tiles hold no clock, so nothing needs a timer: a day of rates does not
     go stale between one second and the next, and the page says the date of the
     newest row it holds rather than an age that would have to tick. */

  built.destroy = () => {
    for (const chart of built.charts) {
      try {
        chart.destroy();
      } catch {}
    }
    if (built.statistics) built.statistics.destroy();
    kpi.destroy();
    tabs.destroy();
  };

  return built;
}

/** The block size the volatility analysis uses, re-exported for the checks. */
export { BLOCK_DAYS };
