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

  function buildVotes(candles, patterns, ind) {
    var lastClose = candles[candles.length - 1].close;
    var rsiLast = lastValid(ind.rsi);
    var sma20Last = lastValid(ind.sma20);
    var sma50Last = lastValid(ind.sma50);
    var macdLast = lastValid(ind.macd.line);
    var sigLast = lastValid(ind.macd.signal);
    var histLast = lastValid(ind.macd.hist);
    var bbZ = lastValid(ind.bb.z);
    var adxLast = lastValid(ind.adx);
    var roc5 = lastValid(ind.roc5);
    var roc10 = lastValid(ind.roc10);
    var roc20 = lastValid(ind.roc20);
    var stochK = lastValid(ind.stoch.k);
    var stochD = lastValid(ind.stoch.d);

    var votes = [];

    // ── Bulkowski patterns: stage-discounted ──
    // A "forming" pattern is statistically less reliable than a confirmed
    // breakout. Halve its weight; double-down (1.2×) on confirmed ones.
    patterns.forEach(function (p) {
      var stageMul = (p.stage === "broken-up" || p.stage === "broken-down") ? 1.2
                   : (p.stage === "forming" ? 0.5 : 1.0);
      var statMul = p.stats ? Math.min(1, Math.abs(p.stats.avgMove) / 30) : 0.5;
      var weight = p.confidence * statMul * stageMul;
      var dir = p.bias === "bull" ? 1 : p.bias === "bear" ? -1 : 0;
      votes.push({ source: "Pattern: " + p.name + " (" + p.stage + ")", direction: dir, weight: weight });
    });

    // ── Trend regime: SMA stack + ADX strength ──
    // ADX < 20 → choppy; weight trend votes lower. ADX > 25 → strong trend.
    var trendAmp = adxLast == null ? 0.6 : Math.max(0.25, Math.min(1.1, (adxLast - 12) / 20));
    if (sma20Last != null && sma50Last != null) {
      if (lastClose > sma20Last && sma20Last > sma50Last)
        votes.push({ source: "Uptrend stack (ADX " + (adxLast||0).toFixed(0) + ")", direction: 1, weight: 0.6 * trendAmp });
      else if (lastClose < sma20Last && sma20Last < sma50Last)
        votes.push({ source: "Downtrend stack (ADX " + (adxLast||0).toFixed(0) + ")", direction: -1, weight: 0.6 * trendAmp });
      else
        votes.push({ source: "SMA stack mixed", direction: 0, weight: 0.2 });
    }

    // ── Momentum: 5/10/20-day ROC, weighted by recency ──
    if (roc5 != null) {
      var rocDir = Math.sign(roc5);
      var rocMag = Math.min(1, Math.abs(roc5) / 5); // 5% over 5d → full weight
      votes.push({ source: "Momentum 5d (" + roc5.toFixed(1) + "%)", direction: rocDir, weight: 0.5 * rocMag });
    }
    if (roc10 != null) {
      var rd = Math.sign(roc10);
      var rm = Math.min(1, Math.abs(roc10) / 8);
      votes.push({ source: "Momentum 10d (" + roc10.toFixed(1) + "%)", direction: rd, weight: 0.4 * rm });
    }
    if (roc20 != null) {
      var rd2 = Math.sign(roc20);
      var rm2 = Math.min(1, Math.abs(roc20) / 12);
      votes.push({ source: "Momentum 20d (" + roc20.toFixed(1) + "%)", direction: rd2, weight: 0.3 * rm2 });
    }

    // ── RSI: extremes (mean revert) and trend (continuation) ──
    if (rsiLast != null) {
      if (rsiLast >= 75) votes.push({ source: "RSI extreme overbought (" + rsiLast.toFixed(0) + ")", direction: -1, weight: 0.45 });
      else if (rsiLast >= 70) votes.push({ source: "RSI overbought (" + rsiLast.toFixed(0) + ")", direction: -0.5, weight: 0.35 });
      else if (rsiLast <= 25) votes.push({ source: "RSI extreme oversold (" + rsiLast.toFixed(0) + ")", direction: 1, weight: 0.45 });
      else if (rsiLast <= 30) votes.push({ source: "RSI oversold (" + rsiLast.toFixed(0) + ")", direction: 0.5, weight: 0.35 });
      else if (rsiLast > 55) votes.push({ source: "RSI bullish (" + rsiLast.toFixed(0) + ")", direction: 0.3, weight: 0.25 });
      else if (rsiLast < 45) votes.push({ source: "RSI bearish (" + rsiLast.toFixed(0) + ")", direction: -0.3, weight: 0.25 });
    }

    // ── MACD: with histogram strength ──
    if (macdLast != null && sigLast != null) {
      var macdDir = macdLast > sigLast ? 1 : -1;
      var strength = Math.min(1, Math.abs(histLast || 0) / (lastClose * 0.005));
      votes.push({ source: "MACD " + (macdDir > 0 ? "above" : "below") + " signal", direction: macdDir, weight: 0.3 + 0.3 * strength });
    }

    // ── Bollinger Band z-score: mean revert at extremes, continuation
    //    near the middle in a trending regime ──
    if (bbZ != null) {
      if (bbZ >= 2)        votes.push({ source: "BB z " + bbZ.toFixed(1) + " (above upper)", direction: -0.6, weight: 0.4 });
      else if (bbZ <= -2)  votes.push({ source: "BB z " + bbZ.toFixed(1) + " (below lower)", direction: 0.6, weight: 0.4 });
      else if (Math.abs(bbZ) < 0.4 && adxLast != null && adxLast > 22) {
        // In a trend, riding the middle is bullish/bearish in the trend's direction
        var trendDir = (sma20Last != null && sma50Last != null && sma20Last > sma50Last) ? 1
                     : (sma20Last != null && sma50Last != null && sma20Last < sma50Last) ? -1 : 0;
        if (trendDir !== 0) votes.push({ source: "BB middle in trend", direction: trendDir, weight: 0.2 });
      }
    }

    // ── Stochastic: cross + zone ──
    if (stochK != null && stochD != null) {
      if (stochK > 80 && stochD > 80) votes.push({ source: "Stochastic overbought", direction: -0.4, weight: 0.25 });
      else if (stochK < 20 && stochD < 20) votes.push({ source: "Stochastic oversold", direction: 0.4, weight: 0.25 });
      else votes.push({ source: "Stochastic " + (stochK > stochD ? "K>D" : "K<D"), direction: stochK > stochD ? 0.3 : -0.3, weight: 0.15 });
    }

    return votes;
  }

  function summariseScore(votes) {
    var totalWeight = votes.reduce(function (s, v) { return s + v.weight; }, 0) || 1;
    var score = votes.reduce(function (s, v) { return s + v.direction * v.weight; }, 0) / totalWeight;
    var meanDir = votes.reduce(function (s, v) { return s + v.direction; }, 0) / Math.max(1, votes.length);
    var variance = votes.reduce(function (s, v) { return s + Math.pow(v.direction - meanDir, 2); }, 0) /
      Math.max(1, votes.length);
    return { score: score, variance: variance, totalWeight: totalWeight };
  }

  // Walk-forward backtest. At each historical bar with enough indicator
  // warm-up, recompute votes using only data up to that bar (no look-
  // ahead), classify direction, and check against the actual horizon
  // return. Returns hit-rate and mean abs %-error of the score-implied
  // target. Used to calibrate displayed confidence.
  function backtest(candles, horizonDays) {
    var WARMUP = 60;
    var hits = 0, total = 0, sumAbsErr = 0, errN = 0;
    var deadband = 0.005; // ±0.5% considered "flat"
    for (var i = WARMUP; i < candles.length - horizonDays; i++) {
      var window = candles.slice(0, i + 1);
      var ind = computeIndicators(window);
      var pats = window.Patterns ? [] : Patterns.detectAll(window);
      var votes = buildVotes(window, pats, ind);
      if (votes.length < 3) continue;
      var s = summariseScore(votes).score;
      var atrLast = lastValid(ind.atr) || window[i].close * 0.015;
      var horizonScale = Math.sqrt(horizonDays / 5);
      var pct = s * (2 * atrLast / window[i].close) * horizonScale;

      var actual = (candles[i + horizonDays].close - candles[i].close) / candles[i].close;
      var predDir = s > 0.18 ? 1 : s < -0.18 ? -1 : 0;
      var actDir  = actual > deadband ? 1 : actual < -deadband ? -1 : 0;
      total++;
      if (predDir === actDir) hits++;
      sumAbsErr += Math.abs(actual - pct);
      errN++;
    }
    return {
      hitRate: total > 0 ? hits / total : null,
      count: total,
      mape: errN > 0 ? sumAbsErr / errN : null
    };
  }

  function buildForecast(candles, patterns, ind, horizonDays, weekend) {
    var lastBar = candles[candles.length - 1];
    var lastClose = lastBar.close;
    var atrLast = lastValid(ind.atr) || lastClose * 0.015;

    var votes = buildVotes(candles, patterns, ind);
    var s = summariseScore(votes);
    var score = s.score;
    var variance = s.variance;

    // Horizon scaling on the score-implied move (√t diffusion).
    var horizonScale = Math.sqrt(horizonDays / 5);
    var horizonPct = score * (2 * atrLast / lastClose) * horizonScale;
    var horizonTarget = lastClose * (1 + horizonPct);

    // σ-based diffusion bands. σ_daily comes from the last 60 daily
    // log-ish returns. Day-i 80% interval ≈ ±1.28·σ·√i around the drift.
    var sigma = ind.sigma || 0.012; // fallback 1.2% daily vol
    var Z80 = 1.28;
    var muDaily = horizonPct / horizonDays;

    var dates = nextTradingDays(lastBar.date, horizonDays, weekend);
    var days = dates.map(function (date, i) {
      var t = i + 1;
      var target = lastClose * (1 + muDaily * t);
      var bandPct = Z80 * sigma * Math.sqrt(t);
      var lower = target - lastClose * bandPct;
      var upper = target + lastClose * bandPct;
      var dir = target > lastClose * 1.001 ? "up"
              : target < lastClose * 0.999 ? "down" : "flat";
      // Per-day confidence decays with horizon and is gated by score
      // strength + a humility cap.
      var conf = Math.max(0.10, Math.min(0.85, Math.abs(score) * 1.4 + 0.30)) *
                 Math.pow(0.94, i);
      return {
        date: date, dayIndex: t,
        target: target, lower: lower, upper: upper,
        direction: dir, confidence: conf
      };
    });

    var direction = score > 0.18 ? "up" : score < -0.18 ? "down" : "flat";
    var label = direction === "up" ? "BULLISH" : direction === "down" ? "BEARISH" : "NEUTRAL";

    // ── Confidence calibration ──
    // 1) Base = |score| × agreement × vote-count factor × regime factor
    var voteCountFactor = 1 - 1 / (votes.length + 1);     // more votes → more weight
    var agreementFactor = 1 - Math.min(1, variance);      // tight directional vote = high
    // High-vol regime → less confident: compare current ATR to recent median.
    var atrMed = (function () {
      var vals = ind.atr.filter(function (v) { return v != null; }).slice(-60);
      vals.sort(function (a, b) { return a - b; });
      return vals.length ? vals[Math.floor(vals.length / 2)] : atrLast;
    })();
    var regimeFactor = atrMed ? Math.max(0.6, Math.min(1, atrMed / atrLast)) : 1;
    var horizonDecay = Math.pow(0.90, (horizonDays / 5) - 1);

    var rawConf = Math.abs(score) * 1.4 * voteCountFactor * agreementFactor * regimeFactor * horizonDecay
                  + 0.10 * agreementFactor;

    // 2) Calibrate against backtest hit rate (weighted blend). Caps the
    //    displayed confidence so an unproven model can't show 95%.
    var bt = backtest(candles, horizonDays);
    var blended = bt.hitRate != null
      ? rawConf * 0.55 + bt.hitRate * 0.45
      : rawConf;
    var confidence = Math.max(0.05, Math.min(0.88, blended));

    var topVotes = votes.slice().sort(function (a, b) {
      return Math.abs(b.direction * b.weight) - Math.abs(a.direction * a.weight);
    });
    var bullets = topVotes.slice(0, 5).map(function (v) {
      var arrow = v.direction > 0 ? "↑" : v.direction < 0 ? "↓" : "·";
      return arrow + " " + v.source;
    }).join("   ·   ");

    var btTxt = bt.hitRate != null
      ? "Walk-forward backtest on this series: " + Math.round(bt.hitRate * 100) +
        "% direction hit-rate over " + bt.count + " " + horizonDays + "-session windows."
      : "Insufficient history for a backtest at this horizon.";

    var rationale =
      "Composite score " + score.toFixed(2) + " across " + votes.length + " factors over " +
      horizonDays + " sessions (" + (horizonDays / 5) + "-week horizon). " +
      "Targets use √t diffusion drift; per-day bands are ±1.28·σ·√t (≈80% interval) using σ=" +
      (sigma * 100).toFixed(2) + "% daily. Confidence is calibrated against the in-sample " +
      "backtest hit-rate. Drivers: " + bullets + ". " + btTxt;

    var bandPctEnd = Z80 * sigma * Math.sqrt(horizonDays);
    var bandWidthEnd = lastClose * bandPctEnd;
    return {
      direction: direction, label: label, score: score, confidence: confidence,
      target: horizonTarget,
      lower: horizonTarget - bandWidthEnd, upper: horizonTarget + bandWidthEnd,
      days: days, rationale: rationale, lastClose: lastClose,
      horizonDays: horizonDays,
      backtest: bt
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

    // ── Price chart with forecast trail ──
    var fcLabels = forecast.days.map(function (d) { return d.date; });
    var fcSeries = forecast.days.map(function (d) { return d.target; });
    var fullLabels = labels.concat(fcLabels);
    var pad = function (arr) { return arr.concat(fcLabels.map(function () { return null; })); };
    var fcAligned = labels.map(function () { return null; }).concat(fcSeries);
    fcAligned[labels.length - 1] = closes[closes.length - 1];

    if (chartRefs.price) chartRefs.price.destroy();
    chartRefs.price = new Chart(document.getElementById("priceChart").getContext("2d"), {
      type: "line",
      data: {
        labels: fullLabels,
        datasets: [
          { label: "Close", data: pad(closes), borderColor: "#6aa3ff", backgroundColor: "rgba(106,163,255,0.10)",
            pointRadius: 0, borderWidth: 2, tension: 0.18, fill: true },
          { label: "SMA 20", data: pad(sma20), borderColor: "#ffc960", pointRadius: 0, borderWidth: 1.4, tension: 0.2 },
          { label: "SMA 50", data: pad(sma50), borderColor: "#b48cff", pointRadius: 0, borderWidth: 1.4, tension: 0.2 },
          { label: "Forecast", data: fcAligned, borderColor: "#2ee0a4", borderDash: [6, 4], pointRadius: 3, pointBackgroundColor: "#2ee0a4", borderWidth: 2, tension: 0.1 }
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
    document.getElementById("targetRange").textContent = fmtSAR(f.lower) + " – " + fmtSAR(f.upper) + " " + ccy;
    document.getElementById("compositeScore").textContent =
      (f.score >= 0 ? "+" : "") + f.score.toFixed(2) + "  (" + (f.score * 100).toFixed(0) + "/100)";

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
          "Backtest hit rate <strong>" + Math.round(bt.hitRate * 100) +
          "%</strong> over <strong>" + bt.count + "</strong> walks · MAPE " +
          (bt.mape != null ? (bt.mape * 100).toFixed(1) + "%" : "—");
      } else {
        btEl.textContent = "Backtest: insufficient history";
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
