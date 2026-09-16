# Twenty-seven years of exchange rates, and what the numbers say

Every euro reference rate the European Central Bank has published since the euro began — 7,094 working days from 4 January 1999 — in a Lattice Grid, read from the Frankfurter API in the browser with no server in the middle. And then a Statistics tab that puts the grid's statistics engine to work on the same rows and writes out what it finds in plain English.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-fx-stats/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| This demo | [toclocoinc/lattice-grid-demo-fx-stats](https://github.com/toclocoinc/lattice-grid-demo-fx-stats) |
| The earthquake statistics edition | [toclocoinc/lattice-grid-demo-earthquakes-stats](https://github.com/toclocoinc/lattice-grid-demo-earthquakes-stats) &nbsp;·&nbsp; [running](https://toclocoinc.github.io/lattice-grid-demo-earthquakes-stats/) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

## The point

A grid that can hold a million rows is a table. A grid that can tell you what is in them is something else.

Everything on the Statistics tab is a figure the grid produced, and every figure is shown with the call that produced it. Nothing on the page works out a mean, a spread, a slope, a control limit, an autocorrelation or an outlier by hand and prints it beside the grid's charts — that would prove nothing. The verification (`npm run verify`) exists to hold that line: it reads the raw rates out of the table, computes all of it a second and completely independent way in Node, and insists the two agree to the last significant figure. At the time of writing that is 383 checks, and the gap it prints for each cross-checked figure is `0.00e+0`.

Currencies are a good subject for this. Everyone already believes six things about a daily exchange rate — that it is roughly normal, that yesterday tells you nothing about tomorrow, that a rate drifts rather than reverting, that pairs sharing a leg move together — and a statistics engine can check every one of them against twenty-seven years of the real thing in under a second. One of those beliefs turns out to be badly wrong, one is exactly right, and the difference between the two is the most useful thing on the page.

## The six analyses

Each one runs over whatever the table currently matches. Change the pair, or narrow the dates to "Since 2015", and all six are recomputed and all seven verdicts are rewritten.

The figures quoted below are EUR/USD over the whole history, as the saved copy stood when this was written.

### 1. What shape is a day?

Draw the returns, put a density curve over them, plot them against a normal, and ask Jarque-Bera what it thinks. What matters is not the middle, which always looks fine, but the tails.

| What | Which grid call |
| --- | --- |
| The mean and its 95% interval | `grid.statistics.interval('ret', { kind: 'mean', confidence: 0.95 })` |
| The spread, the shape and the test | `grid.statistics.reduce('ret', 'stddev' \| 'skewness' \| 'kurtosis' \| 'jarqueBera' \| 'median')` |
| The 1% and 99% points | `grid.statistics.weightedQuantile('ret', 'one', 0.01 \| 0.99)` — see finding F-FX-2 |
| The shape | a `histogram` with `curve: true` — the bars, and the grid's kernel density estimate over them, which has no bin edges and so says which part of the shape is the data's |
| How far from normal | a `qq` chart |

**The verdict.** Jarque-Bera is **3,236** against a cut of 5.99, and the excess kurtosis is **3.31** where a normal's is nought. One day in a hundred EUR/USD falls more than **1.55%** or rises more than **1.53%**; a normal with the same mean and the same standard deviation of 0.581% would put those two days at **1.35%**. The real tails are about 1.14 times as far out as the model's — and on the franc, where the 2015 unpegging sits, the excess kurtosis is **361** and Jarque-Bera is **38.6 million**.

The normal being compared against is stated as figures rather than drawn over the histogram, because there is no way to overlay a named reference distribution on one. That is finding F-FX-3 below, and nothing is drawn by hand to fill the gap. The 2.3263 in "mean − 2.3263 σ" is a constant of the normal distribution, labelled as the model everywhere it appears; it is not a reading off this data.

### 2. Is the spread itself steady?

Divide the days into runs of twenty — about a trading month — measure the standard deviation of each run, and put the result on a control chart. Its limits come from the month-to-month jump rather than the overall spread, so a shift cannot widen the limits that are meant to catch it.

| What | Which grid call |
| --- | --- |
| The spread of each run | a derived grid, `source: { mode: 'derived', groupBy: 'block', select: { sd: { of: 'ret', fn: 'stddev' } } }` |
| The centre line, sigma and the limits | `grid.statistics.capability('sd', { lower: 0, rules: 'nelson' }).limits` |
| The rule breaks | the same call's `violations`, each with its rule number and description; the Western Electric count comes from the same call with `rules: 'westernElectric'` |
| The chart | a `control` chart, which draws the limits and marks the breaks |

**The verdict.** Over **354** runs the centre line sits at **0.544%** a day with limits of 0.204% to 0.884%, and **321** readings break a Nelson rule — **21** beyond three sigma and **100** of them nine or more in a row on one side of the line. Those long one-sided runs are the finding rather than a failure of the chart: quiet months come after quiet months and wild months after wild ones. Volatility clusters.

The runs do not overlap, and that is deliberate twice over. A rolling twenty-day window is the usual way to draw this and it is **not reachable from the public API** — finding F-FX-1 — so it is not worked around. It is also the worse chart: consecutive overlapping windows share nineteen days in twenty, so the points would be autocorrelated by construction and every control rule about runs and trends would fire on the overlap rather than on the market.

### 3. Is tomorrow readable from today?

Run the autocorrelation twice on the same days: once on the return, which is direction and size together, and once on the size with the direction thrown away.

| What | Which grid call |
| --- | --- |
| Both series, out to twenty lags | `grid.statistics.acf({ of: 'ret' \| 'abs', orderBy: 'seq', maxlag: 20 })` |
| The white-noise band | the same result's `bounds`, the ±1.96/√n approximation, which the result stamps `approximate: true` |
| The chart | a `bar` chart of one row per lag per series, split by `series`, with the band as `reference` lines — which is what the engine's own documentation says to do with these arrays |

**The verdict.** Of twenty lags, **3** of the return's clear the ±0.0233 band and lag 1 is **−0.0066**, indistinguishable from nought; under pure chance one lag in twenty would fall outside anyway. The size of the return is a different series entirely: **20 of 20** lags clear the band, lag 1 is **0.120** and lag 20 is still **0.120** — it has not decayed at all over a trading month. Which way it moves tomorrow is not readable from today. How far it moves is. That is the same fact analysis 2 found from the other end, and it is why every volatility model that has ever been used exists.

### 4. Does the rate have a level to come back to?

The Augmented Dickey-Fuller test, on the rate and then on the return.

| What | Which grid call |
| --- | --- |
| Both tests | `grid.statistics.adf({ of: 'rate' \| 'ret', orderBy: 'seq' })` |
| The statistic, the lag AIC chose, the observations | `.statistic`, `.usedLag`, `.nobs` |
| MacKinnon's critical values and the verdict | `.criticalValues`, `.stationary`, `.verdict` |

**The verdict.** The EUR/USD rate is **non-stationary**: ADF is **−1.92** against −3.41 at 5%, so the null of a unit root is not rejected — it wanders, with no level it is obliged to return to. Difference it once, which is what a daily return is, and ADF becomes **−24.23**: **stationary**, emphatically. That single fact is why serious currency analysis is done on returns rather than rates, and here it is a result rather than a convention.

The p-value is interpolated across the critical-value ladder rather than taken from MacKinnon's response surface, and the result says so in `pApproximate`. The statistic and the critical values are the readings to quote.

### 5. How much of sterling's day is the dollar's?

EUR/GBP and EUR/USD share a leg, so they are not independent. Regress one on the other.

| What | Which grid call |
| --- | --- |
| The fit, with everything | `grid.statistics.regressionModel({ predictors: ['usdRet'], response: 'gbpRet', confidence: 0.95 })` |
| The slope and its interval | the `usdRet` coefficient's `estimate`, `lower`, `upper` and `stdError` |
| Whether the residuals fan out | the same model's `heteroscedasticity` — a Breusch-Pagan flag |
| Two correlations | `grid.statistics.correlation(a, b)` and `.spearman(a, b)` |
| The chart | a `scatter` with `fit: true` and `band: model.band` — the ribbon is the model's own pointwise interval, not a second slope drawn here |

**The verdict.** A one per cent day in EUR/USD comes with a **0.347** per cent day in EUR/GBP, and the fit puts that slope between **0.330** and **0.364** over 7,093 days. The interval clears nought and sits well below one, so the two move together and sterling moves less than the dollar does — it is nearer the euro. But the line accounts for only **17.8%** of sterling: 82.2% of what EUR/GBP did on these days had nothing to do with the dollar at all. The residuals are heteroscedastic by Breusch-Pagan, which is the same clustering analysis 2 found, showing up in a third place.

### 6. Which days do not belong?

The modified z-score measures each day against the median and the spread around it, so one enormous day cannot widen the ruler it is being measured with. On a currency that is not a nicety: a single 2015 in the franc would otherwise hide every other outlier in the series.

| What | Which grid call |
| --- | --- |
| The scan | `grid.statistics.anomalies({ columns: ['ret'], method: 'modifiedZScore' })` |
| Each flagged day, worst first | the result's `rows`, each carrying its `rowKey`, its `score` and the `why` behind it |

**The verdict.** **108** of 7,093 days — 1.5% — are flagged, several times what a normal would allow: the fat tails from analysis 1, arriving with dates attached. The biggest is **19 December 2008** at **−4.74%**, a modified z of **−10.2**, in the week the Federal Reserve reached the zero bound. Switch to the franc and the list rearranges around **15 January 2015** at **−15.55%** with a modified z of **−73.4**, the morning the Swiss National Bank abandoned the 1.20 floor.

Each of the ten is shown with a line on what happened — from a fixed table of dates in `src/analysis.js`, matched on the exact publication day and on nothing else. A day that is not in the table is shown **without** an explanation rather than given one that fits, because a demo that invents a cause for an outlier is worse than one that leaves it bare: a reader cannot tell the two apart. Note that the ECB publishes at about 16:00 Central European Time, so an American announcement in the afternoon lands on the *next* day's rate, which is why several of the dates sit one day after the event they are named for.

## The verdict panel

Seven sentences at the top of the tab, each built from the figures beneath it and each carrying the call that produced it. They are the deliverable: a reader who wants the numbers can have them, and a reader who wants to know what twenty-seven years of currency did can read seven sentences and stop.

They are rewritten on every pass, so they can never be stale, and the verification insists that at least five of the seven actually change when the pair is switched, and again when the dates are narrowed. In practice all seven change both times.

## What the grid could not reach

Five things this page wanted and 1.62.1 does not do. None of them is worked around: the behaviour is left visible on the page with a note saying what is happening, because a demo that hides a defect teaches the wrong thing.

**F-FX-1 — the rolling-column family has no `rollingStddev` or `rollingVariance`.** The rolling shadow kinds run `rollingSum`, `rollingAvg`, `rollingMin`, `rollingMax`, `rollingQuantile`, `windowCoverage`, `cumulativeToDate` and `periodOverPeriod`. There is no rolling spread, so a rolling twenty-day standard deviation — the single most-used derived series in finance, and the input to every volatility chart ever drawn — cannot be had from the public API as a **series**. `statistics.windowed(col, 'stddev', { kind: 'count', span: 20 })` gives the spread of the *last* window and only that one, and calling it per row is not a thing the surface supports. Composing it out of two `rollingAvg` columns would be computing a statistic by hand, which this page does not do. So the volatility analysis charts non-overlapping blocks instead, and says so. Wanted: `rollingStddev` and `rollingVariance` alongside `rollingAvg`, reading the same `orderBy` and `window`, with `windowCoverage` stamping the partial leading rows exactly as it already does.

**F-FX-2 — the percentile kernels stop at p25 and there is no arbitrary quantile on `reduce`.** The kernel family is `p25`, `p75`, `p90`, `p95`, `p99` — the upper tail has kernels and the lower one does not. `reduce(col, 'p1')` and `reduce(col, 'p5')` are refused with `unknown total function "p1"; register it in config.totalFns` and return null, so a 1% tail — the other half of every tail comparison anyone makes — has no kernel at all. The only route on the public surface is `weightedQuantile(col, weightCol, p)`, which takes any quantile but needs a weight column, so this page carries a column of ones purely to reach it. Worse, the two use **different interpolations**: `p99` interpolates at `(n−1)·p` and `weightedQuantile` at `n·p − 0.5`, which on this data differ in the fourth significant figure (0.015254137 against 0.015257479). A page asking for the 95th and the 99th two ways would get two subtly different answers with nothing to warn it. This page uses `weightedQuantile` for both tails so the pair are comparable. Wanted: `reduce(col, 'quantile', { p })`, or the missing `p1`/`p5`/`p10` kernels, on the same interpolation as the existing ones.

**F-FX-3 — a `histogram` cannot overlay a named reference distribution.** `curve: true` draws the grid's own kernel density estimate, which is exactly right and is what the page uses. But the commonest question asked of a histogram — "and what would a normal with this mean and this spread look like?" — has no answer in the spec: there is no `overlay`, no `distribution`, and `points` is a point set rather than a curve. So the normal is stated as figures beside the chart rather than drawn on it. Wanted: `curve: 'normal'` (or `overlay: { normal: true }`) fitting the named distribution to the binned column and drawing it alongside the KDE, so the two can be seen apart.

**F-FX-4 — `capability` returns null without a tolerance, even when nothing it is being asked for needs one.** Control limits, sigma from the moving range, and the Nelson or Western Electric rule breaks are facts about the readings and need no customer specification whatever. `capability('sd', { rules: 'nelson' })` with no `lower` or `upper` returns `null` — not an empty `cp` on a filled-in `limits`, but nothing at all. This page therefore declares `{ lower: 0 }`, which is honest here because a standard deviation cannot be negative, and quotes no Cp because a one-sided specification does not produce one. A column whose floor is not meaningful would have nothing honest to declare. This was already noted from the earthquake edition; it bit again here. Wanted: `limits` and `violations` returned with no specification, and the capability indices left null.

**F-FX-5 — a derived source cannot read a grid-computed column, and does not say so.** The whole statistics surface reads one perfectly: `reduce`, `acf`, `adf`, `anomalies`, `regressionModel` and `weightedQuantile` all work against a column declared with `value: { deps, compute }`. A **derived** source does not. `groupBy: '<computed>'` comes back as a single `null` bucket, and `select: { sd: { of: '<computed>', fn: 'stddev' } }` comes back all-null — in both cases silently, with no warning and no named refusal, so the derivation simply looks empty. Repro: three hundred rows with `rate` and `prev`, a column `ret` computed as `Math.log(rate / prev)`; `reduce('ret', 'stddev')` answers 0.005036 while a derived grid grouped on `prev` selecting `{ of: 'ret', fn: 'stddev' }` returns zero non-null rows. The asymmetry is the surprising part — the same column id works on one surface and not the other. This demo therefore carries every return **twice**: once as the table's grid-computed column, which is the honest demonstration, and once as a field on the row, because the volatility analysis is a derived grid and has no other way in. The verification checks the two agree. Wanted: either derived sources resolving a computed column, or a named refusal when they cannot.

## Running it

You need Node 22. Nothing is compiled and there is no build step.

```
npm install
npm start
```

The server prints the address to open. It picks a free port each time so it will not clash with anything else you have running.

| Address | What you get |
| --- | --- |
| `/` | the saved copy, then the days published since it was taken, fetched live and applied through the data router |
| `/?source=snapshot` | the saved copy alone, no network at all |
| `/?source=live` | the whole history fetched from the API, ignoring the saved copy |

That default is the shape of the page. Twenty-seven years of rates arrive in **one** `rows.load`, through the router; the handful of days since arrive as a **change**. Sending seven thousand days in as `apply({ add })` batches would be quadratic — each batch is matched against everything already there — and the difference is a page that opens at once against a page that appears to hang. When the API cannot be reached the top-up is skipped, the whole dashboard still works from the saved copy, and the masthead says plainly that is what you are looking at.

To take a fresh saved copy, `npm run snapshot`. A [nightly workflow](.github/workflows/snapshot.yml) does the same and commits it when the rates have changed.

## Where the data comes from

The **European Central Bank's euro foreign exchange reference rates**, read through the [Frankfurter](https://frankfurter.dev) API directly from your browser with no server in the middle.

The ECB publishes one set of reference rates each TARGET working day at about 16:00 Central European Time, based on a regular concertation between central banks across Europe. They are reference rates for information: they are not trading rates, there is no bid and no offer, and a day's rate is a single number for the whole day. Every statistic on this page is a statistic about that series and should be read as one.

What the API does, established by request before any of this was written:

| | |
| --- | --- |
| Endpoint | `GET https://api.frankfurter.dev/v1/1999-01-04..?base=EUR&symbols=USD,GBP,JPY,CHF` |
| The whole history in one call | 7,094 publication days, 4 January 1999 to today, **464 KB** of JSON (90 KB gzipped), served in about 0.7s |
| Versioning | the `/v1/` prefix is required — `https://api.frankfurter.dev/latest` is a 404. The older `api.frankfurter.app` host 301s to this one |
| CORS | `access-control-allow-origin: *`, `allow-methods: GET, OPTIONS`, `max-age: 7200`. A `github.io` origin is served, and the OPTIONS preflight answers 200 |
| Caching | `cache-control: public, max-age=86400`, behind Cloudflare |
| Rate limits | none published and none observed: twelve requests back to back all answered 200. This demo makes **one** request per page load in any case, and none at all with `?source=snapshot` |
| Terms | the reference rates are the ECB's and may be reused with the source acknowledged. Frankfurter is open source, free, and asks for no key |

Two things worth knowing before reading the statistics. A "day" here is a **publication day**, not a calendar day: weekends and TARGET holidays are absent, so a twenty-day run is about a trading month rather than exactly four calendar weeks, and the ACF's "lag 1" means the previous publication day. And the series is **quoted against the euro throughout**, so EUR/CHF before January 2015 is a rate the Swiss National Bank was actively holding at a floor — which is why the franc's statistics look the way they do, and why they are the most interesting of the four.

## Files

```
index.html                page shell
main.js                   loads the saved copy, then tops it up through the router
src/licence.js            the key for the demo's own published address
src/analysis.js           shaping: parsing, previous-day rates, returns, blocks, the date notes
src/frankfurter.js        the API: the two calls, the timeouts, the saved copy
src/dashboard.js          the views: router, table, computed columns, tiles, charts, tabs
src/statistics.js         the Statistics tab: the six analyses and the seven verdicts
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save the whole history into data/snapshot
tools/crosscheck.mjs      the same statistics, computed again from scratch
tools/verify.mjs          open it in a real browser and check all of it
data/snapshot/            the API's own answer, saved, so the demo works with no network
```

`src/analysis.js` shapes data and computes no statistics; `src/statistics.js` computes no statistics either, it asks the grid for them. The line between the two files is the honest claim this demo makes.

## Checking it

```
npm run verify            # the saved copy, the statistics tab, and the fallback
npm run verify -- --all   # also the live top-up against the real API
```

Needs Node 22 and a Chrome or Chromium on the machine. It is not a smoke test. It:

- opens the saved copy and insists the table holds every day the copy holds, that the router saw the whole history as **one** load, and that the four charts bound points and drew marks;
- recomputes every pair's returns **from the rates alone** and insists the grid's own computed return column agrees — its standard deviation, its mean and its Jarque-Bera, all read back off the computed column through the statistics surface;
- opens the Statistics tab and cross-checks **every verdict figure** against `tools/crosscheck.mjs`, which imports nothing the page uses: its own Lanczos log-gamma and Lentz incomplete beta for a Student-t critical value, its own least squares by Gauss-Jordan inversion of XᵀX, its own moving-range control limits and Nelson rule counts, its own autocorrelation, its own Augmented Dickey-Fuller regression, its own modified z-scores, and its own quantiles on both of the engine's two interpolations;
- prints both numbers and the gap between them for each, and fails on any gap past 1e-9;
- switches to the franc and cross-checks the whole thing again, insisting its tails are fatter than the dollar's, that its biggest day is 15 January 2015, and that the page names what happened on it;
- narrows to "Since 2015" and cross-checks the whole thing a third time, insisting the day count, the runs on the control chart and the days fitted all fall, that the bound tiles followed the filter, and that the verdicts were rewritten;
- blocks the API in the browser and opens the live page, to prove a visitor gets the whole saved copy and is told the API could not be reached;
- insists on nought console errors and nought page errors throughout, and on no watermark on localhost.

Every kernel convention the cross-check implements was pinned against the engine before it was written, and the comments say which: `stddev` divides by n−1, `skewness` and `kurtosis` are the sample-adjusted G1 and G2, `jarqueBera` uses the **population** moments rather than those adjusted ones, and the two quantile routes interpolate differently. The one thing not recomputed is the ADF **lag order**: choosing it is a policy — which criterion, over which sample, up to which cap — and re-implementing a policy proves nothing, so the engine's chosen lag is taken as given and the t-statistic at that lag is recomputed from scratch. It agrees to 1e-13.

## Licence

The code in this repository is available under the MIT licence. See [LICENSE](LICENSE).

Lattice Grid itself is a separate commercial product with its own terms. It is free to use on localhost, with no key and no watermark, so a copy of this repository runs unrestricted on your own machine. This demo carries a key for its own published address only, which is why you will find one in the source. Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

The exchange rates are the [European Central Bank's euro foreign exchange reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html), which may be reused with the source acknowledged, and they are read through [Frankfurter](https://frankfurter.dev), which is open source and free to use.
