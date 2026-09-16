/**
 * The statistics, computed again, from scratch, in Node.
 *
 * Nothing in this file imports the grid or anything the page uses. It takes the
 * raw rows the table is holding — a date and four rates, and nothing else — and
 * works out the same figures the Statistics tab shows, by hand, from textbook
 * definitions.
 *
 * That is the whole point. A check that read the page's own numbers back and
 * agreed with them would prove only that the page can print. These numbers are
 * arrived at a second, completely independent way, and the check is that the
 * two agree to the last significant figure.
 *
 * Where a kernel has a documented definition that is not the only reasonable
 * one — a quantile can be interpolated two ways, a skew can be the population
 * one or the sample-adjusted one, a standard deviation can divide by n or n−1 —
 * the convention was pinned against the engine before this file was written and
 * the comment says which one it is.
 *
 * Used by `tools/verify.mjs`. Nothing the page loads imports it.
 */

import { BLOCK_DAYS, PAIRS } from '../src/analysis.js';

/* ------------------------------------------------------------------ */
/* The distributions the intervals need                                */
/* ------------------------------------------------------------------ */

/** The natural log of the gamma function, by the Lanczos approximation. */
function logGamma(x) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i += 1) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The regularised incomplete beta function, by Lentz's continued fraction. */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  /* The fraction converges quickly only on one side, so the other is reached
     through the symmetry I(x; a, b) = 1 − I(1−x; b, a). */
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(b, a, 1 - x);
  const tiny = 1e-30;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 400; i += 1) {
    const m = Math.floor(i / 2);
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -(((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    const step = c * d;
    f *= step;
    if (Math.abs(1 - step) < 1e-13) break;
  }
  return (front * (f - 1)) / a;
}

/** The two-sided critical value of Student's t, by bisection on its CDF. */
export function tCritical(df, confidence = 0.95) {
  const cdf = (t) => {
    const x = df / (df + t * t);
    const half = 0.5 * incompleteBeta(df / 2, 0.5, x);
    return t > 0 ? 1 - half : half;
  };
  const target = 1 - (1 - confidence) / 2;
  let low = 0;
  let high = 1000;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (cdf(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/* ------------------------------------------------------------------ */
/* The reductions                                                      */
/* ------------------------------------------------------------------ */

/** The finite numbers in a list, in the order given. */
export function numbers(values) {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

export function mean(values) {
  const xs = numbers(values);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The nth central moment about the mean, divided by n. */
function moment(xs, mu, power) {
  let total = 0;
  for (const x of xs) total += (x - mu) ** power;
  return total / xs.length;
}

/** The SAMPLE standard deviation, dividing by n−1. That is the `stddev` kernel. */
export function stddev(values) {
  const xs = numbers(values);
  if (xs.length < 2) return null;
  const mu = mean(xs);
  let total = 0;
  for (const x of xs) total += (x - mu) ** 2;
  return Math.sqrt(total / (xs.length - 1));
}

/**
 * Skewness, sample-adjusted: G1 = g1 · √(n(n−1)) ÷ (n−2).
 * That is the `skewness` kernel, checked against it before this was written.
 */
export function skewness(values) {
  const xs = numbers(values);
  if (xs.length < 3) return null;
  const mu = mean(xs);
  const m2 = moment(xs, mu, 2);
  const g1 = moment(xs, mu, 3) / Math.pow(m2, 1.5);
  const n = xs.length;
  return (g1 * Math.sqrt(n * (n - 1))) / (n - 2);
}

/**
 * Excess kurtosis, sample-adjusted:
 * G2 = ((n−1) ÷ ((n−2)(n−3))) · ((n+1)·g2 + 6), where g2 is the population
 * excess. That is the `kurtosis` kernel. A normal's is nought.
 */
export function kurtosis(values) {
  const xs = numbers(values);
  if (xs.length < 4) return null;
  const mu = mean(xs);
  const m2 = moment(xs, mu, 2);
  const g2 = moment(xs, mu, 4) / (m2 * m2) - 3;
  const n = xs.length;
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6);
}

/**
 * The Jarque-Bera statistic, n ÷ 6 · (g1² + g2² ÷ 4).
 *
 * Note which moments: the POPULATION skew and excess kurtosis, not the
 * sample-adjusted ones the `skewness` and `kurtosis` kernels return. The two
 * differ by about 0.2% on seven thousand rows and by a great deal on sixty, so
 * this was pinned against the engine rather than assumed.
 */
export function jarqueBera(values) {
  const xs = numbers(values);
  if (xs.length < 4) return null;
  const mu = mean(xs);
  const m2 = moment(xs, mu, 2);
  const g1 = moment(xs, mu, 3) / Math.pow(m2, 1.5);
  const g2 = moment(xs, mu, 4) / (m2 * m2) - 3;
  return (xs.length / 6) * (g1 * g1 + (g2 * g2) / 4);
}

/** The median, by linear interpolation between the two middle order statistics. */
export function median(values) {
  const xs = numbers(values).sort((a, b) => a - b);
  if (!xs.length) return null;
  const half = (xs.length - 1) / 2;
  return xs.length % 2 ? xs[half] : (xs[half - 0.5] + xs[half + 0.5]) / 2;
}

/**
 * A quantile the `weightedQuantile` way, with every weight one: the reading at
 * position `n·p − 0.5`, interpolated, and clamped to the ends.
 *
 * This is NOT the same rule as the `p95`/`p99` kernels, which interpolate at
 * `(n−1)·p`. Both are defensible and the engine uses both; the page uses this
 * one for both its tails so the pair are comparable. See finding F-FX-2.
 */
export function weightedQuantile(values, p) {
  const xs = numbers(values).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const position = xs.length * p - 0.5;
  if (position <= 0) return xs[0];
  if (position >= xs.length - 1) return xs[xs.length - 1];
  const low = Math.floor(position);
  return xs[low] + (position - low) * (xs[low + 1] - xs[low]);
}

/** A confidence interval for the mean, from Student's t. */
export function meanInterval(values, confidence = 0.95) {
  const xs = numbers(values);
  if (xs.length < 2) return null;
  const mu = mean(xs);
  const sd = stddev(xs);
  const margin = tCritical(xs.length - 1, confidence) * (sd / Math.sqrt(xs.length));
  return { mean: mu, lower: mu - margin, upper: mu + margin, margin, n: xs.length };
}

/** Pearson's correlation. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/* ------------------------------------------------------------------ */
/* Least squares, by normal equations                                  */
/* ------------------------------------------------------------------ */

/**
 * Ordinary least squares with standard errors, solved by inverting XᵀX with
 * Gauss-Jordan elimination. No library, no shortcut.
 *
 * @param {number[][]} X the design matrix, intercept column included
 * @param {number[]} y the response
 * @returns {{beta: number[], se: number[], df: number, n: number, r2: number}}
 */
export function ols(X, y) {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Float64Array(p));
  const Xty = new Float64Array(p);
  for (let i = 0; i < n; i += 1) {
    const xi = X[i];
    for (let a = 0; a < p; a += 1) {
      Xty[a] += xi[a] * y[i];
      for (let b = a; b < p; b += 1) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 0; a < p; a += 1) for (let b = 0; b < a; b += 1) XtX[a][b] = XtX[b][a];

  /* [XtX | I] reduced to [I | XtX⁻¹], with partial pivoting. */
  const M = XtX.map((row, i) => {
    const wide = new Float64Array(2 * p);
    wide.set(row);
    wide[p + i] = 1;
    return wide;
  });
  for (let c = 0; c < p; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * p; k += 1) M[c][k] /= d;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let k = 0; k < 2 * p; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const inv = M.map((row) => Array.from(row.slice(p)));

  const beta = new Float64Array(p);
  for (let a = 0; a < p; a += 1) {
    let total = 0;
    for (let b = 0; b < p; b += 1) total += inv[a][b] * Xty[b];
    beta[a] = total;
  }

  const my = mean(y);
  let rss = 0;
  let tss = 0;
  for (let i = 0; i < n; i += 1) {
    let fitted = 0;
    const xi = X[i];
    for (let a = 0; a < p; a += 1) fitted += xi[a] * beta[a];
    rss += (y[i] - fitted) ** 2;
    tss += (y[i] - my) ** 2;
  }
  const df = n - p;
  const sigma2 = rss / df;
  const se = Array.from({ length: p }, (_, a) => Math.sqrt(sigma2 * inv[a][a]));
  return { beta: Array.from(beta), se, df, n, r2: 1 - rss / tss };
}

/* ------------------------------------------------------------------ */
/* The six analyses, again                                             */
/* ------------------------------------------------------------------ */

/**
 * Daily log returns for one pair, computed here from the two rates on the row.
 *
 * This is the one place the check duplicates the page's data shaping, and it
 * does it deliberately: it reads only the rate and the rate the ECB published
 * the working day before, both of which are data on the row, so if the page's
 * returns were ever wrong every figure below would disagree and say so.
 *
 * Note which two numbers. The previous rate is the one the ECB actually
 * published, not the one on the previous row IN VIEW — those differ the moment
 * a date filter is on, and the first day of a narrowed window has a perfectly
 * real return that the ECB's own numbers support. Dropping it because the
 * filter starts there would throw away a genuine reading, so neither the page
 * nor this file does.
 *
 * @param {object[]} rows the raw rows the table holds
 * @param {string} pairId which pair
 * @returns {{date: string, rate: number, ret: number}[]}
 */
export function returnsOf(rows, pairId) {
  const ordered = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = [];
  for (const row of ordered) {
    const now = row[pairId];
    const before = row[`${pairId}Prev`];
    if (typeof now !== 'number' || typeof before !== 'number' || now <= 0 || before <= 0) continue;
    out.push({ date: row.date, rate: now, ret: Math.log(now / before) });
  }
  return out;
}

/** The rates for one pair, in date order. */
export function levelsOf(rows, pairId) {
  return [...rows]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .filter((row) => typeof row[pairId] === 'number' && Number.isFinite(row[pairId]))
    .map((row) => ({ date: row.date, rate: row[pairId] }));
}

/** 1: the shape of a day. */
export function distribution(rows, pairId) {
  const xs = returnsOf(rows, pairId).map((row) => row.ret);
  const interval = meanInterval(xs, 0.95);
  const sd = stddev(xs);
  const NORMAL_Z99 = 2.3263478740408408;
  return {
    n: xs.length,
    mean: interval ? interval.mean : null,
    lower: interval ? interval.lower : null,
    upper: interval ? interval.upper : null,
    median: median(xs),
    sd,
    skewness: skewness(xs),
    kurtosis: kurtosis(xs),
    jarqueBera: jarqueBera(xs),
    q01: weightedQuantile(xs, 0.01),
    q99: weightedQuantile(xs, 0.99),
    normalLow: interval ? interval.mean - NORMAL_Z99 * sd : null,
    normalHigh: interval ? interval.mean + NORMAL_Z99 * sd : null,
  };
}

/**
 * 2: the spread of each run, and the control limits over them.
 *
 * The limits are three sigma from the MOVING RANGE: sigma is the mean
 * absolute jump between one reading and the next, divided by d2 = 1.128 for a
 * moving range of two. Not the overall spread, which a step change would
 * widen.
 */
export function volatility(rows, pairId, blockDays = BLOCK_DAYS) {
  const xs = returnsOf(rows, pairId);
  const whole = Math.floor(xs.length / blockDays);
  const readings = [];
  for (let b = 0; b < whole; b += 1) {
    const slice = xs.slice(b * blockDays, (b + 1) * blockDays);
    readings.push({
      sd: stddev(slice.map((row) => row.ret)),
      from: slice[0].date,
      to: slice[slice.length - 1].date,
    });
  }
  if (readings.length < 2) return { readings: 0 };
  const sds = readings.map((row) => row.sd);
  const centre = mean(sds);
  let ranges = 0;
  for (let i = 1; i < sds.length; i += 1) ranges += Math.abs(sds[i] - sds[i - 1]);
  const sigma = ranges / (sds.length - 1) / 1.128;
  const upper = centre + 3 * sigma;
  const lower = centre - 3 * sigma;

  /* Nelson rule 1: a reading beyond three sigma. */
  const beyond = readings.filter((row) => row.sd > upper || row.sd < lower);
  /* Nelson rule 2: nine in a row on one side of the centre line, counted once
     per reading from the ninth onward, which is how the engine counts it. */
  let runs = 0;
  let run = 0;
  let side = 0;
  for (const value of sds) {
    const now = value > centre ? 1 : value < centre ? -1 : 0;
    if (now !== 0 && now === side) run += 1;
    else {
      side = now;
      run = 1;
    }
    if (run >= 9) runs += 1;
  }

  const sorted = [...readings].sort((a, b) => b.sd - a.sd);
  return {
    readings: readings.length,
    centre,
    sigma,
    upper,
    lower,
    rule1: beyond.length,
    rule2: runs,
    inControl: readings.length - beyond.length,
    highest: sorted[0],
    lowest: sorted[sorted.length - 1],
    beyond: beyond.sort((a, b) => b.sd - a.sd).slice(0, 6),
    sds,
  };
}

/** The autocorrelation at one lag: the usual biased estimator. */
export function acfAt(values, lag) {
  const mu = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    den += (values[i] - mu) ** 2;
    if (i + lag < values.length) num += (values[i] - mu) * (values[i + lag] - mu);
  }
  return num / den;
}

/** 3: the autocorrelation of the return and of its size. */
export function autocorrelation(rows, pairId, maxLag = 20) {
  const xs = returnsOf(rows, pairId).map((row) => row.ret);
  const abs = xs.map((v) => Math.abs(v));
  const bound = 1.96 / Math.sqrt(xs.length);
  const returnAcf = [1];
  const sizeAcf = [1];
  for (let lag = 1; lag <= maxLag; lag += 1) {
    returnAcf.push(acfAt(xs, lag));
    sizeAcf.push(acfAt(abs, lag));
  }
  return {
    n: xs.length,
    bound,
    returnAcf,
    sizeAcf,
    returnOutside: returnAcf.slice(1).filter((v) => Math.abs(v) > bound).length,
    sizeOutside: sizeAcf.slice(1).filter((v) => Math.abs(v) > bound).length,
  };
}

/**
 * The Augmented Dickey-Fuller t-statistic at a GIVEN lag order, constant and
 * trend.
 *
 * Regress Δy(t) on a constant, a trend, y(t−1) and `lag` lagged differences;
 * the statistic is the t on y(t−1).
 *
 * The lag order itself is taken from the engine rather than chosen again here.
 * Choosing it is a policy — which information criterion, over which sample, up
 * to which cap — and re-implementing a policy proves nothing. The ARITHMETIC is
 * what this checks, and it is the arithmetic the verdict quotes.
 *
 * @param {number[]} series the series, in order
 * @param {number} lag the lag order the engine chose
 */
export function adfAt(series, lag) {
  const y = series;
  const rowsOut = [];
  const response = [];
  for (let t = lag + 1; t < y.length; t += 1) {
    const x = [1, t + 1, y[t - 1]];
    for (let j = 1; j <= lag; j += 1) x.push(y[t - j] - y[t - j - 1]);
    rowsOut.push(x);
    response.push(y[t] - y[t - 1]);
  }
  if (rowsOut.length <= rowsOut[0].length) return null;
  const fit = ols(rowsOut, response);
  return { statistic: fit.beta[2] / fit.se[2], nobs: rowsOut.length, lag };
}

/** 4: stationarity, at the lag orders the engine chose. */
export function stationarity(rows, pairId, levelLag, returnLag) {
  const levels = levelsOf(rows, pairId).map((row) => row.rate);
  const returns = returnsOf(rows, pairId).map((row) => row.ret);
  return {
    level: adfAt(levels, levelLag),
    returns: adfAt(returns, returnLag),
  };
}

/** 5: sterling's day regressed on the dollar's. */
export function crossPair(rows, confidence = 0.95) {
  const usd = new Map(returnsOf(rows, 'usd').map((row) => [row.date, row.ret]));
  const gbp = returnsOf(rows, 'gbp');
  const x = [];
  const y = [];
  for (const row of gbp) {
    const other = usd.get(row.date);
    if (typeof other !== 'number') continue;
    x.push(other);
    y.push(row.ret);
  }
  if (x.length < 3) return { n: x.length };
  const fit = ols(x.map((v) => [1, v]), y);
  const margin = tCritical(fit.df, confidence) * fit.se[1];
  return {
    n: fit.n,
    slope: fit.beta[1],
    lower: fit.beta[1] - margin,
    upper: fit.beta[1] + margin,
    stdError: fit.se[1],
    r2: fit.r2,
    pearson: correlation(x, y),
  };
}

/**
 * 6: the days that do not belong.
 *
 * The modified z-score: 0.6745 · (x − median) ÷ MAD, flagged past 3.5.
 */
export function anomalies(rows, pairId, threshold = 3.5, top = 10) {
  const xs = returnsOf(rows, pairId);
  const values = xs.map((row) => row.ret);
  const centre = median(values);
  const spread = median(values.map((v) => Math.abs(v - centre)));
  if (!spread) return { n: values.length, flagged: 0, worst: [] };
  const scored = xs.map((row) => ({
    date: row.date,
    ret: row.ret,
    score: (0.6745 * (row.ret - centre)) / spread,
  }));
  const flagged = scored.filter((row) => Math.abs(row.score) > threshold);
  const worst = [...scored].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, top);
  return { n: scored.length, flagged: flagged.length, worst, centre, spread };
}

/** Every pair id, for a check that wants to sweep them. */
export const PAIR_IDS = PAIRS.map((pair) => pair.id);
