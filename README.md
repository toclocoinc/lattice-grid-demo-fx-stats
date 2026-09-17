# Twenty-seven years of exchange rates, and what the numbers say

Every euro reference rate the European Central Bank has published since the euro began, 7,094 working days from 4 January 1999, in a Lattice Grid, read from the Frankfurter API in your browser with no server in the middle. Then a Statistics tab that puts the grid's statistics engine to work on the same rows and writes out what it finds in plain English.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-fx-stats/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| This demo | [toclocoinc/lattice-grid-demo-fx-stats](https://github.com/toclocoinc/lattice-grid-demo-fx-stats) |
| The earthquake statistics edition | [toclocoinc/lattice-grid-demo-earthquakes-stats](https://github.com/toclocoinc/lattice-grid-demo-earthquakes-stats) &nbsp;·&nbsp; [running](https://toclocoinc.github.io/lattice-grid-demo-earthquakes-stats/) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

## The point

A grid that can hold a million rows is a table. A grid that can tell you what is in them is something else.

Everything on the Statistics tab is a figure the grid produced, and every figure is shown beside the call that produced it. Nothing on the page works out a mean, a spread, a slope, a control limit, an autocorrelation or an outlier by hand, because that would prove nothing. The verification (`npm run verify`) exists to hold that line: it reads the raw rates out of the table, computes all of it a second and completely independent way in Node, and insists the two agree to the last significant figure.

Currencies are a good subject for this. Everyone already believes six things about a daily exchange rate: that it is roughly normal, that yesterday tells you nothing about tomorrow, that a rate drifts rather than reverting, that pairs sharing a leg move together. A statistics engine can check every one of them against twenty-seven years of the real thing in under a second. One of those beliefs turns out to be badly wrong, one is exactly right, and the difference between the two is the most useful thing on the page.

## The six analyses

Each one runs over whatever the table currently matches. Change the pair, or narrow the dates to "Since 2015", and all six are recomputed and all seven verdicts are rewritten. The Statistics tab opens in under two seconds even across the whole history, and stays that fast on every later pass.

The figures quoted below are EUR/USD over the whole history, as the saved copy stood when this was written.

### 1. What shape is a day?

Draw the returns, put a density curve over them, plot them against a normal, and ask Jarque-Bera what it thinks. What matters is not the middle, which always looks fine, but the tails.

| What | Which grid call |
| --- | --- |
| The mean and its 95% interval | `grid.statistics.interval('ret', { kind: 'mean', confidence: 0.95 })` |
| The spread, the shape and the test | `grid.statistics.reduce('ret', 'stddev' \| 'skewness' \| 'kurtosis' \| 'jarqueBera' \| 'median')` |
| The 1% and 99% points | `grid.statistics.weightedQuantile('ret', 'one', 0.01 \| 0.99)` |
| The shape | a `histogram` with `curve: true`: the bars, and the grid's kernel density estimate over them, which has no bin edges and so says which part of the shape is the data's |
| How far from normal | a `qq` chart |

**The verdict.** Jarque-Bera is **3,236** against a cut of 5.99, and the excess kurtosis is **3.31** where a normal's is nought. One day in a hundred EUR/USD falls more than **1.55%** or rises more than **1.53%**; a normal with the same mean and the same standard deviation of 0.581% would put those two days at **1.35%**. The real tails are about 1.14 times as far out as the model's. On the franc, where the 2015 unpegging sits, the excess kurtosis is **361** and Jarque-Bera is **38.6 million**.

The normal used for comparison is shown as figures rather than drawn over the histogram, so what is model and what is data stay clearly separate. The 2.3263 in "mean − 2.3263 σ" is a constant of the normal distribution, labelled as the model everywhere it appears; it is not a reading off this data.

### 2. Is the spread itself steady?

Divide the days into runs of twenty, about a trading month, measure the standard deviation of each run, and put the result on a control chart. Its limits come from the month-to-month jump rather than the overall spread, so a shift cannot widen the limits that are meant to catch it.

| What | Which grid call |
| --- | --- |
| The spread of each run | a derived grid, `source: { mode: 'derived', groupBy: 'block', select: { sd: { of: 'ret', fn: 'stddev' } } }` |
| The centre line, sigma and the limits | `grid.statistics.capability('sd', { lower: 0, rules: 'nelson' }).limits` |
| The rule breaks | the same call's `violations`, each with its rule number and description; the Western Electric count comes from the same call with `rules: 'westernElectric'` |
| The chart | a `control` chart, which draws the limits and marks the breaks |

**The verdict.** Over **354** runs the centre line sits at **0.544%** a day with limits of 0.204% to 0.884%, and **321** readings break a Nelson rule: **21** beyond three sigma and **100** of them nine or more in a row on one side of the line. Those long one-sided runs are the finding rather than a failure of the chart: quiet months come after quiet months and wild months after wild ones. Volatility clusters.

The runs do not overlap, on purpose: consecutive overlapping windows would share nineteen days in twenty, so the points would move together by construction and every control rule about runs and trends would fire on the overlap rather than on the market.

### 3. Is tomorrow readable from today?

Run the autocorrelation twice on the same days: once on the return, which is direction and size together, and once on the size with the direction thrown away.

| What | Which grid call |
| --- | --- |
| Both series, out to twenty lags | `grid.statistics.acf({ of: 'ret' \| 'abs', orderBy: 'seq', maxlag: 20 })` |
| The white-noise band | the same result's `bounds`, the ±1.96/√n approximation, which the result stamps `approximate: true` |
| The chart | a `bar` chart of one row per lag per series, split by `series`, with the band as `reference` lines |

**The verdict.** Of twenty lags, **3** of the return's clear the ±0.0233 band and lag 1 is **−0.0066**, indistinguishable from nought; under pure chance one lag in twenty would fall outside anyway. The size of the return is a different series entirely: **20 of 20** lags clear the band, lag 1 is **0.120** and lag 20 is still **0.120**: it has not decayed at all over a trading month. Which way it moves tomorrow is not readable from today. How far it moves is. That is the same fact analysis 2 found from the other end, and it is why every volatility model that has ever been used exists.

### 4. Does the rate have a level to come back to?

The Augmented Dickey-Fuller test, on the rate and then on the return, considering up to twelve lags when it chooses its model, a standard setting for daily data.

| What | Which grid call |
| --- | --- |
| Both tests | `grid.statistics.adf({ of: 'rate' \| 'ret', orderBy: 'seq' })` |
| The statistic, the lag AIC chose, the observations | `.statistic`, `.usedLag`, `.nobs` |
| MacKinnon's critical values and the verdict | `.criticalValues`, `.stationary`, `.verdict` |

**The verdict.** The EUR/USD rate is **non-stationary**: ADF is **−1.92** against −3.41 at 5%, so the null of a unit root is not rejected. It wanders, with no level it is obliged to return to. Difference it once, which is what a daily return is, and ADF becomes **−24.23**: **stationary**, emphatically. That single fact is why serious currency analysis is done on returns rather than rates, and here it is a result rather than a convention.

The p-value is interpolated across MacKinnon's critical-value ladder rather than taken from the response surface, and the result says so in `pApproximate`. The statistic and the critical values are the readings to quote.

### 5. How much of sterling's day is the dollar's?

EUR/GBP and EUR/USD share a leg, so they are not independent. Regress one on the other.

| What | Which grid call |
| --- | --- |
| The fit, with everything | `grid.statistics.regressionModel({ predictors: ['usdRet'], response: 'gbpRet', confidence: 0.95 })` |
| The slope and its interval | the `usdRet` coefficient's `estimate`, `lower`, `upper` and `stdError` |
| Whether the residuals fan out | the same model's `heteroscedasticity`, a Breusch-Pagan flag |
| Two correlations | `grid.statistics.correlation(a, b)` and `.spearman(a, b)` |
| The chart | a `scatter` with `fit: true` and `band: model.band`: the ribbon is the model's own pointwise interval |

**The verdict.** A one per cent day in EUR/USD comes with a **0.347** per cent day in EUR/GBP, and the fit puts that slope between **0.330** and **0.364** over 7,093 days. The interval clears nought and sits well below one, so the two move together and sterling moves less than the dollar does. It is nearer the euro. But the line accounts for only **17.8%** of sterling: 82.2% of what EUR/GBP did on these days had nothing to do with the dollar at all. The residuals are heteroscedastic by Breusch-Pagan, which is the same clustering analysis 2 found, showing up in a third place.

### 6. Which days do not belong?

The modified z-score measures each day against the median and the spread around it, so one enormous day cannot widen the ruler it is being measured with. On a currency that is not a nicety: a single 2015 in the franc would otherwise hide every other outlier in the series.

| What | Which grid call |
| --- | --- |
| The scan | `grid.statistics.anomalies({ columns: ['ret'], method: 'modifiedZScore' })` |
| Each flagged day, worst first | the result's `rows`, each carrying its `rowKey`, its `score` and the `why` behind it |

**The verdict.** **108** of 7,093 days, 1.5%, are flagged, several times what a normal would allow: the fat tails from analysis 1, arriving with dates attached. The biggest is **19 December 2008** at **−4.74%**, a modified z of **−10.2**, in the week the Federal Reserve reached the zero bound. Switch to the franc and the list rearranges around **15 January 2015** at **−15.55%** with a modified z of **−73.4**, the morning the Swiss National Bank abandoned the 1.20 floor.

Each of the ten is shown with a line on what happened, matched on the exact publication day and on nothing else. A day that is not on record is shown **without** an explanation rather than given one that fits: a demo that invents a cause for an outlier is worse than one that leaves it bare, because a reader cannot tell the two apart. The ECB publishes at about 16:00 Central European Time, so an American announcement in the afternoon lands on the *next* day's rate, which is why several of the dates sit one day after the event they are named for.

## The verdict panel

Seven sentences at the top of the tab, each built from the figures beneath it and each carrying the call that produced it. They are the deliverable: a reader who wants the numbers can have them, and a reader who wants to know what twenty-seven years of currency did can read seven sentences and stop.

They are rewritten on every pass, so they can never be stale: switch the pair, or narrow the dates, and the verdicts change with the figures beneath them.

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

That default is the shape of the page. Twenty-seven years of rates arrive in one load, so the page opens at once rather than filling in day by day; the handful of days published since then arrive moments later as a live update. When the API cannot be reached, the top-up is simply skipped: the whole dashboard still works from the saved copy, and the masthead says plainly that is what you are looking at.

To take a fresh saved copy, `npm run snapshot`. A [nightly workflow](.github/workflows/snapshot.yml) does the same and commits it when the rates have changed.

## Where the data comes from

The **European Central Bank's euro foreign exchange reference rates**, read through the [Frankfurter](https://frankfurter.dev) API directly from your browser with no server in the middle.

The ECB publishes one set of reference rates each TARGET working day at about 16:00 Central European Time, based on a regular concertation between central banks across Europe. They are reference rates for information: they are not trading rates, there is no bid and no offer, and a day's rate is a single number for the whole day. Every statistic on this page is a statistic about that series and should be read as one.

| | |
| --- | --- |
| Endpoint | `GET https://api.frankfurter.dev/v1/1999-01-04..?base=EUR&symbols=USD,GBP,JPY,CHF` |
| The whole history in one call | 7,094 publication days, 4 January 1999 to today, served in under a second |
| Terms | the reference rates are the ECB's and may be reused with the source acknowledged. Frankfurter is open source, free, and asks for no key |

Two things worth knowing before reading the statistics. A "day" here is a **publication day**, not a calendar day: weekends and TARGET holidays are absent, so a twenty-day run is about a trading month rather than exactly four calendar weeks, and the ACF's "lag 1" means the previous publication day. And the series is **quoted against the euro throughout**, so EUR/CHF before January 2015 is a rate the Swiss National Bank was actively holding at a floor, which is why the franc's statistics look the way they do, and why they are the most interesting of the four.

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

Every statistic on the page comes from the grid; `src/analysis.js` only shapes the rows it reads.

## Checking it

```
npm run verify            # the saved copy, the statistics tab, and the fallback
npm run verify -- --all   # also the live top-up against the real API
```

Needs Node 22 and a Chrome or Chromium on the machine. It opens the saved copy and confirms the table holds every day the copy holds; it recomputes every pair's returns from the rates alone and checks the grid's own computed column agrees; it opens the Statistics tab and cross-checks every verdict figure against an independent implementation in `tools/crosscheck.mjs`, printing the gap between the two and failing on anything past 1e-9; it switches pair and narrows the date range and checks the figures and verdicts move correctly; and it blocks the API in the browser to prove a visitor still gets the whole saved copy with a clear message when the API could not be reached.

## Licence

The code in this repository is available under the MIT licence. See [LICENSE](LICENSE).

Lattice Grid itself is a separate commercial product with its own terms. It is free to use on localhost, with no key and no watermark, so a copy of this repository runs unrestricted on your own machine. This demo carries a key for its own published address only, which is why you will find one in the source. Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

The exchange rates are the [European Central Bank's euro foreign exchange reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html), which may be reused with the source acknowledged, and they are read through [Frankfurter](https://frankfurter.dev), which is open source and free to use.
