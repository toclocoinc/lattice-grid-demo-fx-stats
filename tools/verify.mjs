/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the API being reachable. Beyond "it drew something", it asserts the things
 * this demo exists to show:
 *
 *   - twenty-seven years of rates load in ONE `rows.load` and the table holds
 *     every publication day the saved copy holds;
 *   - the grid's COMPUTED return column agrees with the return computed here
 *     from the rates alone;
 *   - every figure in every verdict on the Statistics tab agrees with the same
 *     figure computed a second, independent way in Node, from the raw rows the
 *     table is holding (`tools/crosscheck.mjs`, which imports nothing the page
 *     uses);
 *   - changing the pair and narrowing the dates move every analysis, and the
 *     whole cross-check passes again on the narrowed data;
 *   - nought console errors, nought page errors, and no watermark on localhost.
 *
 * It then blocks the API in the browser and opens the live page, to prove a
 * visitor gets the saved copy, and is told so, when Frankfurter cannot be
 * reached.
 *
 * `--all` also opens the page in its live top-up mode, which needs the
 * internet, so it is not part of the deployment gate.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import * as again from './crosscheck.mjs';
import { API, BLOCK_DAYS, PAIRS } from '../src/analysis.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

/* How close two computations of the same figure must be. The engine and this
   file both work in doubles over the same rows, so anything beyond rounding is
   a real disagreement. */
const TOLERANCE = 1e-9;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(
    `No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`,
  );
}

/**
 * This check talks to the browser over a WebSocket, which Node only provides as
 * a global from version 22. Say so plainly rather than failing later with an
 * unexplained missing name.
 */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

/**
 * Two numbers, computed two ways, must agree.
 *
 * Both are printed whatever happens, along with the gap between them, so a
 * passing run is as readable as a failing one.
 */
