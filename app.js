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

  // ── Render ──
  function render(opts) {
    opts = opts || {};
    var data = state.rows;
    var symbol = state.symbol;
    var horizonDays = state.horizonWeeks * 5;
    var weekend = weekendSet(symbol);
    var ccy = currencyOf(symbol);

    var ind = window.Forecast.computeIndicators(data);
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
    var forecast = window.Forecast.buildForecast(data, patterns, ind, horizonDays, weekend);
    forecast.signals = window.SignalEngine.evaluate(data, ind, horizonDays, forecast);

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
        rationale: forecast.rationale,
        signals: forecast.signals
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

    // ── Action bar (BUY/HOLD/SELL + R:R + position size) ──
    if (f.signals) {
      var sig = f.signals;
      var actionBadge = document.getElementById("actionBadge");
      var actionSub = document.getElementById("actionSub");
      actionBadge.classList.remove("action-buy", "action-sell", "action-hold");
      actionBadge.classList.add("action-" + sig.action.toLowerCase());
      actionBadge.querySelector(".action-label").textContent = sig.action;
      var confTxt = Math.round((sig.confidence || 0) * 100) + "% rule confidence";
      var firedTxt = (sig.firedBuy + sig.firedSell) === 0
        ? "No rule fired" : (sig.firedBuy + sig.firedSell) + " rule" +
          ((sig.firedBuy + sig.firedSell) === 1 ? "" : "s") + " fired";
      actionSub.textContent = firedTxt + " · " + confTxt;

      document.getElementById("actionFiredBuy").textContent = sig.firedBuy;
      document.getElementById("actionFiredSell").textContent = sig.firedSell;

      var rrEl = document.getElementById("actionRR");
      var rrSubEl = document.getElementById("actionRRSub");
      if (sig.rr != null) {
        rrEl.textContent = sig.rr.toFixed(2) + " : 1";
        rrSubEl.textContent = "reward " + sig.rewardPct.toFixed(2) +
          "% / risk " + sig.riskPct.toFixed(2) + "%";
      } else {
        rrEl.textContent = "—";
        rrSubEl.textContent = "no invalidation level found";
      }

      var posEl = document.getElementById("actionPos");
      if (sig.positionPct != null && sig.action !== "HOLD") {
        posEl.textContent = (sig.positionPct * 100).toFixed(1) + "%";
      } else {
        posEl.textContent = sig.action === "HOLD" ? "—" : "0%";
      }

      // Rules table
      var rulesTbody = document.getElementById("rulesBody");
      var rulesSummary = document.getElementById("rulesSummary");
      rulesTbody.innerHTML = "";
      sig.rules.forEach(function (rule) {
        var tr = document.createElement("tr");
        var actionTag = '<span class="rule-tag rule-tag-' + rule.action.toLowerCase() + '">' + rule.action + '</span>';
        var statusHtml;
        if (rule.fired) {
          statusHtml = '<span class="rule-fired ' + (rule.action === "SELL" ? "sell" : "") + '">FIRED NOW</span>';
        } else if (rule.barsAgo != null) {
          statusHtml = '<span class="rule-quiet">' + rule.barsAgo + ' bars ago</span>';
        } else {
          statusHtml = '<span class="rule-quiet">no recent fire</span>';
        }
        var hitTxt = rule.hitRate != null ? Math.round(rule.hitRate * 100) + "%" : "—";
        var fwdTxt = rule.avgReturn != null
          ? (rule.avgReturn >= 0 ? "+" : "") + (rule.avgReturn * 100).toFixed(2) + "%"
          : "—";
        tr.innerHTML =
          '<td><span class="rule-name">' + rule.name + '</span>' +
              '<span class="rule-desc">' + rule.description + '</span></td>' +
          '<td>' + actionTag + '</td>' +
          '<td>' + statusHtml + '</td>' +
          '<td class="num">' + hitTxt + '</td>' +
          '<td class="num">' + fwdTxt + '</td>' +
          '<td class="num">' + rule.fires + '</td>';
        rulesTbody.appendChild(tr);
      });
      if (rulesSummary) {
        rulesSummary.textContent = "Score " + (sig.score >= 0 ? "+" : "") + sig.score.toFixed(2) +
          " · " + sig.firedBuy + " buy · " + sig.firedSell + " sell · weighted by hit-rate × strength";
      }
    }

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
