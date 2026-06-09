// Wires the dashboard together: renders charts, runs detection, and
// produces a per-session forecast over a configurable horizon (1–4
// weeks of Tadawul sessions). Symbol can be switched at runtime; live
// data is fetched from Yahoo Finance via a CORS proxy.
(function () {
  var chartRefs = { price: null, rsi: null, macd: null };
  var TADAWUL_WEEKEND = { 5: true, 6: true }; // Fri (5), Sat (6) closed
  var US_WEEKEND = { 0: true, 6: true };       // Sun (0), Sat (6) closed

  // ── State ──
  var state = {
    symbol: "7203.SR",
    rows: window.STOCK_DATA,
    source: "fallback",
    horizonWeeks: parseInt(localStorage.getItem("elm7203.horizon") || "1", 10),
    chartHidden: localStorage.getItem("elm7203.chartHidden") === "1"
  };

  // ── Symbol helpers ──
  // Tadawul tickers are 4-digit numbers; Yahoo expects ".SR" suffix.
  function normaliseSymbol(raw) {
    if (!raw) return null;
    var s = raw.trim().toUpperCase();
    if (!s) return null;
    if (/^\d{4}$/.test(s)) return s + ".SR";
    return s;
  }
  function isTadawul(symbol) { return /\.SR$/i.test(symbol); }
  function weekendSet(symbol) { return isTadawul(symbol) ? TADAWUL_WEEKEND : US_WEEKEND; }
  function weekLabel(symbol) {
    return isTadawul(symbol) ? "Sun–Thu" : "Mon–Fri";
  }

  function nextTradingDays(fromDateStr, n, weekend) {
    var d = new Date(fromDateStr + "T00:00:00Z");
    var out = [];
    while (out.length < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (!weekend[d.getUTCDay()]) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function lastValid(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }
  function fmtSAR(n) { return n.toFixed(2); }
  function currencyOf(symbol) { return isTadawul(symbol) ? "SAR" : "USD"; }

  function chartBase(scales, opts) {
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false, backgroundColor: "rgba(10,14,26,0.95)", borderColor: "rgba(255,255,255,0.1)", borderWidth: 1, padding: 10, titleColor: "#e8ecf6", bodyColor: "#a8b1cf" }
      },
      scales: Object.assign({
        x: { ticks: { color: "#7a83a3", maxTicksLimit: 8, font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.04)" } }
      }, { y: Object.assign({ grid: { color: "rgba(255,255,255,0.04)" }, ticks: { font: { size: 11 } } }, (scales && scales.y) || {}) })
    }, opts || {});
  }

  // ── Forecast logic ──
  // Compute every indicator we'll use once. Same shape used for the
  // realtime forecast and for each step of the walk-forward backtest.
  function computeIndicators(candles) {
    var closes = candles.map(function (c) { return c.close; });
    return {
      closes: closes,
      sma20: Indicators.sma(closes, 20),
      sma50: Indicators.sma(closes, 50),
      rsi: Indicators.rsi(closes, 14),
      macd: Indicators.macd(closes, 12, 26, 9),
      atr: Indicators.atr(candles, 14),
      bb: Indicators.bollinger(closes, 20, 2),
      adx: Indicators.adx(candles, 14),
      roc5: Indicators.roc(closes, 5),
      roc10: Indicators.roc(closes, 10),
      roc20: Indicators.roc(closes, 20),
      stoch: Indicators.stochastic(candles, 14, 3),
      sigma: Indicators.stdev(Indicators.dailyReturns(closes).slice(-60))
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Signal extraction.
  //
  // Each signal is a real-valued time series. We give every signal the
  // same shape so that for the current bar we get one number, and for
  // backtest fitting we get a series we can regress against forward
  // returns. Signals are chosen to be as INDEPENDENT as possible so we
  // don't double-count correlated information.
  // ───────────────────────────────────────────────────────────────
  function signalSeries(candles, ind) {
    var n = candles.length;
    var closes = ind.closes;

    // 1) Medium-term trend: log(close / sma50). Centred at 0; positive
    //    means price is above its 50-day mean (trend up).
    var trend = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      if (ind.sma50[i] && ind.sma50[i] > 0) trend[i] = Math.log(closes[i] / ind.sma50[i]);
    }

    // 2) Short-term momentum (independent of trend): ROC(10) – ROC(50).
    //    This is the "acceleration" — how much faster the recent 10d
    //    rose/fell than the long-run drift.
    var roc50 = Indicators.roc(closes, 50);
    var momentum = new Array(n).fill(null);
    for (var k = 0; k < n; k++) {
      if (ind.roc10[k] != null && roc50[k] != null) {
        momentum[k] = (ind.roc10[k] - roc50[k] / 5) / 100; // back to fractional
      }
    }

    // 3) Mean reversion: Bollinger z-score, but only the EXTREME portion
    //    (clamped to ±2 then divided). Captures statistical stretch.
    var meanRev = new Array(n).fill(null);
    for (var m = 0; m < n; m++) {
      var z = ind.bb.z[m];
      if (z != null) {
        // Use only the extreme component; inverted because high z → expect down
        meanRev[m] = -Math.max(-1, Math.min(1, z / 2));
      }
    }

    // 4) Pattern signal: +1 if any confirmed bullish pattern, -1 if any
    //    confirmed bearish, 0.5×sign if forming, 0 if none. Detected on
    //    a rolling basis is expensive; here we just provide the LAST
    //    value (used for the final forecast). For the backtest fitting
    //    we treat the pattern series as 0 over history so the regression
    //    weighs it conservatively. (Bulkowski stats are months-scale —
    //    we apply a discount in `currentSignals` rather than fit β.)
    var pattern = new Array(n).fill(0);

    return { trend: trend, momentum: momentum, meanRev: meanRev, pattern: pattern };
  }

  // Current value of each signal for the LAST bar in `candles`.
  function currentSignals(candles, ind, patterns, horizonDays) {
    var n = candles.length;
    var series = signalSeries(candles, ind);
    var trendNow = lastValid(series.trend);
    var momentumNow = lastValid(series.momentum);
    var meanRevNow = lastValid(series.meanRev);

    // Pattern current value: only confirmed (broken) patterns contribute,
    // and the contribution is Bulkowski's avg-move scaled by horizon/90d
    // (since his stats are months-scale). Clamped to ±0.05 (5%).
    var patternEffect = 0;
    patterns.forEach(function (p) {
      if (p.stage !== "broken-up" && p.stage !== "broken-down") return;
      if (!p.stats) return;
      var horizonFraction = Math.min(1, horizonDays / 90);
      var signed = p.bias === "bull" ? Math.abs(p.stats.avgMove) / 100
                 : p.bias === "bear" ? -Math.abs(p.stats.avgMove) / 100 : 0;
      patternEffect += signed * horizonFraction * p.confidence;
    });
    patternEffect = Math.max(-0.05, Math.min(0.05, patternEffect));

    return {
      trend: trendNow != null ? trendNow : 0,
      momentum: momentumNow != null ? momentumNow : 0,
      meanRev: meanRevNow != null ? meanRevNow : 0,
      pattern: patternEffect,
      _series: series
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Per-signal out-of-sample calibration.
  //
  // For each signal series, run an OLS regression of FORWARD h-day
  // return on the signal value, fit on the first 70% of valid pairs,
  // and report:
  //   · β (slope) for the in-sample fit
  //   · t-stat from the in-sample fit (used as a confidence cue)
  //   · shrinkFactor = max(0, |t| − 1) / max(1, |t|)
  //   · oosR2 — coefficient of determination on the held-out 30%
  // The current signal value × β × shrinkFactor is the calibrated
  // contribution to expected h-day return.
  // ───────────────────────────────────────────────────────────────
  function calibrateSignal(signalVals, closes, horizonDays) {
    // Align: at index i we have signal[i] predicting return from i to i+h.
    var xs = [], ys = [];
    for (var i = 0; i + horizonDays < closes.length; i++) {
      var v = signalVals[i];
      if (v == null || !isFinite(v)) continue;
      var r = (closes[i + horizonDays] - closes[i]) / closes[i];
      xs.push(v); ys.push(r);
    }
    if (xs.length < 30) return { beta: 0, t: 0, shrink: 0, oosR2: null, n: xs.length };

    var split = Math.floor(xs.length * 0.7);
    var trainX = xs.slice(0, split), trainY = ys.slice(0, split);
    var testX = xs.slice(split),     testY = ys.slice(split);

    var fit = Indicators.olsSlope(trainX, trainY);
    if (fit.beta == null) return { beta: 0, t: 0, shrink: 0, oosR2: null, n: xs.length };

    // Out-of-sample R²: 1 - SSE_oos / SST_oos against the train-mean.
    var trainMeanY = trainY.reduce(function (s, v) { return s + v; }, 0) / trainY.length;
    var alpha = trainMeanY - fit.beta * (trainX.reduce(function (s, v) { return s + v; }, 0) / trainX.length);
    var sse = 0, sst = 0;
    for (var j = 0; j < testX.length; j++) {
      var pred = alpha + fit.beta * testX[j];
      sse += Math.pow(testY[j] - pred, 2);
      sst += Math.pow(testY[j] - trainMeanY, 2);
    }
    var oosR2 = sst > 0 ? 1 - sse / sst : null;

    var absT = Math.abs(fit.t);
    var shrink = absT <= 1 ? 0 : (absT - 1) / absT;
    // Penalise if out-of-sample R² is negative (worse than mean) — that's
    // strong evidence the in-sample fit was spurious.
    if (oosR2 != null && oosR2 < 0) shrink *= 0.3;

    return { beta: fit.beta, t: fit.t, shrink: shrink, oosR2: oosR2, n: xs.length };
  }

  // Walk-forward direction-only backtest. Honest hit-rate.
  function backtestDirection(candles, horizonDays, predictSign) {
    var WARMUP = 60;
    var hits = 0, total = 0;
    var deadband = 0.005;
    for (var i = WARMUP; i < candles.length - horizonDays; i++) {
      var slice = candles.slice(0, i + 1);
      var ind = computeIndicators(slice);
      var pats = Patterns.detectAll(slice);
      var sigs = currentSignals(slice, ind, pats, horizonDays);
      var sign = predictSign(sigs);
      if (sign === 0) continue;
      var actual = (candles[i + horizonDays].close - candles[i].close) / candles[i].close;
      var actDir = actual > deadband ? 1 : actual < -deadband ? -1 : 0;
      total++;
      if (sign === actDir) hits++;
    }
    return { hitRate: total > 0 ? hits / total : null, count: total };
  }

  // Standard normal sample via Box-Muller. Used for GBM Monte Carlo.
  function randn() {
    var u = 1 - Math.random();
    var v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // GBM-style Monte Carlo. Steps log returns r ~ N(μ, σ²) per session.
  // Records: per-day percentiles, % of paths that touched the target,
  // and median first-hit day among paths that hit. Cheap (~80k ops for
  // 4000×20).
  function monteCarlo(lastClose, muDaily, sigmaDaily, horizonDays, target, paths) {
    paths = paths || 4000;
    var perDay = [];
    for (var k = 0; k < horizonDays; k++) perDay.push(new Float64Array(paths));
    var firstHitDays = [];
    var hitsAbove = target > lastClose;
    for (var p = 0; p < paths; p++) {
      var price = lastClose;
      var hit = -1;
      for (var t = 0; t < horizonDays; t++) {
        var z = randn();
        price = price * Math.exp(muDaily - 0.5 * sigmaDaily * sigmaDaily + sigmaDaily * z);
        perDay[t][p] = price;
        if (hit === -1 && ((hitsAbove && price >= target) || (!hitsAbove && price <= target))) {
          hit = t + 1;
        }
      }
      if (hit !== -1) firstHitDays.push(hit);
    }
    function pct(arr, q) {
      var sorted = Array.from(arr).sort(function (a, b) { return a - b; });
      return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))];
    }
    firstHitDays.sort(function (a, b) { return a - b; });
    return {
      paths: paths,
      p10ByDay: perDay.map(function (a) { return pct(a, 0.10); }),
      p50ByDay: perDay.map(function (a) { return pct(a, 0.50); }),
      p90ByDay: perDay.map(function (a) { return pct(a, 0.90); }),
      probHit: firstHitDays.length / paths,
      medianFirstHit: firstHitDays.length >= paths * 0.30
        ? firstHitDays[Math.floor(firstHitDays.length / 2)]
        : null,
      meanFirstHit: firstHitDays.length >= paths * 0.30
        ? firstHitDays.reduce(function (a, b) { return a + b; }, 0) / firstHitDays.length
        : null
    };
  }

  // Detect the next meaningful swing-based level the price would run
  // into in `dir` direction. Guardrails:
  //   - level must be ≥ minDistATR × ATR away (rejects trivial pivots)
  //   - swing must be within `recentWindow` sessions (rejects stale)
  //   - returns BOTH nearest "in-direction" (target) and nearest
  //     "against-direction" (invalidation/stop)
  function findKeyLevels(candles, dir, lastClose, atr, opts) {
    opts = opts || {};
    var minDistATR = opts.minDistATR || 0.7;
    var recentWindow = opts.recentWindow || 80;
    var minDist = atr * minDistATR;
    var earliestIdx = Math.max(0, candles.length - recentWindow);
    var sw = Indicators.swings(candles, 5);

    function pick(arr, predicate, sortFn) {
      var picked = arr.filter(function (p) { return p.index >= earliestIdx && predicate(p); });
      picked.sort(sortFn);
      return picked.length ? picked[0] : null;
    }

    var primary = null, invalidation = null;
    if (dir > 0) {
      primary = pick(sw.highs,
        function (h) { return h.price - lastClose >= minDist; },
        function (a, b) { return a.price - b.price; }); // nearest above
      invalidation = pick(sw.lows,
        function (l) { return lastClose - l.price >= minDist; },
        function (a, b) { return b.price - a.price; }); // nearest below
      if (primary) primary.type = "resistance";
      if (invalidation) invalidation.type = "support";
    } else if (dir < 0) {
      primary = pick(sw.lows,
        function (l) { return lastClose - l.price >= minDist; },
        function (a, b) { return b.price - a.price; }); // nearest below
      invalidation = pick(sw.highs,
        function (h) { return h.price - lastClose >= minDist; },
        function (a, b) { return a.price - b.price; }); // nearest above
      if (primary) primary.type = "support";
      if (invalidation) invalidation.type = "resistance";
    }
    return { primary: primary, invalidation: invalidation };
  }

  // ───────────────────────────────────────────────────────────────
  // Forecast (rebuilt).
  //
  // Methodology:
  //   1. BASELINE  — empirical h-day return distribution from THIS
  //      stock's actual history. μ_h, σ_h, percentiles (10/25/50/75/90).
  //   2. SIGNALS   — four independent signals (trend, momentum, mean-
  //      reversion, pattern) with calibrated effect = β·current_value,
  //      shrunk by max(0, |t|-1)/|t| from an OLS fit; penalised if
  //      out-of-sample R² is negative.
  //   3. COMBINE   — total adjustment = Σ contributions, clamped to
  //      ±2·σ_h (signals never override what history shows).
  //   4. FORECAST  — expected return = μ_h + total_adjust.
  //      Price = lastClose × (1 + expected_return).
  //   5. RANGE     — empirical percentiles + total_adjust applied as a
  //      location shift (no log-normality assumption).
  //   6. PROBABILITY — empirical bootstrap: fraction of historical
  //      h-day returns + total_adjust that meet/exceed the target.
  //   7. TIME      — GBM Monte-Carlo first-passage using μ = expected
  //      daily return and σ = recent daily σ. Used only for timing.
  //   8. CONFIDENCE — based on signal-to-noise |adjust|/σ_h, blended
  //      with the walk-forward direction hit rate; capped at 85%.
  // ───────────────────────────────────────────────────────────────
  function buildForecast(candles, patterns, ind, horizonDays, weekend) {
    var lastBar = candles[candles.length - 1];
    var lastClose = lastBar.close;
    var atrLast = lastValid(ind.atr) || lastClose * 0.015;
    var closes = ind.closes;

    // ── 1. Empirical baseline (h-day forward returns from this stock).
    var hRets = Indicators.horizonReturns(closes, horizonDays);
    var muH      = hRets.length ? hRets.reduce(function (s, v) { return s + v; }, 0) / hRets.length : 0;
    var sigmaH   = hRets.length ? Indicators.stdev(hRets) : 0.02;
    var pct = function (q) { return Indicators.percentile(hRets, q); };
    var p10H = pct(0.10), p25H = pct(0.25), p50H = pct(0.50), p75H = pct(0.75), p90H = pct(0.90);

    // ── 2. Signals + per-signal out-of-sample calibration.
    var series = signalSeries(candles, ind);
    var cur = currentSignals(candles, ind, patterns, horizonDays);

    var calTrend    = calibrateSignal(series.trend,    closes, horizonDays);
    var calMomentum = calibrateSignal(series.momentum, closes, horizonDays);
    var calMeanRev  = calibrateSignal(series.meanRev,  closes, horizonDays);

    function contrib(cal, value) {
      if (!cal || cal.beta == null || !isFinite(value)) return 0;
      return cal.beta * value * cal.shrink;
    }
    var contribs = [
      { name: "Trend (log(P/SMA50))",        value: cur.trend,    cal: calTrend,    effect: contrib(calTrend,    cur.trend)    },
      { name: "Momentum (ROC10 − ROC50/5)",  value: cur.momentum, cal: calMomentum, effect: contrib(calMomentum, cur.momentum) },
      { name: "Mean reversion (BB z, capped)", value: cur.meanRev,  cal: calMeanRev,  effect: contrib(calMeanRev,  cur.meanRev)  },
      // Pattern is direct (not regression-fit) — Bulkowski statistics
      // scaled to the horizon, only for CONFIRMED breakouts.
      { name: "Confirmed Bulkowski pattern (horizon-scaled)", value: cur.pattern, cal: null, effect: cur.pattern }
    ];

    // ── 3. Combine + clamp.
    var rawAdjust = contribs.reduce(function (s, c) { return s + c.effect; }, 0);
    var adjustCap = 2 * sigmaH;
    var totalAdjust = Math.max(-adjustCap, Math.min(adjustCap, rawAdjust));

    // ── 4. Forecast point estimate.
    var expectedReturn = muH + totalAdjust;
    var horizonTarget = lastClose * (1 + expectedReturn);

    // ── 5. Empirical-percentile range (location-shifted by adjust).
    var lower = lastClose * (1 + p10H + totalAdjust);
    var p25   = lastClose * (1 + p25H + totalAdjust);
    var p50   = lastClose * (1 + p50H + totalAdjust);
    var p75   = lastClose * (1 + p75H + totalAdjust);
    var upper = lastClose * (1 + p90H + totalAdjust);

    // ── Key levels (S/R + invalidation) with guardrails.
    var direction = totalAdjust > 0.5 * sigmaH ? "up"
                  : totalAdjust < -0.5 * sigmaH ? "down" : "flat";
    var dirSign = direction === "up" ? 1 : direction === "down" ? -1 : 0;
    var levels = dirSign !== 0
      ? findKeyLevels(candles, dirSign, lastClose, atrLast, { minDistATR: 0.7, recentWindow: 80 })
      : { primary: null, invalidation: null };

    var targetSource = "model";
    var modelTarget = horizonTarget;
    if (levels.primary && dirSign !== 0) {
      var lvl = levels.primary.price;
      var between = dirSign > 0
        ? (lvl < horizonTarget && lvl > lastClose)
        : (lvl > horizonTarget && lvl < lastClose);
      if (between) {
        horizonTarget = lvl;
        targetSource = levels.primary.type;
      }
    }

    // ── 6. Empirical bootstrap: probability of reaching `horizonTarget`.
    var targetReturn = (horizonTarget - lastClose) / lastClose;
    var probHit;
    if (hRets.length < 30) {
      probHit = 0.5; // not enough history — punt
    } else {
      var hits = 0;
      for (var i = 0; i < hRets.length; i++) {
        var shifted = hRets[i] + totalAdjust;
        if (dirSign >= 0 ? shifted >= targetReturn : shifted <= targetReturn) hits++;
      }
      probHit = hits / hRets.length;
    }

    // ── 7. Monte-Carlo first-passage for TIMING ONLY.
    var sigma = ind.sigma || 0.012;
    var muDaily = expectedReturn / horizonDays;
    var mc = monteCarlo(lastClose, muDaily, sigma, horizonDays, horizonTarget, 4000);

    var stopMC = null;
    if (levels.invalidation) {
      stopMC = monteCarlo(lastClose, muDaily, sigma, horizonDays, levels.invalidation.price, 2000);
    }

    var dates = nextTradingDays(lastBar.date, horizonDays, weekend);
    var days = dates.map(function (date, i) {
      var t = i + 1;
      var dayP50 = mc.p50ByDay[i];
      var dayP10 = mc.p10ByDay[i];
      var dayP90 = mc.p90ByDay[i];
      var dDir = dayP50 > lastClose * 1.001 ? "up"
              : dayP50 < lastClose * 0.999 ? "down" : "flat";
      // Per-day confidence: signal-to-noise scaled, decaying with horizon.
      var snr = sigmaH > 0 ? Math.min(1.5, Math.abs(totalAdjust) / sigmaH) : 0;
      var dayConf = Math.max(0.10, Math.min(0.85, 0.25 + 0.35 * snr)) * Math.pow(0.95, i);
      return {
        date: date, dayIndex: t,
        target: dayP50, lower: dayP10, upper: dayP90,
        direction: dDir, confidence: dayConf
      };
    });

    var medianHit = mc.medianFirstHit;
    var hitDate = medianHit != null ? dates[Math.min(medianHit - 1, dates.length - 1)] : null;

    var label = direction === "up" ? "BULLISH" : direction === "down" ? "BEARISH" : "NEUTRAL";

    // ── 8. Confidence: signal-to-noise + walk-forward direction backtest.
    var snr = sigmaH > 0 ? Math.abs(totalAdjust) / sigmaH : 0;
    var snrComponent = Math.max(0.05, Math.min(0.75, 0.20 + 0.45 * Math.min(1, snr / 1.5)));

    // Walk-forward direction backtest using the same signal pipeline.
    var bt = backtestDirection(candles, horizonDays, function (sigs) {
      // Apply the same calibrated contributions point-in-time-ish (we
      // re-use the in-sample β; this is intentionally simplified for speed).
      var adj = contrib(calTrend, sigs.trend) + contrib(calMomentum, sigs.momentum) +
                contrib(calMeanRev, sigs.meanRev) + sigs.pattern;
      adj = Math.max(-adjustCap, Math.min(adjustCap, adj));
      return adj > 0.5 * sigmaH ? 1 : adj < -0.5 * sigmaH ? -1 : 0;
    });
    var btHit = bt.hitRate;
    var blended = btHit != null ? 0.55 * snrComponent + 0.45 * btHit : snrComponent;
    var confidence = Math.max(0.05, Math.min(0.85, blended));

    // ── Rationale (clear about what's measured vs assumed).
    var contribLines = contribs
      .filter(function (c) { return Math.abs(c.effect) > 0.0005; })
      .sort(function (a, b) { return Math.abs(b.effect) - Math.abs(a.effect); })
      .map(function (c) {
        var bp = Math.round(c.effect * 10000);
        var tInfo = c.cal && c.cal.t != null
          ? " (β=" + c.cal.beta.toFixed(3) + ", t=" + c.cal.t.toFixed(2) +
            (c.cal.oosR2 != null ? ", oosR²=" + (c.cal.oosR2 * 100).toFixed(1) + "%" : "") + ")"
          : "";
        return (bp >= 0 ? "+" : "") + bp + " bp · " + c.name + tInfo;
      });

    var clampedTxt = Math.abs(rawAdjust) > adjustCap
      ? " (raw " + (rawAdjust * 100).toFixed(2) + "% clamped to ±2·σ_h = ±" + (adjustCap * 100).toFixed(2) + "%)"
      : "";

    var btTxt = btHit != null
      ? "Direction backtest: " + Math.round(btHit * 100) + "% over " + bt.count + " windows."
      : "Insufficient history for backtest.";

    var anchorTxt = targetSource === "model"
      ? "Target = empirical baseline + signal-adjusted (" + horizonTarget.toFixed(2) + ")."
      : "Target snapped to nearest swing " + targetSource + " at " +
        horizonTarget.toFixed(2) + " (model would have shown " + modelTarget.toFixed(2) + ").";

    var hitTxt = medianHit != null
      ? Math.round(probHit * 100) + "% empirical hit-prob · median first-hit MC day " +
        medianHit + " (" + hitDate + ", conditional on hit)."
      : "Only " + Math.round(probHit * 100) + "% empirical hit-prob — timing suppressed.";

    var stopTxt = "";
    if (stopMC && levels.invalidation) {
      stopTxt = " · Invalidation " + levels.invalidation.price.toFixed(2) +
        " (" + levels.invalidation.type + "), MC touch risk " +
        Math.round(stopMC.probHit * 100) + "%.";
    }

    var rationale =
      "Baseline μ_h=" + (muH * 100).toFixed(2) + "%, σ_h=" + (sigmaH * 100).toFixed(2) + "% " +
      "from " + hRets.length + " historical " + horizonDays + "-session windows. " +
      "Signal-adjust=" + (totalAdjust * 100).toFixed(2) + "%" + clampedTxt + ". " +
      anchorTxt + " " + hitTxt + stopTxt + " " + btTxt +
      (contribLines.length ? " Contributions: " + contribLines.join("  ·  ") + "." : "");

    return {
      direction: direction, label: label,
      score: snr * Math.sign(totalAdjust || 1),
      confidence: confidence,
      target: horizonTarget,
      lower: lower,
      upper: upper,
      p25: p25, p50: p50, p75: p75,
      days: days, rationale: rationale, lastClose: lastClose,
      horizonDays: horizonDays,
      backtest: { hitRate: btHit, count: bt.count },
      mc: mc,
      targetSource: targetSource,
      keyLevel: levels.primary,
      invalidation: levels.invalidation,
      stopMC: stopMC,
      driftTarget: modelTarget,
      driftPct: expectedReturn,
      probHit: probHit,
      medianFirstHit: medianHit,
      meanFirstHit: mc.meanFirstHit,
      expectedDate: hitDate,
      // Diagnostics for the UI signal contribution table:
      contributions: contribs,
      baseline: { muH: muH, sigmaH: sigmaH, p10: p10H, p50: p50H, p90: p90H, n: hRets.length },
      totalAdjust: totalAdjust,
      rawAdjust: rawAdjust,
      adjustCap: adjustCap
    };
  }

  // ── Render ──
  function render(opts) {
    opts = opts || {};
    var data = state.rows;
    var symbol = state.symbol;
    var horizonDays = state.horizonWeeks * 5;
    var weekend = weekendSet(symbol);
    var ccy = currencyOf(symbol);

    var ind = computeIndicators(data);
    var closes = ind.closes;
    var labels = data.map(function (c) { return c.date; });
    var sma20 = ind.sma20, sma50 = ind.sma50, rsi14 = ind.rsi, macd = ind.macd;

    var last = data[data.length - 1];
    var prev = data[data.length - 2];
    var change = last.close - prev.close;
    var changePct = (change / prev.close) * 100;

    document.getElementById("lastPrice").textContent = fmtSAR(last.close);
    document.querySelector(".hero-currency").textContent = ccy;
    var chEl = document.getElementById("lastChange");
    chEl.textContent = (change >= 0 ? "+" : "") + change.toFixed(2) +
      "  (" + (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%)";
    chEl.classList.remove("up", "down");
    chEl.classList.add(change >= 0 ? "up" : "down");
    document.getElementById("lastDate").textContent = "as of " + last.date;

    document.getElementById("statDayRange").textContent = fmtSAR(last.low) + " – " + fmtSAR(last.high);
    var minClose = Math.min.apply(null, closes), maxClose = Math.max.apply(null, closes);
    document.getElementById("stat52Range").textContent = fmtSAR(minClose) + " – " + fmtSAR(maxClose);
    var sma20Last = lastValid(sma20), sma50Last = lastValid(sma50);
    document.getElementById("statSma").textContent =
      (sma20Last != null ? fmtSAR(sma20Last) : "—") + " / " +
      (sma50Last != null ? fmtSAR(sma50Last) : "—");
    var rsiLast = lastValid(rsi14);
    document.getElementById("statRsi").textContent = rsiLast != null ? rsiLast.toFixed(1) : "—";

    // Brand
    var bareSymbol = symbol.replace(/\.SR$/i, "");
    document.getElementById("logoBox").textContent = bareSymbol.length <= 4 ? bareSymbol : bareSymbol.slice(0, 4);
    document.getElementById("brandName").innerHTML = symbol +
      ' <span class="brand-ar" id="brandAr">' + (state.symbol === "7203.SR" ? "شركة علم" : "") + '</span>';
    document.getElementById("brandSub").textContent =
      (isTadawul(symbol) ? "Tadawul · Saudi Stock Exchange · TADAWUL:" + bareSymbol
                         : "Yahoo Finance: " + symbol);

    // Source pill
    var srcEl = document.getElementById("dataSource");
    srcEl.classList.remove("live", "fallback");
    if (state.source === "live") {
      srcEl.textContent = "live · " + last.date;
      srcEl.classList.add("live");
      srcEl.title = "Live data from Yahoo Finance · last close " + last.date;
    } else {
      srcEl.textContent = "demo · " + last.date;
      srcEl.classList.add("fallback");
      srcEl.title = "Live fetch unavailable. Showing fallback for " + symbol + " (" + last.date + ").";
    }

    // Forecast title with horizon
    document.getElementById("forecastTitle").textContent =
      state.horizonWeeks === 1 ? "Next-Week Forecast" : "Next " + state.horizonWeeks + "-Week Forecast";
    document.getElementById("forecastSub").textContent =
      "Day-by-day projection for the next " + horizonDays + " sessions (" + weekLabel(symbol) + ").";
    document.getElementById("targetLabel").textContent = horizonDays + "-Session Target";

    // ── Forecast ──
    var patterns = Patterns.detectAll(data);
    var forecast = buildForecast(data, patterns, ind, horizonDays, weekend);

    // ── Price chart with forecast trail + Monte-Carlo cone ──
    var fcLabels = forecast.days.map(function (d) { return d.date; });
    var fcSeries = forecast.days.map(function (d) { return d.target; });
    var fcLower  = forecast.days.map(function (d) { return d.lower; });
    var fcUpper  = forecast.days.map(function (d) { return d.upper; });
    var fullLabels = labels.concat(fcLabels);
    var pad = function (arr) { return arr.concat(fcLabels.map(function () { return null; })); };
    function alignForward(arr) {
      var out = labels.map(function () { return null; }).concat(arr);
      out[labels.length - 1] = closes[closes.length - 1];
      return out;
    }
    var fcMid = alignForward(fcSeries);
    var fcLo  = alignForward(fcLower);
    var fcHi  = alignForward(fcUpper);

    // Target horizontal line: highlights the snapped target across the
    // forecast region only.
    var targetLine = labels.map(function () { return null; })
                            .concat(fcLabels.map(function () { return forecast.target; }));

    if (chartRefs.price) chartRefs.price.destroy();
    chartRefs.price = new Chart(document.getElementById("priceChart").getContext("2d"), {
      type: "line",
      data: {
        labels: fullLabels,
        datasets: [
          // Cone fill: P10 (lower bound) and P90 (upper bound). Drawn
          // first so the price/SMA lines paint over it.
          { label: "P90", data: fcHi, borderColor: "rgba(46,224,164,0.0)",
            backgroundColor: "rgba(46,224,164,0.10)", pointRadius: 0, borderWidth: 0,
            fill: "+1", tension: 0.2, order: 5 },
          { label: "P10", data: fcLo, borderColor: "rgba(46,224,164,0.0)",
            backgroundColor: "rgba(46,224,164,0.10)", pointRadius: 0, borderWidth: 0,
            fill: false, tension: 0.2, order: 6 },

          { label: "Close", data: pad(closes), borderColor: "#6aa3ff", backgroundColor: "rgba(106,163,255,0.10)",
            pointRadius: 0, borderWidth: 2, tension: 0.18, fill: true, order: 2 },
          { label: "SMA 20", data: pad(sma20), borderColor: "#ffc960", pointRadius: 0, borderWidth: 1.4, tension: 0.2, order: 3 },
          { label: "SMA 50", data: pad(sma50), borderColor: "#b48cff", pointRadius: 0, borderWidth: 1.4, tension: 0.2, order: 4 },

          { label: "Target", data: targetLine, borderColor: "rgba(46,224,164,0.55)",
            borderDash: [2, 4], pointRadius: 0, borderWidth: 1, tension: 0, order: 1 },

          { label: "Forecast (P50)", data: fcMid, borderColor: "#2ee0a4", borderDash: [6, 4],
            pointRadius: 3, pointBackgroundColor: "#2ee0a4", borderWidth: 2, tension: 0.1, order: 0 }
        ]
      },
      options: chartBase({ y: { ticks: { color: "#a8b1cf" } } })
    });

    // ── RSI ──
    if (chartRefs.rsi) chartRefs.rsi.destroy();
    chartRefs.rsi = new Chart(document.getElementById("rsiChart").getContext("2d"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          { label: "RSI(14)", data: rsi14, borderColor: "#2ee0a4", pointRadius: 0, borderWidth: 1.6, tension: 0.2 },
          { label: "70", data: labels.map(function () { return 70; }), borderColor: "rgba(255,97,120,0.6)", borderDash: [4,4], pointRadius: 0, borderWidth: 1 },
          { label: "30", data: labels.map(function () { return 30; }), borderColor: "rgba(46,224,164,0.5)", borderDash: [4,4], pointRadius: 0, borderWidth: 1 }
        ]
      },
      options: chartBase({ y: { min: 0, max: 100, ticks: { color: "#a8b1cf" } } })
    });
    document.getElementById("rsiNote").textContent =
      "Latest: " + (rsiLast != null ? rsiLast.toFixed(1) : "—") +
      (rsiLast >= 70 ? " — overbought" : rsiLast <= 30 ? " — oversold" : " — neutral");

    // ── MACD ──
    if (chartRefs.macd) chartRefs.macd.destroy();
    chartRefs.macd = new Chart(document.getElementById("macdChart").getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          { type: "bar", label: "Histogram", data: macd.hist,
            backgroundColor: macd.hist.map(function (v) { return v >= 0 ? "rgba(46,224,164,0.55)" : "rgba(255,97,120,0.55)"; }) },
          { type: "line", label: "MACD", data: macd.line, borderColor: "#6aa3ff", pointRadius: 0, borderWidth: 1.6 },
          { type: "line", label: "Signal", data: macd.signal, borderColor: "#ffc960", pointRadius: 0, borderWidth: 1.6 }
        ]
      },
      options: chartBase({ y: { ticks: { color: "#a8b1cf" } } })
    });
    var macdLast = lastValid(macd.line), sigLast = lastValid(macd.signal);
    document.getElementById("macdNote").textContent =
      macdLast != null && sigLast != null
        ? (macdLast > sigLast ? "Bullish — MACD above signal" : "Bearish — MACD below signal")
        : "—";

    // ── Patterns ──
    var listEl = document.getElementById("patternList");
    listEl.innerHTML = "";
    if (patterns.length === 0) {
      listEl.innerHTML = '<p class="card-sub">No high-confidence patterns matched in the recent window.</p>';
    } else {
      patterns.forEach(function (p) {
        var div = document.createElement("div");
        div.className = "pattern " + (p.bias === "bull" ? "bull" : p.bias === "bear" ? "bear" : "neutral");
        var statLine = p.stats ? "Avg post-breakout move: " + p.stats.avgMove + "%" : "";
        div.innerHTML =
          '<div class="pname">' + p.name + ' <span class="stage-tag">' + p.stage + '</span></div>' +
          '<div class="pmeta">Bias <strong>' + p.bias.toUpperCase() + '</strong> · Confidence <strong>' +
              Math.round(p.confidence * 100) + '%</strong></div>' +
          '<div class="pmeta">Neckline <strong>' + p.neckline.toFixed(2) +
              '</strong> · Target <strong>' + p.target.toFixed(2) + '</strong></div>' +
          (statLine ? '<div class="pmeta">' + statLine + '</div>' : "");
        listEl.appendChild(div);
      });
    }

    applyForecast(forecast, ccy);
    syncSegButtons();

    if (opts.save) saveSnapshot(forecast, patterns);
  }

  function saveSnapshot(forecast, patterns) {
    var last = state.rows[state.rows.length - 1];
    var entry = {
      id: Date.now(),
      savedAt: new Date().toISOString(),
      symbol: state.symbol,
      source: state.source,
      lastDate: last.date,
      lastClose: last.close,
      horizonWeeks: state.horizonWeeks,
      forecast: {
        direction: forecast.direction,
        label: forecast.label,
        score: forecast.score,
        confidence: forecast.confidence,
        target: forecast.target,
        lower: forecast.lower,
        upper: forecast.upper,
        days: forecast.days,
        rationale: forecast.rationale
      },
      patterns: patterns.map(function (p) {
        return { name: p.name, bias: p.bias, stage: p.stage,
                 confidence: p.confidence, neckline: p.neckline, target: p.target };
      }),
      rows: state.rows
    };
    window.HistoryStore.add(entry);
  }

  function restoreSnapshot(e) {
    state.symbol = e.symbol;
    state.rows = e.rows;
    state.source = e.source;
    state.horizonWeeks = e.horizonWeeks;
    document.getElementById("symbolInput").value = e.symbol.replace(/\.SR$/i, "");
    localStorage.setItem("elm7203.horizon", String(e.horizonWeeks));
    render({ save: false });
    document.querySelector(".chart-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // If history.html opened us with ?restore=<id>, replay that snapshot
  // instead of doing a fresh live fetch on bootstrap.
  function tryRestoreFromUrl() {
    var match = location.search.match(/[?&]restore=([^&]+)/);
    if (!match) return false;
    var id = parseInt(decodeURIComponent(match[1]), 10);
    var entry = window.HistoryStore.getAll().find(function (e) { return e.id === id; });
    if (!entry) return false;
    restoreSnapshot(entry);
    if (history.replaceState) history.replaceState({}, "", location.pathname);
    return true;
  }

  function applyForecast(f, ccy) {
    var badge = document.getElementById("trendBadge");
    badge.textContent = f.label;
    badge.classList.remove("up", "down", "flat");
    badge.classList.add(f.direction);

    document.getElementById("targetPrice").textContent = fmtSAR(f.target) + " " + ccy;
    var srcEl = document.getElementById("targetSourceLine");
    if (srcEl) {
      var srcTxt;
      if (f.targetSource === "drift") srcTxt = "Drift extrapolation";
      else if (f.targetSource === "resistance") srcTxt = "Snapped to swing resistance · drift " + fmtSAR(f.driftTarget);
      else if (f.targetSource === "support") srcTxt = "Snapped to swing support · drift " + fmtSAR(f.driftTarget);
      else srcTxt = "—";
      srcEl.textContent = srcTxt;
    }

    var probEl = document.getElementById("probHit");
    var probFill = document.getElementById("probFill");
    if (probEl) {
      var prob = Math.round((f.probHit || 0) * 100);
      probEl.textContent = prob + "%";
      if (probFill) probFill.style.width = prob + "%";
    }

    var expEl = document.getElementById("expectedTime");
    var expDateEl = document.getElementById("expectedDate");
    if (expEl && expDateEl) {
      if (f.medianFirstHit != null) {
        expEl.textContent = "Day " + f.medianFirstHit + " of " + f.horizonDays;
        expDateEl.textContent = "≈ " + f.expectedDate +
          (f.meanFirstHit ? "  ·  mean " + f.meanFirstHit.toFixed(1) + "d" : "") +
          "  ·  conditional on hit";
      } else {
        expEl.textContent = "—";
        expDateEl.textContent = "<30% of paths reach target — timing not meaningful";
      }
    }

    var stopValEl = document.getElementById("stopLevel");
    var stopSubEl = document.getElementById("stopRisk");
    if (stopValEl && stopSubEl) {
      if (f.invalidation && f.stopMC) {
        var risk = Math.round(f.stopMC.probHit * 100);
        var dist = ((f.invalidation.price - f.lastClose) / f.lastClose) * 100;
        stopValEl.textContent = fmtSAR(f.invalidation.price) + " " + ccy;
        stopSubEl.textContent = f.invalidation.type + "  ·  " + (dist >= 0 ? "+" : "") +
          dist.toFixed(2) + "%  ·  touch risk " + risk + "%";
      } else {
        stopValEl.textContent = "—";
        stopSubEl.textContent = "no nearby swing in opposite direction";
      }
    }

    // Endpoint range: empirical percentiles (P10 / P50 / P90).
    document.getElementById("targetRange").textContent =
      fmtSAR(f.lower) + " / " + fmtSAR(f.p50) + " / " + fmtSAR(f.upper) + " " + ccy;

    // "Composite Score" is now a signal-to-noise ratio (|adjust|/σ_h).
    var snrEl = document.getElementById("compositeScore");
    if (snrEl) {
      var snrVal = Math.abs(f.score || 0);
      snrEl.textContent = snrVal.toFixed(2) + " σ" +
        "  (" + (f.totalAdjust >= 0 ? "+" : "") + (f.totalAdjust * 100).toFixed(2) + "% / σ_h " +
        (f.baseline.sigmaH * 100).toFixed(2) + "%)";
    }

    var pct = Math.max(1, Math.min(100, Math.round(f.confidence * 100)));
    var gauge = document.getElementById("confidenceGauge");
    var color = f.direction === "up" ? "var(--green)" : f.direction === "down" ? "var(--red)" : "var(--yellow)";
    gauge.style.setProperty("--pct", pct);
    gauge.style.setProperty("--color", color);
    document.getElementById("confidencePct").textContent = pct + "%";

    var bt = f.backtest;
    var btEl = document.getElementById("backtestLine");
    if (btEl) {
      if (bt && bt.hitRate != null) {
        btEl.innerHTML =
          "Direction backtest <strong>" + Math.round(bt.hitRate * 100) +
          "%</strong> over <strong>" + bt.count + "</strong> walks";
      } else {
        btEl.textContent = "Backtest: insufficient history";
      }
    }

    // ── Signal Contributions table ──
    var tbody = document.getElementById("contribBody");
    var adjSum = document.getElementById("adjustmentSummary");
    if (tbody && f.contributions) {
      tbody.innerHTML = "";
      f.contributions.forEach(function (c) {
        var bp = Math.round((c.effect || 0) * 10000);
        var cls = bp > 0 ? "contrib-pos" : bp < 0 ? "contrib-neg" : "contrib-zero";
        var betaTxt = c.cal && c.cal.beta != null ? c.cal.beta.toFixed(3) : "—";
        var tTxt    = c.cal && c.cal.t != null ? c.cal.t.toFixed(2) : "—";
        var r2Txt   = c.cal && c.cal.oosR2 != null
          ? (c.cal.oosR2 * 100).toFixed(1) + "%"
          : "—";
        var shrinkTxt = c.cal && c.cal.shrink != null
          ? (c.cal.shrink * 100).toFixed(0) + "%"
          : "100%";
        var shrunkCls = c.cal && c.cal.shrink != null && c.cal.shrink < 0.3 ? " contrib-shrunk" : "";
        var tr = document.createElement("tr");
        tr.innerHTML =
          '<td class="contrib-name' + shrunkCls + '">' + c.name + '</td>' +
          '<td class="num">' + (isFinite(c.value) ? c.value.toFixed(4) : "—") + '</td>' +
          '<td class="num">' + betaTxt + '</td>' +
          '<td class="num">' + tTxt + '</td>' +
          '<td class="num">' + r2Txt + '</td>' +
          '<td class="num">' + shrinkTxt + '</td>' +
          '<td class="num ' + cls + '">' + (bp >= 0 ? "+" : "") + bp + " bp</td>";
        tbody.appendChild(tr);
      });
      if (adjSum) {
        var totalBp = Math.round((f.totalAdjust || 0) * 10000);
        var rawBp = Math.round((f.rawAdjust || 0) * 10000);
        var capBp = Math.round((f.adjustCap || 0) * 10000);
        var clamped = Math.abs(f.rawAdjust) > f.adjustCap;
        adjSum.innerHTML =
          "Total " + (totalBp >= 0 ? "+" : "") + totalBp + " bp" +
          (clamped ? "  (raw " + (rawBp >= 0 ? "+" : "") + rawBp + " bp clamped to ±" + capBp + " bp)" : "") +
          "  ·  baseline μ_h " + (f.baseline.muH * 100).toFixed(2) + "%  ·  σ_h " +
          (f.baseline.sigmaH * 100).toFixed(2) + "% (n=" + f.baseline.n + ")";
      }
    }

    document.getElementById("rationale").textContent = f.rationale;

    var grid = document.getElementById("dayCards");
    grid.innerHTML = "";
    f.days.forEach(function (d) {
      var arrow = d.target > f.lastClose ? "↑" : d.target < f.lastClose ? "↓" : "→";
      var dirClass = d.target > f.lastClose ? "up" : d.target < f.lastClose ? "down" : "flat";
      var pct = ((d.target - f.lastClose) / f.lastClose) * 100;
      var conf = Math.round(d.confidence * 100);
      var div = document.createElement("div");
      div.className = "day-card " + dirClass;
      div.innerHTML =
        '<div class="day-head">' +
          '<span class="day-num">Day ' + d.dayIndex + '</span>' +
          '<span class="day-arrow ' + dirClass + '">' + arrow + ' ' + (pct >= 0 ? "+" : "") + pct.toFixed(2) + '%</span>' +
        '</div>' +
        '<div class="day-date">' + d.date + '</div>' +
        '<div class="day-target">' + fmtSAR(d.target) + '<span class="day-target-currency">' + ccy + '</span></div>' +
        '<div class="day-range">' + fmtSAR(d.lower) + ' – ' + fmtSAR(d.upper) + '</div>' +
        '<div class="day-conf">' +
          '<div class="day-conf-bar"><div class="day-conf-fill" style="width:' + conf + '%"></div></div>' +
          '<span class="day-conf-num">' + conf + '%</span>' +
        '</div>';
      grid.appendChild(div);
    });
  }

  function syncSegButtons() {
    document.querySelectorAll(".seg-btn").forEach(function (b) {
      b.classList.toggle("active", parseInt(b.dataset.weeks, 10) === state.horizonWeeks);
    });
  }

  // ── Bootstrap ──
  document.getElementById("symbolInput").value = state.symbol.replace(/\.SR$/i, "");
  render({ save: false });

  async function loadSymbol(symbolRaw, opts) {
    opts = opts || { save: true };
    var sym = normaliseSymbol(symbolRaw);
    if (!sym) return;
    var btn = document.getElementById("loadSymbolBtn");
    btn.disabled = true;
    btn.textContent = "Loading…";
    state.symbol = sym;
    var res = null;
    try { res = await window.LiveData.load(sym); } catch (e) {}
    if (res && res.rows && res.rows.length) {
      state.rows = res.rows;
      state.source = "live";
    } else if (sym === "7203.SR") {
      state.rows = window.STOCK_DATA;
      state.source = "fallback";
    } else {
      var srcEl = document.getElementById("dataSource");
      srcEl.classList.remove("live", "fallback");
      srcEl.textContent = "no data for " + sym;
      srcEl.title = "Live fetch failed and no embedded fallback exists for " + sym +
        ". Try again from a network where the CORS proxies are reachable.";
      btn.disabled = false; btn.textContent = "Load";
      return;
    }
    render({ save: opts.save });
    btn.disabled = false; btn.textContent = "Load";
  }

  document.getElementById("loadSymbolBtn").addEventListener("click", function () {
    loadSymbol(document.getElementById("symbolInput").value, { save: true });
  });
  document.getElementById("symbolInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") loadSymbol(e.target.value, { save: true });
  });
  document.getElementById("symbolPreset").addEventListener("change", function (e) {
    if (!e.target.value) return;
    document.getElementById("symbolInput").value = e.target.value;
    loadSymbol(e.target.value, { save: true });
    e.target.value = "";
  });

  document.getElementById("refreshBtn").addEventListener("click", function () {
    loadSymbol(state.symbol.replace(/\.SR$/i, ""), { save: true });
  });

  // Horizon segmented control
  document.querySelectorAll(".seg-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      state.horizonWeeks = parseInt(b.dataset.weeks, 10);
      localStorage.setItem("elm7203.horizon", String(state.horizonWeeks));
      render({ save: true });
    });
  });


  // Chart toggle
  var chartWrap = document.getElementById("priceChartWrap");
  var toggleBtn = document.getElementById("chartToggle");
  function applyToggle(hidden) {
    if (hidden) {
      chartWrap.classList.add("hidden");
      toggleBtn.textContent = "Show chart";
      toggleBtn.setAttribute("aria-pressed", "false");
    } else {
      chartWrap.classList.remove("hidden");
      toggleBtn.textContent = "Hide chart";
      toggleBtn.setAttribute("aria-pressed", "true");
      if (chartRefs.price) chartRefs.price.resize();
    }
  }
  applyToggle(state.chartHidden);
  toggleBtn.addEventListener("click", function () {
    state.chartHidden = !chartWrap.classList.contains("hidden");
    localStorage.setItem("elm7203.chartHidden", state.chartHidden ? "1" : "0");
    applyToggle(state.chartHidden);
  });

  // If history asked us to restore a snapshot, do that and skip the
  // automatic live fetch (which would clobber the restored view).
  if (!tryRestoreFromUrl()) {
    loadSymbol(state.symbol.replace(/\.SR$/i, ""), { save: false });
  }
})();