function same(label, fromPage, computed, tolerance = TOLERANCE) {
  if (typeof fromPage !== 'number' || !Number.isFinite(fromPage)) {
    check(false, `cross-check: ${label}`, `the page has no number (${fromPage})`);
    return;
  }
  if (typeof computed !== 'number' || !Number.isFinite(computed)) {
    check(false, `cross-check: ${label}`, `nothing to compare with (${computed})`);
    return;
  }
  const gap = Math.abs(fromPage - computed);
  const scale = Math.max(1, Math.abs(computed));
  check(
    gap / scale <= tolerance,
    `cross-check: ${label}`,
    `page ${fromPage}, computed ${computed}, gap ${gap.toExponential(2)}`,
  );
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'fx-demo-verify-'));
  /* A port of the operating system's choosing, so two checks running side by
     side on one machine cannot land on the same debugging socket. */
  const port = await freePort();
  /* Its own process group, so the whole browser tree can be taken down together
     rather than leaving orphaned renderers behind. */
  browser = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  /* A browser that goes away mid-run, killed from outside or crashed, would
     otherwise leave every call waiting for an answer that never comes. Fail the
     run instead of hanging it. */
  socket.onclose = () => {
    for (const { reject } of pending.values()) {
      reject(new Error('the browser went away before it answered'));
    }
    pending.clear();
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(
        message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      );
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`,
      );
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__fxDemo)', 120000, `${label} to load`);
    const state = await evaluate(
      '({ ready: window.__fxDemo.ready, error: window.__fxDemo.error || null })',
    );
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor(
      'window.__fxDemo.grid && window.__fxDemo.grid.rows.count() > 0',
      60000,
      `${label} rows`,
    );
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /** Open the Statistics tab and wait for it to have computed. */
  const openStatistics = async () => {
    await evaluate("window.__fxDemo.tabs.activate('statistics')");
    await waitFor('!!(window.__fxDemo.statistics)', 60000, 'the statistics panel');
    await waitFor('window.__fxDemo.statistics.state.passes > 0', 60000, 'the first pass');
  };

  /** Everything the checks read off the statistics panel, in one round trip. */
  const readStatistics = () =>
    evaluate(`(() => {
      const s = window.__fxDemo.statistics.state;
      return {
        rows: s.rows, pair: s.pair, range: s.range, passes: s.passes, error: s.error,
        first: s.first, last: s.last,
        verdicts: s.verdicts.map((v) => v.text),
        analyses: s.analyses,
        chartErrors: Array.from(document.querySelectorAll('.stats-card .chart-error')).map((e) => e.textContent),
        plots: Array.from(document.querySelectorAll('.stats-plot')).map((box) => {
          const paths = Array.from(box.querySelectorAll('path')).map((p) => (p.getAttribute('d') || '').trim());
          return {
            marks: box.querySelectorAll('rect,circle,path,line,polyline').length,
            canvas: box.querySelectorAll('canvas').length,
            paths: paths.length,
            emptyPaths: paths.filter((d) => !d).length,
            longestD: Math.max(0, ...paths.map((d) => d.length)),
            dataMarks: box.querySelectorAll('circle,polyline,rect').length,
          };
        }),
        cards: Array.from(document.querySelectorAll('.stats-card')).map((c) => c.dataset.analysis),
      };
    })()`);

  /** The raw rows the table is currently holding, as the check will recompute from. */
  const readRows = () =>
    evaluate(`(() => {
      const out = [];
      window.__fxDemo.grid.rows.forEach((row) => {
        if (!row || row.group || !row.data) return;
        const d = row.data;
        /* The rate, and the rate the ECB published the working day before. Both
           are data the API gave; the returns are computed from them here rather
           than read off the page. The page's own return columns are deliberately
           NOT read. */
        out.push({
          date: d.date,
          usd: d.usd, gbp: d.gbp, jpy: d.jpy, chf: d.chf,
          usdPrev: d.usdPrev, gbpPrev: d.gbpPrev, jpyPrev: d.jpyPrev, chfPrev: d.chfPrev,
        });
      });
      return out;
    })()`);

  /* =================================================================== */
  /* 1. The saved copy: the deterministic run                            */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  const savedPayload = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'rates.json'), 'utf8'));
  const savedMeta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const savedDays = Object.keys(savedPayload.rates || {});

  const snap = await evaluate(`(() => {
    const d = window.__fxDemo;
    return {
      rows: d.grid.rows.count(),
      total: d.grid.rows.totalCount(),
      columns: d.grid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.grid.licence.watermark(),
      licenceState: d.grid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      named: document.querySelector('.kpi-named-value').textContent,
      timings: d.timings,
      arrivals: d.status.arrivals,
    };
  })()`);

  check(snap.rows === savedDays.length, 'saved copy: the table holds every saved day', `${snap.rows} of ${savedDays.length}`);
  check(snap.total === savedDays.length, 'saved copy: nothing is filtered out to begin with', `${snap.total}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.columns === 9, 'saved copy: a date, four rates and four returns', `${snap.columns} columns`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  check(
    snap.arrivals === savedDays.length,
    'saved copy: the router saw the whole history as one load',
    `${snap.arrivals} rows through the router`,
  );
  check(
    snap.timings.buildMs < 15000,
    'saved copy: twenty-seven years of rates build in a sensible time',
    `${snap.timings.buildMs} ms`,
  );
  await shoot('rates');

  /* The charts must have plotted values, not empty axes. */
  /*
   * What a chart actually DREW, not merely what it produced.
   *
   * The first version of this check counted every `rect,circle,path,line,text`
   * in the box and asked for more than two. Both line charts on the published
   * page were blank and it passed anyway: the two axis rectangles and six tick
   * labels cleared the bar on their own, and the single `<path>` the line
   * should have been was present with an EMPTY `d`. `chart.data()` was no help
   * either — it reported 380 points each carrying a `y`, because the binding
   * was fine and only the rendering was empty.
   *
   * So geometry is measured now, separately from furniture: the marks a chart
   * draws its DATA with. For a path-drawn chart that is the length of the `d`
   * attribute, which is nought on an empty path and thousands of characters on
   * a real line.
   */
  const chartData = await evaluate(`Array.from(document.querySelectorAll('.chart-box')).map((box, i) => {
    const chart = window.__fxDemo.charts[i];
    const paths = Array.from(box.querySelectorAll('path')).map((p) => (p.getAttribute('d') || '').trim());
    /* The marks a chart draws its data with, as opposed to the two axis
       rectangles: circles, polylines and the cell/bar rectangles. The axis
       frame is at most a couple of rects, so anything beyond that is data. */
    const dataMarks = box.querySelectorAll('circle,polyline,rect').length;
    const info = {
      i,
      type: (window.__fxDemo.chartTypes || [])[i] || null,
      marks: box.querySelectorAll('rect,circle,path,line,polyline,text').length,
      canvas: box.querySelectorAll('canvas').length,
      paths: paths.length,
      emptyPaths: paths.filter((d) => !d).length,
      longestD: Math.max(0, ...paths.map((d) => d.length)),
      dataMarks,
    };
    try {
      const d = chart.data();
      const series = d.series || [];
      return { ...info, kind: d.kind, series: series.length,
        points: series.reduce((a, s) => a + (s.points || []).length, 0),
        withValue: series.reduce((a, s) => a + (s.points || []).filter((p) => p && p.y != null).length, 0) };
    } catch (e) { return { ...info, error: String(e.message) }; }
  })`);

  /* A path this short is a zero line or a tick, not a series of 7,000 days. */
  const REAL_GEOMETRY = 64;

  for (const c of chartData) {
    check(!c.error, `saved copy: chart ${c.i} reported its data`, c.error);
    if (c.error) continue;
    check(c.points > 0, `saved copy: chart ${c.i} bound points`, `${c.points} points`);
    /* A correlogram is a matrix rather than a series of measures, so its points
       carry no `y`; it draws its data as cell rectangles instead of a path. */
    if (c.type === 'correlogram' || c.kind === 'matrix' || c.series === 0 || c.withValue === 0) {
      check(c.dataMarks > 4, `saved copy: chart ${c.i} drew data marks`, `${c.dataMarks} data marks, type ${c.type}`);
      continue;
    }
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} carry a measure`);
    check(c.emptyPaths === 0, `saved copy: chart ${c.i} left no empty path behind`, `${c.emptyPaths} of ${c.paths} paths have no d`);
    check(
      c.longestD >= REAL_GEOMETRY || c.dataMarks > 2 || c.canvas > 0,
      `saved copy: chart ${c.i} drew real geometry for its ${c.withValue} values`,
      `longest path d ${c.longestD} chars, ${c.dataMarks} data marks, ${c.canvas} canvas`,
    );
    /*
     * A time series must be on a continuous axis. A band scale of thousands of
     * categories is what produced the empty line in the first place, and it
     * also emits one tick label per row — 7,099 text nodes on this data. A
     * histogram reports `category` too, because it bins its own measure and has
     * no x column, so the rule is only for the charts bound to an x column.
     */
    if (['line', 'area', 'step', 'scatter'].includes(c.type)) {
      check(
        c.kind !== 'category',
        `saved copy: chart ${c.i} (${c.type}) is on a continuous axis, not a band scale of ${c.points} categories`,
        `kind ${c.kind}, ${c.points} points`,
      );
    }
  }

  /* -------- the computed return column against the rates -------- */

  /*
   * The table's return columns are computed BY THE GRID from the rate and the
   * rate the day before. Here the same returns are computed from the rates
   * alone and the two are compared through the statistics surface, which reads
   * a computed column directly.
   */
  const pageRows = await readRows();
  check(pageRows.length === savedDays.length, 'the rows read back match the table', `${pageRows.length}`);

  for (const pair of PAIRS) {
    const computed = again.returnsOf(pageRows, pair.id).map((row) => row.ret);
    const fromGrid = await evaluate(`(() => {
      const s = window.__fxDemo.grid.statistics;
      return {
        /* count counts rows; countValues counts the ones that carry a value,
           which is the number the first day of the series is missing from. */
        rows: s.reduce('${pair.id}Ret', 'count'),
        values: s.reduce('${pair.id}Ret', 'countValues'),
        stddev: s.reduce('${pair.id}Ret', 'stddev'),
        avg: s.reduce('${pair.id}Ret', 'avg'),
        jb: s.reduce('${pair.id}Ret', 'jarqueBera'),
      };
    })()`);
    check(
      fromGrid.values === computed.length,
      `${pair.label}: the computed column holds a return for every day but the first`,
      `${fromGrid.values} values over ${fromGrid.rows} rows, ${computed.length} computed`,
    );
    same(`${pair.label} computed column: standard deviation`, fromGrid.stddev, again.stddev(computed));
    same(`${pair.label} computed column: mean`, fromGrid.avg, again.mean(computed));
    same(`${pair.label} computed column: Jarque-Bera`, fromGrid.jb, again.jarqueBera(computed));
  }

  /* =================================================================== */
  /* 2. The Statistics tab, cross-checked figure by figure                */
  /* =================================================================== */

  /**
   * Cross-check every verdict figure against an independent computation from
   * the rows the table is holding.
   *
   * @param {string} tag what to call this pass in the log
   * @param {object} state what the panel reported
   * @param {object[]} rows the raw rows the table holds
   */
  function crossCheck(tag, state, rows) {
    const pair = state.pair;
    const label = PAIRS.find((p) => p.id === pair).label;
    const a = state.analyses;

    check(state.error === null, `${tag}: the statistics tab computed without error`, String(state.error));
    check(state.rows === rows.length, `${tag}: the panel read every row the table holds`, `${state.rows} of ${rows.length}`);
    check(state.chartErrors.length === 0, `${tag}: no analysis failed to draw`, state.chartErrors.slice(0, 2).join(' | '));
    check(state.cards.length === 6, `${tag}: all six analyses were built`, state.cards.join(', '));
    check(state.verdicts.length >= 6, `${tag}: the verdict panel wrote its sentences`, `${state.verdicts.length}`);
    for (const [i, plot] of state.plots.entries()) {
      /* Geometry, not furniture — the same distinction the chart-box check
         makes, for the same reason: axis ticks and labels are not a drawing of
         the data. Every plot here is a path chart or a mark chart, so one of
         the two must be real. */
      check(
        plot.longestD >= 64 || plot.dataMarks > 2 || plot.canvas > 0,
        `${tag}: plot ${i} drew real geometry`,
        `longest path d ${plot.longestD} chars, ${plot.dataMarks} data marks, ${plot.canvas} canvas`,
      );
      check(plot.emptyPaths === 0, `${tag}: plot ${i} left no empty path behind`, `${plot.emptyPaths} of ${plot.paths}`);
    }

    /* -------- 1: the distribution -------- */
    const d = again.distribution(rows, pair);
    check(a.distribution && a.distribution.ok, `${tag}: the distribution analysis ran`, a.distribution && a.distribution.reason);
    if (a.distribution && a.distribution.ok) {
      same(`${tag} ${label}: days with a return`, a.distribution.n, d.n);
      same(`${tag} ${label}: mean daily return`, a.distribution.mean, d.mean);
      same(`${tag} ${label}: interval lower bound`, a.distribution.lower, d.lower);
      same(`${tag} ${label}: interval upper bound`, a.distribution.upper, d.upper);
      same(`${tag} ${label}: median daily return`, a.distribution.median, d.median);
      same(`${tag} ${label}: standard deviation`, a.distribution.sd, d.sd);
      same(`${tag} ${label}: skewness`, a.distribution.skewness, d.skewness);
      same(`${tag} ${label}: excess kurtosis`, a.distribution.kurtosis, d.kurtosis);
      same(`${tag} ${label}: Jarque-Bera`, a.distribution.jarqueBera, d.jarqueBera);
      same(`${tag} ${label}: 1% tail`, a.distribution.q01, d.q01);
      same(`${tag} ${label}: 99% tail`, a.distribution.q99, d.q99);
      same(`${tag} ${label}: the normal model's 1% point`, a.distribution.normalLow, d.normalLow);
      same(`${tag} ${label}: the normal model's 99% point`, a.distribution.normalHigh, d.normalHigh);
      check(
        a.distribution.notNormal === a.distribution.jarqueBera > 5.99,
        `${tag}: the normality verdict follows its own statistic`,
        `JB ${a.distribution.jarqueBera}, verdict ${a.distribution.notNormal}`,
      );
    }

    /* -------- 2: volatility -------- */
    const v = again.volatility(rows, pair, BLOCK_DAYS);
    check(a.volatility && a.volatility.ok, `${tag}: the volatility analysis ran`, a.volatility && a.volatility.reason);
    if (a.volatility && a.volatility.ok) {
      same(`${tag} ${label}: runs charted`, a.volatility.readings, v.readings);
      same(`${tag} ${label}: control centre line`, a.volatility.centre, v.centre);
      same(`${tag} ${label}: sigma from the moving range`, a.volatility.sigma, v.sigma);
      same(`${tag} ${label}: upper control limit`, a.volatility.upper, v.upper);
      same(`${tag} ${label}: lower control limit`, a.volatility.lower, v.lower);
      same(`${tag} ${label}: readings beyond three sigma`, a.volatility.rule1, v.rule1);
      same(`${tag} ${label}: nine-in-a-row breaks`, a.volatility.rule2, v.rule2);
      same(`${tag} ${label}: readings inside the limits`, a.volatility.inControl, v.inControl);
      same(`${tag} ${label}: the wildest run's spread`, a.volatility.highest.sd, v.highest.sd);
      check(
        a.volatility.highest.from === v.highest.from && a.volatility.highest.to === v.highest.to,
        `${tag} ${label}: the wildest run is the same run`,
        `page ${a.volatility.highest.from}..${a.volatility.highest.to}, computed ${v.highest.from}..${v.highest.to}`,
      );
      same(`${tag} ${label}: the calmest run's spread`, a.volatility.lowest.sd, v.lowest.sd);
      check(
        a.volatility.sds.length === v.sds.length &&
          a.volatility.sds.every((value, i) => Math.abs(value - v.sds[i]) <= TOLERANCE),
        `${tag} ${label}: every run's spread agrees`,
        `${v.sds.length} runs`,
      );
    }

    /* -------- 3: autocorrelation -------- */
    const c = again.autocorrelation(rows, pair, 20);
    check(a.autocorrelation && a.autocorrelation.ok, `${tag}: the autocorrelation analysis ran`, a.autocorrelation && a.autocorrelation.reason);
    if (a.autocorrelation && a.autocorrelation.ok) {
      same(`${tag} ${label}: series length`, a.autocorrelation.n, c.n);
      same(`${tag} ${label}: white-noise band`, a.autocorrelation.bound, c.bound);
      for (const lag of [1, 2, 5, 10, 20]) {
        same(`${tag} ${label}: return autocorrelation at lag ${lag}`, a.autocorrelation.returnAcf[lag], c.returnAcf[lag]);
        same(`${tag} ${label}: size autocorrelation at lag ${lag}`, a.autocorrelation.sizeAcf[lag], c.sizeAcf[lag]);
      }
      same(`${tag} ${label}: return lags outside the band`, a.autocorrelation.returnOutside, c.returnOutside);
      same(`${tag} ${label}: size lags outside the band`, a.autocorrelation.sizeOutside, c.sizeOutside);
    }

    /* -------- 4: stationarity -------- */
    check(a.stationarity && a.stationarity.ok, `${tag}: the stationarity analysis ran`, a.stationarity && a.stationarity.reason);
    if (a.stationarity && a.stationarity.ok) {
      /* The lag orders are the engine's choice; the arithmetic at those lags is
         recomputed here from scratch. */
      const s = again.stationarity(rows, pair, a.stationarity.level.usedLag, a.stationarity.returns.usedLag);
      same(`${tag} ${label}: ADF on the rate`, a.stationarity.level.statistic, s.level.statistic, 1e-6);
      same(`${tag} ${label}: ADF observations on the rate`, a.stationarity.level.nobs, s.level.nobs);
      same(`${tag} ${label}: ADF on the return`, a.stationarity.returns.statistic, s.returns.statistic, 1e-6);
      same(`${tag} ${label}: ADF observations on the return`, a.stationarity.returns.nobs, s.returns.nobs);
      check(
        a.stationarity.level.stationary === a.stationarity.level.statistic < a.stationarity.level.critical5,
        `${tag}: the rate's verdict follows its own statistic and critical value`,
        `${a.stationarity.level.statistic} against ${a.stationarity.level.critical5}`,
      );
      check(
        a.stationarity.returns.stationary === a.stationarity.returns.statistic < a.stationarity.returns.critical5,
        `${tag}: the return's verdict follows its own statistic and critical value`,
        `${a.stationarity.returns.statistic} against ${a.stationarity.returns.critical5}`,
      );
    }

    /* -------- 5: the cross-pair regression -------- */
    const x = again.crossPair(rows, 0.95);
    check(a.crossPair && a.crossPair.ok, `${tag}: the cross-pair regression ran`, a.crossPair && a.crossPair.reason);
    if (a.crossPair && a.crossPair.ok) {
      same(`${tag}: days fitted`, a.crossPair.n, x.n);
      same(`${tag}: slope of sterling on the dollar`, a.crossPair.slope, x.slope);
      same(`${tag}: slope interval, lower`, a.crossPair.lower, x.lower, 1e-7);
      same(`${tag}: slope interval, upper`, a.crossPair.upper, x.upper, 1e-7);
      same(`${tag}: standard error of the slope`, a.crossPair.stdError, x.stdError);
      same(`${tag}: R² of the fit`, a.crossPair.r2, x.r2);
      same(`${tag}: Pearson correlation`, a.crossPair.pearson, x.pearson);
      check(
        a.crossPair.bandPoints === a.crossPair.n,
        'the regression chart got a confidence band covering every point',
        `${a.crossPair.bandPoints} band points for ${a.crossPair.n} days`,
      );
    }

    /* -------- 6: the anomalies -------- */
    const an = again.anomalies(rows, pair, 3.5, 10);
    check(a.anomalies && a.anomalies.ok, `${tag}: the anomaly scan ran`, a.anomalies && a.anomalies.reason);
    if (a.anomalies && a.anomalies.ok) {
      same(`${tag} ${label}: days scored`, a.anomalies.n, an.n);
      same(`${tag} ${label}: days flagged`, a.anomalies.flagged, an.flagged);
      check(
        a.anomalies.worst.length === an.worst.length,
        `${tag} ${label}: the same number of days are listed`,
        `${a.anomalies.worst.length}`,
      );
      for (const [i, row] of a.anomalies.worst.entries()) {
        const mine = an.worst[i];
        if (!mine) break;
        check(row.date === mine.date, `${tag} ${label}: anomaly ${i + 1} is the same day`, `page ${row.date}, computed ${mine.date}`);
        same(`${tag} ${label}: anomaly ${i + 1} return`, row.ret, mine.ret);
        same(`${tag} ${label}: anomaly ${i + 1} modified z`, row.score, mine.score);
      }
    }
  }

  await openStatistics();
  const wide = await readStatistics();
  const wideRows = await readRows();
  crossCheck('all of it', wide, wideRows);
  noErrors('the statistics tab');
  await shoot('statistics');

  /* =================================================================== */
  /* 3. Changing the pair must move everything                            */
  /* =================================================================== */

  /* The franc, because 15 January 2015 is the single most extreme reading in
     the whole dataset and it must reach every analysis. */
  await evaluate("window.__fxDemo.setPair('chf')");
  await waitFor("window.__fxDemo.statistics.state.pair === 'chf'", 60000, 'the franc');
  const franc = await readStatistics();
  const francRows = await readRows();
  crossCheck('the franc', franc, francRows);

  check(franc.rows === wide.rows, 'changing the pair does not change which rows are in view', `${franc.rows}`);
  check(
    franc.analyses.distribution.kurtosis > wide.analyses.distribution.kurtosis,
    'the franc has fatter tails than the dollar, by a distance',
    `franc ${franc.analyses.distribution.kurtosis}, dollar ${wide.analyses.distribution.kurtosis}`,
  );
  const unpeg = franc.analyses.anomalies.worst[0];
  check(unpeg && unpeg.date === '2015-01-15', 'the franc’s biggest day is the day the floor went', unpeg && unpeg.date);
  check(
    unpeg && unpeg.note && /Swiss National Bank/.test(unpeg.note),
    'and the page says what happened on it',
    unpeg && unpeg.note,
  );
  const moved = franc.verdicts.filter((text, i) => text !== wide.verdicts[i]).length;
  check(moved >= 5, 'changing the pair rewrites the verdicts', `${moved} of ${wide.verdicts.length} changed`);

  /* =================================================================== */
  /* 4. Narrowing the dates must move everything again                    */
  /* =================================================================== */

  await evaluate("window.__fxDemo.setPair('usd')");
  await waitFor("window.__fxDemo.statistics.state.pair === 'usd'", 60000, 'the dollar again');
  await evaluate("window.__fxDemo.setRange('modern')");
  await waitFor("window.__fxDemo.statistics.state.range === 'modern'", 60000, 'the narrowed range');

  const narrow = await readStatistics();
  const narrowRows = await readRows();
  crossCheck('since 2015', narrow, narrowRows);

  check(narrow.rows < wide.rows, 'the date filter narrows the table', `${wide.rows} -> ${narrow.rows}`);
  check(narrow.first >= '2015-01-01', 'every remaining row is in the range', `oldest ${narrow.first}`);
  check(
    narrow.analyses.distribution.n < wide.analyses.distribution.n,
    'the distribution is computed over fewer days',
    `${wide.analyses.distribution.n} -> ${narrow.analyses.distribution.n}`,
  );
  check(
    narrow.analyses.volatility.readings < wide.analyses.volatility.readings,
    'there are fewer runs on the control chart',
    `${wide.analyses.volatility.readings} -> ${narrow.analyses.volatility.readings}`,
  );
  check(
    narrow.analyses.crossPair.n < wide.analyses.crossPair.n,
    'the regression is fitted over fewer days',
    `${wide.analyses.crossPair.n} -> ${narrow.analyses.crossPair.n}`,
  );
  check(
    narrow.analyses.stationarity.returns.stationary,
    'the return is still stationary on the narrowed window',
    `ADF ${narrow.analyses.stationarity.returns.statistic}`,
  );
  const narrowMoved = narrow.verdicts.filter((text, i) => text !== wide.verdicts[i]).length;
  check(narrowMoved >= 5, 'narrowing the dates rewrites the verdicts', `${narrowMoved} of ${wide.verdicts.length} changed`);

  /* The tiles are bound to the same table, so they must have moved too. */
  const narrowTiles = await evaluate(
    'Object.fromEntries(window.__fxDemo.kpi.tiles().map((t) => [t.id, t.value]))',
  );
  check(narrowTiles.days === narrow.rows, 'the bound tiles followed the filter', `${narrowTiles.days} days`);
  check(
    narrowTiles.days < snap.tiles.days,
    'the day count tile fell with the filter',
    `${snap.tiles.days} -> ${narrowTiles.days}`,
  );
  await shoot('narrowed');

  await evaluate("window.__fxDemo.setRange('all')");
  await waitFor("window.__fxDemo.statistics.state.range === 'all'", 60000, 'the range put back');
  const restored = await evaluate('window.__fxDemo.grid.rows.count()');
  check(restored === wide.rows, 'removing the filter restores the table', `${restored} of ${wide.rows}`);
  noErrors('the filter passes');

  /* =================================================================== */
  /* 5. The fallback: the API blocked                                     */
  /* =================================================================== */

  await call('Network.setBlockedURLs', { urls: ['*api.frankfurter.dev*'] });
  await open(`${origin}/index.html`, 'the API blocked');
  const blocked = await evaluate(`(() => {
    const d = window.__fxDemo;
    return {
      rows: d.grid.rows.count(),
      fellBack: d.timings.fellBack,
      liveDays: d.timings.liveDays,
      freshness: document.querySelector('.freshness').textContent,
      pill: document.querySelector('.pill').textContent,
    };
  })()`);
  check(blocked.rows === savedDays.length, 'a blocked API still shows the whole saved copy', `${blocked.rows}`);
  check(blocked.fellBack === true, 'the page knows the top-up did not happen');
  check(
    /could not be reached/.test(blocked.freshness),
    'and says so under the masthead rather than pretending',
    blocked.freshness,
  );
  check(pageErrors.length === 0, 'a blocked API raises no page errors', pageErrors.slice(0, 2).join(' | '));
  await shoot('blocked');
  await call('Network.setBlockedURLs', { urls: [] });

  /* =================================================================== */
  /* 6. The saved copy is the API's own answer                            */
  /* =================================================================== */

  check(
    savedMeta.days === savedDays.length,
    'the saved copy’s meta agrees with the saved copy',
    `${savedMeta.days} against ${savedDays.length}`,
  );
  check(savedPayload.base === 'EUR', 'the saved copy is quoted against the euro', savedPayload.base);
  check(
    savedDays[0] === '1999-01-04' || savedMeta.oldest === '1999-01-04',
    'it starts on the euro’s first day',
    savedMeta.oldest,
  );
  check(savedMeta.url === API.history('1999-01-04'), 'and it records the call that produced it', savedMeta.url);
  const holes = Object.values(savedPayload.rates).filter(
    (day) => PAIRS.some((p) => typeof day[p.symbol] !== 'number'),
  ).length;
  check(holes === savedMeta.incompleteDays, 'the meta counts the incomplete days correctly', `${holes}`);

  /* =================================================================== */
  /* 7. Live, only with --all                                             */
  /* =================================================================== */

  if (all) {
    await open(`${origin}/index.html`, 'live top-up');
    const live = await evaluate(`(() => {
      const d = window.__fxDemo;
      return {
        rows: d.grid.rows.count(),
        liveDays: d.timings.liveDays,
        fellBack: d.timings.fellBack,
        toppedUp: d.timings.toppedUp,
        freshness: document.querySelector('.freshness').textContent,
        topupDays: d.meta.topupDays,
      };
    })()`);
    check(live.fellBack === false, 'the live top-up reached the API', live.freshness);
    check(live.toppedUp === true, 'and it went through the router rather than a reload');
    check(live.rows >= savedDays.length, 'the table holds at least everything the saved copy holds', `${live.rows}`);
    check(live.topupDays >= 1, 'the top-up overlapped the saved copy by at least its last day', `${live.topupDays} days`);
    noErrors('live');
    await shoot('live');

    await openStatistics();
    const liveStats = await readStatistics();
    const liveRows = await readRows();
    crossCheck('live', liveStats, liveRows);
  }

  console.log('');
} catch (error) {
  failures.push(`the check itself failed: ${error.message}`);
  console.error(error);
} finally {
  /* Everything this run started is taken down, and nothing else is: the
     process group is the browser tree this script spawned, so a check running
     beside it on the same machine is untouched. */
  if (browserPid) {
    try {
      process.kill(-browserPid, 'SIGKILL');
    } catch {}
    try {
      process.kill(browserPid, 'SIGKILL');
    } catch {}
  }
  if (server) server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await sleep(300);
}

for (const note of notes) console.log(note);
console.log('');
if (failures.length) {
  console.log(`${failures.length} of ${notes.length} checks failed:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(`All ${notes.length} checks passed${all ? ' (including the live ones)' : ''}.`);
