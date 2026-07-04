// Forecast module — all forecasting math lives here.
//
// Exports (window.Forecast):
//   computeIndicators(candles)                       → ind
//   findKeyLevels(candles, dir, lastClose, atr, opt) → { primary, invalidation }
//   buildForecast(candles, patterns, ind, h, weekend) → forecast
//   monteCarlo(lastClose, mu, sigma, h, target, n)   → mc result
//
// All functions are pure — no DOM, no globals beyond reading
// window.Indicators and window.Patterns from the surrounding bundle.
(function () {
  function lastValid(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }

  // ── Indicator bundle ───────────────────────────────────────────
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

  // ── Signal series (used for OLS calibration) ───────────────────
  function signalSeries(candles, ind) {
    var n = candles.length;
    var closes = ind.closes;
    var trend = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      if (ind.sma50[i] && ind.sma50[i] > 0) trend[i] = Math.log(closes[i] / ind.sma50[i]);
    }
    var roc50 = Indicators.roc(closes, 50);
    var momentum = new Array(n).fill(null);
    for (var k = 0; k < n; k++) {
      if (ind.roc10[k] != null && roc50[k] != null) {
        momentum[k] = (ind.roc10[k] - roc50[k] / 5) / 100;
      }
    }
    var meanRev = new Array(n).fill(null);
    for (var m = 0; m < n; m++) {
      var z = ind.bb.z[m];
      if (z != null) meanRev[m] = -Math.max(-1, Math.min(1, z / 2));
    }
    return { trend: trend, momentum: momentum, meanRev: meanRev };
  }

  function currentSignals(candles, ind, patterns, horizonDays) {
    var series = signalSeries(candles, ind);
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
      trend: lastValid(series.trend) || 0,
      momentum: lastValid(series.momentum) || 0,
      meanRev: lastValid(series.meanRev) || 0,
      pattern: patternEffect,
      _series: series
    };
  }

  // ── Per-signal out-of-sample calibration ───────────────────────
  function calibrateSignal(signalVals, closes, horizonDays) {
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

    var trainMeanY = trainY.reduce(function (s, v) { return s + v; }, 0) / trainY.length;
    var trainMeanX = trainX.reduce(function (s, v) { return s + v; }, 0) / trainX.length;
    var alpha = trainMeanY - fit.beta * trainMeanX;
    var sse = 0, sst = 0;
    for (var j = 0; j < testX.length; j++) {
      var pred = alpha + fit.beta * testX[j];
      sse += Math.pow(testY[j] - pred, 2);
      sst += Math.pow(testY[j] - trainMeanY, 2);
    }
    var oosR2 = sst > 0 ? 1 - sse / sst : null;
    var absT = Math.abs(fit.t);
    var shrink = absT <= 1 ? 0 : (absT - 1) / absT;
    if (oosR2 != null && oosR2 < 0) shrink *= 0.3;

    return { beta: fit.beta, t: fit.t, shrink: shrink, oosR2: oosR2, n: xs.length };
  }

  // ── Direction-only walk-forward backtest ───────────────────────
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

  // ── Monte Carlo for timing only ────────────────────────────────
  function randn() {
    var u = 1 - Math.random();
    var v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

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

  // ── Key swing-pivot levels (with recency + distance guardrails) ─
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
        function (a, b) { return a.price - b.price; });
      invalidation = pick(sw.lows,
        function (l) { return lastClose - l.price >= minDist; },
        function (a, b) { return b.price - a.price; });
      if (primary) primary.type = "resistance";
      if (invalidation) invalidation.type = "support";
    } else if (dir < 0) {
      primary = pick(sw.lows,
        function (l) { return lastClose - l.price >= minDist; },
        function (a, b) { return b.price - a.price; });
      invalidation = pick(sw.highs,
        function (h) { return h.price - lastClose >= minDist; },
        function (a, b) { return a.price - b.price; });
      if (primary) primary.type = "support";
      if (invalidation) invalidation.type = "resistance";
    }
    return { primary: primary, invalidation: invalidation };
  }

  // ── Time-list helper used by buildForecast ─────────────────────
  function nextTradingDays(fromDateStr, n, weekend) {
    var d = new Date(fromDateStr + "T00:00:00Z");
    var out = [];
    while (out.length < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (!weekend[d.getUTCDay()]) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────
  // buildForecast — empirical baseline + OOS-calibrated signal stack
  // (unchanged math from the previous rebuild; tightened comments).
  // ───────────────────────────────────────────────────────────────
  function buildForecast(candles, patterns, ind, horizonDays, weekend) {
    var lastBar = candles[candles.length - 1];
    var lastClose = lastBar.close;
    var atrLast = lastValid(ind.atr) || lastClose * 0.015;
    var closes = ind.closes;

    var hRets = Indicators.horizonReturns(closes, horizonDays);
    // Recency-weighted baseline (exponential decay, half-life 30 sessions).
    // Weights recent bars 2× every 30 bars back, so μ_h and σ_h reflect
    // the CURRENT stock behaviour rather than a long synthetic prior.
    var HALF_LIFE = 30;
    var wStats = hRets.length ? Indicators.weightedStats(hRets, HALF_LIFE) : { mean: 0, stdev: 0.02 };
    var muH = wStats.mean;
    var sigmaH = wStats.stdev;
    var pct = function (q) { return Indicators.weightedPercentile(hRets, q, HALF_LIFE); };
    var p10H = pct(0.10), p25H = pct(0.25), p50H = pct(0.50), p75H = pct(0.75), p90H = pct(0.90);

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
      { name: "Trend (log(P/SMA50))",          value: cur.trend,    cal: calTrend,    effect: contrib(calTrend,    cur.trend)    },
      { name: "Momentum (ROC10 − ROC50/5)",    value: cur.momentum, cal: calMomentum, effect: contrib(calMomentum, cur.momentum) },
      { name: "Mean reversion (BB z, capped)", value: cur.meanRev,  cal: calMeanRev,  effect: contrib(calMeanRev,  cur.meanRev)  },
      { name: "Confirmed Bulkowski pattern (horizon-scaled)", value: cur.pattern, cal: null, effect: cur.pattern }
    ];

    var rawAdjust = contribs.reduce(function (s, c) { return s + c.effect; }, 0);
    var adjustCap = 2 * sigmaH;
    var totalAdjust = Math.max(-adjustCap, Math.min(adjustCap, rawAdjust));

    var expectedReturn = muH + totalAdjust;
    var horizonTarget = lastClose * (1 + expectedReturn);

    var lower = lastClose * (1 + p10H + totalAdjust);
    var p25 = lastClose * (1 + p25H + totalAdjust);
    var p50 = lastClose * (1 + p50H + totalAdjust);
    var p75 = lastClose * (1 + p75H + totalAdjust);
    var upper = lastClose * (1 + p90H + totalAdjust);

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

    var targetReturn = (horizonTarget - lastClose) / lastClose;
    var probHit;
    if (hRets.length < 30) {
      probHit = 0.5;
    } else {
      // Same exponential weighting as the baseline: recent bootstrap
      // draws count more than ancient ones.
      var n = hRets.length;
      var hitsW = 0, totalW = 0;
      for (var i = 0; i < n; i++) {
        var w = Math.pow(0.5, (n - 1 - i) / HALF_LIFE);
        var shifted = hRets[i] + totalAdjust;
        totalW += w;
        if (dirSign >= 0 ? shifted >= targetReturn : shifted <= targetReturn) hitsW += w;
      }
      probHit = totalW > 0 ? hitsW / totalW : 0.5;
    }

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

    var snr = sigmaH > 0 ? Math.abs(totalAdjust) / sigmaH : 0;
    var snrComponent = Math.max(0.05, Math.min(0.75, 0.20 + 0.45 * Math.min(1, snr / 1.5)));
    var bt = backtestDirection(candles, horizonDays, function (sigs) {
      var adj = contrib(calTrend, sigs.trend) + contrib(calMomentum, sigs.momentum) +
                contrib(calMeanRev, sigs.meanRev) + sigs.pattern;
      adj = Math.max(-adjustCap, Math.min(adjustCap, adj));
      return adj > 0.5 * sigmaH ? 1 : adj < -0.5 * sigmaH ? -1 : 0;
    });
    var btHit = bt.hitRate;
    var blended = btHit != null ? 0.55 * snrComponent + 0.45 * btHit : snrComponent;
    var confidence = Math.max(0.05, Math.min(0.85, blended));

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
      "Recency-weighted baseline (half-life " + HALF_LIFE + " sessions): μ_h=" +
      (muH * 100).toFixed(2) + "%, σ_h=" + (sigmaH * 100).toFixed(2) + "% " +
      "from " + hRets.length + " historical " + horizonDays + "-session windows. " +
      "Signal-adjust=" + (totalAdjust * 100).toFixed(2) + "%" + clampedTxt + ". " +
      anchorTxt + " " + hitTxt + stopTxt + " " + btTxt +
      (contribLines.length ? " Contributions: " + contribLines.join("  ·  ") + "." : "");

    return {
      direction: direction, label: label,
      score: snr * Math.sign(totalAdjust || 1),
      confidence: confidence,
      target: horizonTarget,
      lower: lower, upper: upper,
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
      contributions: contribs,
      baseline: { muH: muH, sigmaH: sigmaH, p10: p10H, p50: p50H, p90: p90H, n: hRets.length },
      totalAdjust: totalAdjust,
      rawAdjust: rawAdjust,
      adjustCap: adjustCap
    };
  }

  window.Forecast = {
    computeIndicators: computeIndicators,
    buildForecast: buildForecast,
    monteCarlo: monteCarlo,
    findKeyLevels: findKeyLevels
  };
})();
