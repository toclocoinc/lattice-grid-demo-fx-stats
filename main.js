/**
 * The entry point: read the saved copy, draw everything from it, then ask the
 * API for the days published since and put those through the router.
 *
 * That order is the point of the page. The saved copy is twenty-seven years of
 * rates and arrives in one `rows.load`; the top-up is a handful of days and
 * arrives as a change. A demo that fetched the whole history live would be
 * slower, would break when the API is unreachable, and would not show the
 * difference between loading a dataset and receiving an update.
 *
 * Three ways to open the page:
 *
 *   (nothing)            the saved copy, then the days since, live
 *   ?source=snapshot     the saved copy alone, no network at all
 *   ?source=live         the whole history from the API, ignoring the copy
 */

import { createGrid, createHeadlessGrid, setLicence } from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import { createKPI } from './node_modules/@toclocoinc/lattice-grid/modules/kpi.esm.min.js';
import { createTabs } from './node_modules/@toclocoinc/lattice-grid/modules/tabs.esm.min.js';
import { createDataRouter } from './node_modules/@toclocoinc/lattice-grid/modules/data-router.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { buildDashboard } from './src/dashboard.js';
import { restampReturns, rowsFrom } from './src/analysis.js';
import { fetchHistory, fetchSince, loadSnapshot, newestDate } from './src/frankfurter.js';

/* Applied before anything is drawn, because a grid that already exists keeps
   whatever licence was in force when it was built. */
setLicence(DEMO_LICENCE);

const TITLE = 'Twenty-seven years of exchange rates, and what the numbers say';

const root = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const mode = params.get('source') === 'snapshot' ? 'snapshot' : params.get('source') === 'live' ? 'live' : 'topup';

/** Draw the waiting state, and return a function that updates its message. */
function showProgress(first) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const title = document.createElement('h1');
  title.textContent = TITLE;
  const message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = first;
  const bar = document.createElement('div');
  bar.className = 'loading-bar';
  const fill = document.createElement('div');
  fill.className = 'loading-fill';
  bar.append(fill);
  panel.append(title, message, bar);
  root.append(panel);
  return (text, fraction) => {
    message.textContent = text;
    fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
  };
}

/** Say what went wrong, in words a reader can act on. */
function showError(error) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const title = document.createElement('h1');
  title.textContent = 'The exchange rates could not be loaded';
  const message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = String((error && error.message) || error);
  const hint = document.createElement('p');
  hint.className = 'loading-message';
  hint.textContent = 'You can open the same dashboard from the saved copy by adding ?source=snapshot to the address.';
  panel.append(title, message, hint);
  root.append(panel);
  console.error('[fx demo]', error);
}

async function start() {
  const started = performance.now();
  try {
    let rows;
    let meta;

    if (mode === 'live') {
      const update = showProgress('Reading the whole history from the Frankfurter API...');
      const history = await fetchHistory();
      rows = history.rows;
      meta = { live: true, fetchedAt: new Date().toISOString(), url: history.url, days: rows.length };
      update('Building the dashboard...', 1);
    } else {
      const update = showProgress('Reading the saved copy...');
      const saved = await loadSnapshot();
      rows = saved.rows;
      meta = { ...saved.meta, snapshotTaken: (saved.meta.fetchedAt || '').slice(0, 10) };
      update('Building the dashboard...', 1);
    }

    const fetched = performance.now();

    const built = buildDashboard({
      root,
      createGrid,
      createChart,
      createKPI,
      createTabs,
      createDataRouter,
      createHeadlessGrid,
      rows,
      meta,
    });

    const finished = performance.now();

    /*
     * The top-up. It happens after the dashboard exists, so the page is usable
     * from the first paint and the later days arrive on a table already
     * drawn — which is the behaviour a real deployment wants, and also the
     * behaviour that proves the router is doing something.
     */
    let liveDays = 0;
    let fellBack = false;
    let toppedUp = false;
    if (mode === 'topup') {
      const lastSaved = newestDate(rows);
      try {
        const since = await fetchSince(lastSaved);
        const fresh = rowsFrom(since.payload);
        /*
         * The top-up overlaps the saved copy by one day on purpose, so the
         * first new day has the day before it to be measured against. The
         * returns are re-stamped over the whole store in date order and only
         * the rows that actually changed go through the router.
         */
        const touched = fresh.map((row) => row.date);
        for (const row of fresh) {
          const existing = built.store.get(row.id);
          built.store.set(row.id, existing ? { ...existing, ...row } : row);
        }
        const changed = restampReturns(built.store, touched);
        liveDays = built.ingest(changed);
        toppedUp = true;
        built.meta.topupUrl = since.url;
        built.meta.topupDays = since.days.length;
      } catch (error) {
        /* The API is out of our hands, so a bad day for it should not be a
           broken page here. The saved copy shows the whole dashboard and the
           masthead says plainly that is what you are looking at. */
        console.warn('[fx demo] the live top-up failed, showing the saved copy alone:', error);
        fellBack = true;
      }
      built.meta.toppedUp = toppedUp;
      built.setFreshness({ liveDays, fellBack });
    }

    const timings = {
      mode,
      fellBack,
      toppedUp,
      liveDays,
      rows: built.grid.rows.totalCount(),
      loaded: rows.length,
      fetchMs: Math.round(fetched - started),
      buildMs: Math.round(finished - fetched),
      totalMs: Math.round(performance.now() - started),
    };

    /* Kept by reference, not copied: the statistics panel is only created when
       its tab is first opened, and a copy taken now would never see it. */
    window.__fxDemo = Object.assign(built, { meta: built.meta, timings, ready: true });
    console.log('[fx demo] ready', timings);
  } catch (error) {
    window.__fxDemo = { ready: false, error: String((error && error.message) || error) };
    showError(error);
  }
}

start();
