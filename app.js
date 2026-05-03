// Wires the dashboard together: renders charts, runs detection, and
// produces a per-session forecast for the next 5 Tadawul sessions
// (Sun–Thu). Re-renders when live data arrives.
(function () {
  var chartRefs = { price: null, rsi: null, macd: null };
  var TADAWUL_WEEKEND = { 5: true, 6: true }; // Fri (5), Sat (6) closed

  function nextTradingDays(fromDateStr, n) {
    var d = new Date(fromDateStr + "T00:00:00Z");
    var out = [];
    while (out.length < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (!TADAWUL_WEEKEND[d.getUTCDay()]) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function lastValid(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }

  function fmtSAR(n) { return n.toFixed(2); }

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

  // ─────────────────  Forecast logic  ─────────────────
  function buildVotes(candles, patterns, ind) {
    var lastClose = candles[candles.length - 1].close;
    var rsiLast = lastValid(ind.rsi);
    var sma20Last = lastValid(ind.sma20);
    var sma50Last = lastValid(ind.sma50);
    var macdLast = lastValid(ind.macd.line);
    var sigLast = lastValid(ind.macd.signal);
    var histLast = lastValid(ind.macd.hist);

    var votes = [];

    patterns.forEach(function (p) {
      var weight = p.confidence * (p.stats ? Math.min(1, Math.abs(p.stats.avgMove) / 30) : 0.5);
      var dir = p.bias === "bull" ? 1 : p.bias === "bear" ? -1 : 0;
      votes.push({ source: "Pattern: " + p.name, direction: dir, weight: weight });
    });

    if (sma20Last != null && sma50Last != null) {
      if (lastClose > sma20Last && sma20Last > sma50Last)
        votes.push({ source: "Price > SMA20 > SMA50 (uptrend)", direction: 1, weight: 0.6 });
      else if (lastClose < sma20Last && sma20Last < sma50Last)
        votes.push({ source: "Price < SMA20 < SMA50 (downtrend)", direction: -1, weight: 0.6 });
      else
        votes.push({ source: "SMA stack mixed", direction: 0, weight: 0.2 });
    }

    if (rsiLast != null) {
      if (rsiLast >= 70) votes.push({ source: "RSI overbought (" + rsiLast.toFixed(0) + ")", direction: -0.5, weight: 0.4 });
      else if (rsiLast <= 30) votes.push({ source: "RSI oversold (" + rsiLast.toFixed(0) + ")", direction: 0.5, weight: 0.4 });
      else if (rsiLast > 55) votes.push({ source: "RSI bullish (" + rsiLast.toFixed(0) + ")", direction: 0.3, weight: 0.3 });
      else if (rsiLast < 45) votes.push({ source: "RSI bearish (" + rsiLast.toFixed(0) + ")", direction: -0.3, weight: 0.3 });
    }

    if (macdLast != null && sigLast != null) {
      var macdDir = macdLast > sigLast ? 1 : -1;
      var strength = Math.min(1, Math.abs(histLast || 0) / (lastClose * 0.005));
      votes.push({ source: "MACD vs Signal", direction: macdDir, weight: 0.3 + 0.3 * strength });
    }
    return votes;
  }

  function buildForecast(candles, patterns, ind) {
    var lastBar = candles[candles.length - 1];
    var lastClose = lastBar.close;
    var atrLast = lastValid(ind.atr) || lastClose * 0.015;

    var votes = buildVotes(candles, patterns, ind);
    var totalWeight = votes.reduce(function (s, v) { return s + v.weight; }, 0) || 1;
    var score = votes.reduce(function (s, v) { return s + v.direction * v.weight; }, 0) / totalWeight;

    // Per-day projection: linearly walk toward 5-session target with widening bands.
    var fiveDayPct = score * (2 * atrLast / lastClose);
    var fiveDayTarget = lastClose * (1 + fiveDayPct);

    var dates = nextTradingDays(lastBar.date, 5);
    var days = dates.map(function (date, i) {
      var step = (i + 1) / 5;
      var target = lastClose + (fiveDayTarget - lastClose) * step;
      var bandWidth = atrLast * (0.8 + 0.4 * (i + 1));
      var lower = target - bandWidth;
      var upper = target + bandWidth;
      var dayPct = (target - lastClose) / lastClose;
      var dir = score > 0.18 ? "up" : score < -0.18 ? "down" : "flat";
      // Confidence decays with horizon (less certain further out)
      var conf = Math.max(0.20, Math.min(0.95, Math.abs(score) * 1.5 + 0.35)) *
                 Math.pow(0.93, i);
      return {
        date: date, dayIndex: i + 1,
        target: target, lower: lower, upper: upper,
        direction: dir, confidence: conf, pct: dayPct
      };
    });

    var direction = score > 0.18 ? "up" : score < -0.18 ? "down" : "flat";
    var label = direction === "up" ? "BULLISH" : direction === "down" ? "BEARISH" : "NEUTRAL";

    // Composite confidence: vote agreement × magnitude
    var meanDir = votes.reduce(function (s, v) { return s + v.direction; }, 0) / Math.max(1, votes.length);
    var variance = votes.reduce(function (s, v) { return s + Math.pow(v.direction - meanDir, 2); }, 0) /
      Math.max(1, votes.length);
    var confidence = Math.max(0.20, Math.min(0.95, Math.abs(score) * 1.6 + (1 - variance) * 0.3));

    var topVotes = votes.slice().sort(function (a, b) {
      return Math.abs(b.direction * b.weight) - Math.abs(a.direction * a.weight);
    });
    var bullets = topVotes.slice(0, 4).map(function (v) {
      var arrow = v.direction > 0 ? "↑" : v.direction < 0 ? "↓" : "·";
      return arrow + " " + v.source;
    }).join("   ·   ");

    var rationale =
      "Composite score " + score.toFixed(2) + " across " + votes.length + " factors. " +
      "Bulkowski's post-breakout statistics from the dominant pattern feed the projected target. " +
      "Per-day confidence decays with horizon. Key drivers: " + bullets + ".";

    return {
      direction: direction, label: label, score: score, confidence: confidence,
      target: fiveDayTarget, lower: fiveDayTarget - atrLast * 1.2, upper: fiveDayTarget + atrLast * 1.2,
      days: days, rationale: rationale, lastClose: lastClose
    };
  }

  // ─────────────────  Render  ─────────────────
  function render(data, source) {
    var closes = data.map(function (c) { return c.close; });
    var labels = data.map(function (c) { return c.date; });

    var sma20 = Indicators.sma(closes, 20);
    var sma50 = Indicators.sma(closes, 50);
    var rsi14 = Indicators.rsi(closes, 14);
    var macd = Indicators.macd(closes, 12, 26, 9);
    var atr14 = Indicators.atr(data, 14);

    // Hero
    var last = data[data.length - 1];
    var prev = data[data.length - 2];
    var change = last.close - prev.close;
    var changePct = (change / prev.close) * 100;

    document.getElementById("lastPrice").textContent = fmtSAR(last.close);
    var chEl = document.getElementById("lastChange");
    chEl.textContent = (change >= 0 ? "+" : "") + change.toFixed(2) +
      "  (" + (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%)";
    chEl.classList.remove("up", "down");
    chEl.classList.add(change >= 0 ? "up" : "down");
    document.getElementById("lastDate").textContent = "as of " + last.date;

    // Stats row
    document.getElementById("statDayRange").textContent = fmtSAR(last.low) + " – " + fmtSAR(last.high);
    var minClose = Math.min.apply(null, closes), maxClose = Math.max.apply(null, closes);
    document.getElementById("stat52Range").textContent = fmtSAR(minClose) + " – " + fmtSAR(maxClose);
    var sma20Last = lastValid(sma20), sma50Last = lastValid(sma50);
    document.getElementById("statSma").textContent =
      (sma20Last != null ? fmtSAR(sma20Last) : "—") + " / " +
      (sma50Last != null ? fmtSAR(sma50Last) : "—");
    var rsiLast = lastValid(rsi14);
    document.getElementById("statRsi").textContent = rsiLast != null ? rsiLast.toFixed(1) : "—";

    // Source pill
    var srcEl = document.getElementById("dataSource");
    srcEl.classList.remove("live", "fallback");
    if (source === "live") {
      srcEl.textContent = "live · " + last.date;
      srcEl.classList.add("live");
      srcEl.title = "Live data from Yahoo Finance · last close " + last.date;
    } else {
      srcEl.textContent = "demo · " + last.date;
      srcEl.classList.add("fallback");
      srcEl.title = "Live fetch unavailable. Showing fallback anchored to verified Tadawul close on " + last.date + ".";
    }

    // ── Build forecast ──
    var patterns = Patterns.detectAll(data);
    var forecast = buildForecast(data, patterns, { sma20: sma20, sma50: sma50, rsi: rsi14, macd: macd, atr: atr14 });

    // ── Price chart with forecast trail ──
    var fcLabels = forecast.days.map(function (d) { return d.date; });
    var fcSeries = forecast.days.map(function (d) { return d.target; });
    var fullLabels = labels.concat(fcLabels);
    var pad = function (arr) { return arr.concat(fcLabels.map(function () { return null; })); };
    var fcAligned = labels.map(function () { return null; })
      .concat(fcSeries);
    // Make the forecast line connect from the last actual close
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

    // ── Forecast UI ──
    applyForecast(forecast);
  }

  function applyForecast(f) {
    var badge = document.getElementById("trendBadge");
    badge.textContent = f.label;
    badge.classList.remove("up", "down", "flat");
    badge.classList.add(f.direction);

    document.getElementById("targetPrice").textContent = fmtSAR(f.target) + " SAR";
    document.getElementById("targetRange").textContent = fmtSAR(f.lower) + " – " + fmtSAR(f.upper) + " SAR";
    document.getElementById("compositeScore").textContent =
      (f.score >= 0 ? "+" : "") + f.score.toFixed(2) + "  (" + (f.score * 100).toFixed(0) + "/100)";

    // Confidence gauge — 1 to 100%
    var pct = Math.max(1, Math.min(100, Math.round(f.confidence * 100)));
    var gauge = document.getElementById("confidenceGauge");
    var color = f.direction === "up" ? "var(--green)" : f.direction === "down" ? "var(--red)" : "var(--yellow)";
    gauge.style.setProperty("--pct", pct);
    gauge.style.setProperty("--color", color);
    document.getElementById("confidencePct").textContent = pct + "%";

    document.getElementById("rationale").textContent = f.rationale;

    // Per-day cards
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
        '<div class="day-target">' + fmtSAR(d.target) + '<span class="day-target-currency">SAR</span></div>' +
        '<div class="day-range">' + fmtSAR(d.lower) + ' – ' + fmtSAR(d.upper) + '</div>' +
        '<div class="day-conf">' +
          '<div class="day-conf-bar"><div class="day-conf-fill" style="width:' + conf + '%"></div></div>' +
          '<span class="day-conf-num">' + conf + '%</span>' +
        '</div>';
      grid.appendChild(div);
    });
  }

  // ─────────────────  Bootstrap  ─────────────────
  render(window.STOCK_DATA, "fallback");

  async function refresh() {
    var btn = document.getElementById("refreshBtn");
    btn.disabled = true;
    var label = btn.querySelector(".btn-icon").nextSibling;
    try {
      var res = await window.LiveData.load();
      if (res && res.rows && res.rows.length) render(res.rows, "live");
    } catch (e) { /* keep fallback */ }
    btn.disabled = false;
  }

  document.getElementById("refreshBtn").addEventListener("click", refresh);

  // Chart toggle (persisted)
  var chartWrap = document.getElementById("priceChartWrap");
  var toggleBtn = document.getElementById("chartToggle");
  var STORAGE_KEY = "elm7203.chartHidden";
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
  applyToggle(localStorage.getItem(STORAGE_KEY) === "1");
  toggleBtn.addEventListener("click", function () {
    var nowHidden = !chartWrap.classList.contains("hidden");
    localStorage.setItem(STORAGE_KEY, nowHidden ? "1" : "0");
    applyToggle(nowHidden);
  });

  refresh();
})();
