// Wires the dashboard together: renders charts, runs detection, and produces
// a 5-session (one trading week on Tadawul: Sun–Thu) trend forecast.
(function () {
  var data = window.STOCK_DATA;
  var meta = window.STOCK_META;
  var closes = data.map(function (c) { return c.close; });
  var labels = data.map(function (c) { return c.date; });

  var sma20 = Indicators.sma(closes, 20);
  var sma50 = Indicators.sma(closes, 50);
  var rsi14 = Indicators.rsi(closes, 14);
  var macd = Indicators.macd(closes, 12, 26, 9);
  var atr14 = Indicators.atr(data, 14);

  // Header quote ----------------------------------------------------------
  var last = data[data.length - 1];
  var prev = data[data.length - 2];
  var change = last.close - prev.close;
  var changePct = (change / prev.close) * 100;
  document.getElementById("lastPrice").textContent = last.close.toFixed(2) + " SAR";
  var chEl = document.getElementById("lastChange");
  chEl.textContent = (change >= 0 ? "+" : "") + change.toFixed(2) +
    " (" + (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%)";
  chEl.classList.add(change >= 0 ? "up" : "down");
  document.getElementById("lastDate").textContent = "as of " + last.date;

  // Price chart -----------------------------------------------------------
  var ctx = document.getElementById("priceChart").getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: "Close", data: closes, borderColor: "#4f8cff", backgroundColor: "rgba(79,140,255,0.08)",
          pointRadius: 0, borderWidth: 1.6, tension: 0.15, fill: true },
        { label: "SMA20", data: sma20, borderColor: "#f1c453", pointRadius: 0, borderWidth: 1.2, tension: 0.2 },
        { label: "SMA50", data: sma50, borderColor: "#b48ce0", pointRadius: 0, borderWidth: 1.2, tension: 0.2 }
      ]
    },
    options: chartBase({ y: { ticks: { color: "#8a93b3" } } })
  });

  // RSI chart -------------------------------------------------------------
  new Chart(document.getElementById("rsiChart").getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: "RSI(14)", data: rsi14, borderColor: "#2dd4a4", pointRadius: 0, borderWidth: 1.4, tension: 0.2 },
        { label: "70", data: labels.map(function () { return 70; }), borderColor: "#ff5d6e", borderDash: [4,4], pointRadius: 0, borderWidth: 1 },
        { label: "30", data: labels.map(function () { return 30; }), borderColor: "#2dd4a4", borderDash: [4,4], pointRadius: 0, borderWidth: 1 }
      ]
    },
    options: chartBase({ y: { min: 0, max: 100, ticks: { color: "#8a93b3" } } })
  });
  var rsiLast = lastValid(rsi14);
  document.getElementById("rsiNote").textContent =
    "Latest RSI: " + (rsiLast != null ? rsiLast.toFixed(1) : "—") +
    (rsiLast >= 70 ? " — overbought" : rsiLast <= 30 ? " — oversold" : " — neutral");

  // MACD chart ------------------------------------------------------------
  new Chart(document.getElementById("macdChart").getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { type: "bar", label: "Histogram", data: macd.hist,
          backgroundColor: macd.hist.map(function (v) { return v >= 0 ? "rgba(45,212,164,0.55)" : "rgba(255,93,110,0.55)"; }) },
        { type: "line", label: "MACD", data: macd.line, borderColor: "#4f8cff", pointRadius: 0, borderWidth: 1.4 },
        { type: "line", label: "Signal", data: macd.signal, borderColor: "#f1c453", pointRadius: 0, borderWidth: 1.4 }
      ]
    },
    options: chartBase({ y: { ticks: { color: "#8a93b3" } } })
  });
  var macdLast = lastValid(macd.line);
  var sigLast = lastValid(macd.signal);
  document.getElementById("macdNote").textContent =
    macdLast != null && sigLast != null
      ? "MACD " + macdLast.toFixed(2) + " vs Signal " + sigLast.toFixed(2) +
        (macdLast > sigLast ? " — bullish cross/expansion" : " — bearish cross/expansion")
      : "—";

  // Pattern detection -----------------------------------------------------
  var patterns = Patterns.detectAll(data);
  var listEl = document.getElementById("patternList");
  if (patterns.length === 0) {
    listEl.innerHTML = '<p class="muted small">No high-confidence patterns matched in the recent window.</p>';
  } else {
    patterns.forEach(function (p) {
      var div = document.createElement("div");
      div.className = "pattern " + (p.bias === "bull" ? "bull" : p.bias === "bear" ? "bear" : "neutral");
      var statLine = p.stats
        ? "Avg post-breakout move: " + p.stats.avgMove + "%"
        : "";
      div.innerHTML =
        '<div class="pname">' + p.name + ' <span class="muted small">· ' + p.stage + '</span></div>' +
        '<div class="pmeta">Bias: <strong>' + p.bias.toUpperCase() + '</strong> · Confidence: ' +
            Math.round(p.confidence * 100) + '%</div>' +
        '<div class="pmeta">Neckline/key level: ' + p.neckline.toFixed(2) +
            ' · Measured target: ' + p.target.toFixed(2) + '</div>' +
        '<div class="pmeta">' + statLine + '</div>';
      listEl.appendChild(div);
    });
  }

  // Forecast --------------------------------------------------------------
  var forecast = buildForecast(data, patterns, { sma20: sma20, sma50: sma50, rsi: rsi14, macd: macd, atr: atr14 });
  applyForecast(forecast);

  // ----------------------------------------------------------------------

  function applyForecast(f) {
    var badge = document.getElementById("trendBadge");
    badge.textContent = f.label;
    badge.classList.add(f.direction);
    document.getElementById("targetPrice").textContent = f.target.toFixed(2) + " SAR";
    document.getElementById("targetRange").textContent =
      f.lower.toFixed(2) + " – " + f.upper.toFixed(2) + " SAR";
    document.getElementById("confidence").textContent = Math.round(f.confidence * 100) + "%";
    document.getElementById("rationale").textContent = f.rationale;
  }

  function lastValid(arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }

  function chartBase(scales) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
      scales: Object.assign({
        x: { ticks: { color: "#8a93b3", maxTicksLimit: 8 }, grid: { color: "rgba(255,255,255,0.04)" } }
      }, { y: Object.assign({ grid: { color: "rgba(255,255,255,0.04)" } }, (scales && scales.y) || {}) })
    };
  }

  function buildForecast(candles, patterns, ind) {
    var lastClose = candles[candles.length - 1].close;
    var atrLast = lastValid(ind.atr) || lastClose * 0.015;
    var rsiLast = lastValid(ind.rsi);
    var sma20Last = lastValid(ind.sma20);
    var sma50Last = lastValid(ind.sma50);
    var macdLast = lastValid(ind.macd.line);
    var sigLast = lastValid(ind.macd.signal);
    var histLast = lastValid(ind.macd.hist);

    // Score = sum of weighted directional votes in [-1, +1] each.
    var votes = [];

    // Pattern votes -----------------------------------------------------
    patterns.forEach(function (p) {
      var weight = p.confidence * (p.stats ? Math.min(1, Math.abs(p.stats.avgMove) / 30) : 0.5);
      var dir = p.bias === "bull" ? 1 : p.bias === "bear" ? -1 : 0;
      votes.push({
        source: "Pattern: " + p.name,
        direction: dir,
        weight: weight
      });
    });

    // Trend regime via SMAs --------------------------------------------
    if (sma20Last != null && sma50Last != null) {
      if (lastClose > sma20Last && sma20Last > sma50Last)
        votes.push({ source: "Price > SMA20 > SMA50 (uptrend)", direction: 1, weight: 0.6 });
      else if (lastClose < sma20Last && sma20Last < sma50Last)
        votes.push({ source: "Price < SMA20 < SMA50 (downtrend)", direction: -1, weight: 0.6 });
      else
        votes.push({ source: "SMA stack mixed", direction: 0, weight: 0.2 });
    }

    // RSI -------------------------------------------------------------
    if (rsiLast != null) {
      if (rsiLast >= 70) votes.push({ source: "RSI overbought (" + rsiLast.toFixed(0) + ")", direction: -0.5, weight: 0.4 });
      else if (rsiLast <= 30) votes.push({ source: "RSI oversold (" + rsiLast.toFixed(0) + ")", direction: 0.5, weight: 0.4 });
      else if (rsiLast > 55) votes.push({ source: "RSI bullish (" + rsiLast.toFixed(0) + ")", direction: 0.3, weight: 0.3 });
      else if (rsiLast < 45) votes.push({ source: "RSI bearish (" + rsiLast.toFixed(0) + ")", direction: -0.3, weight: 0.3 });
    }

    // MACD ------------------------------------------------------------
    if (macdLast != null && sigLast != null) {
      var macdDir = macdLast > sigLast ? 1 : -1;
      var strength = Math.min(1, Math.abs(histLast || 0) / (lastClose * 0.005));
      votes.push({ source: "MACD vs Signal", direction: macdDir, weight: 0.3 + 0.3 * strength });
    }

    var totalWeight = votes.reduce(function (s, v) { return s + v.weight; }, 0) || 1;
    var score = votes.reduce(function (s, v) { return s + v.direction * v.weight; }, 0) / totalWeight;
    // Score is in roughly [-1, 1]. Convert to expected % move over 5 sessions.
    // Cap expected move at ~2 ATRs.
    var expectedPct = score * (2 * atrLast / lastClose);
    var target = lastClose * (1 + expectedPct);
    var lower = target - atrLast * 1.2;
    var upper = target + atrLast * 1.2;

    var direction, label;
    if (score > 0.18) { direction = "up"; label = "BULLISH"; }
    else if (score < -0.18) { direction = "down"; label = "BEARISH"; }
    else { direction = "flat"; label = "NEUTRAL"; }

    // Confidence: agreement among votes (1 - dispersion)
    var meanDir = votes.reduce(function (s, v) { return s + v.direction; }, 0) / Math.max(1, votes.length);
    var variance = votes.reduce(function (s, v) { return s + Math.pow(v.direction - meanDir, 2); }, 0) /
      Math.max(1, votes.length);
    var confidence = Math.max(0.35, Math.min(0.92, Math.abs(score) * 1.6 + (1 - variance) * 0.25));

    // Build a rationale paragraph -------------------------------------
    var topVotes = votes.slice().sort(function (a, b) { return Math.abs(b.direction * b.weight) - Math.abs(a.direction * a.weight); });
    var bullets = topVotes.slice(0, 4).map(function (v) {
      var arrow = v.direction > 0 ? "↑" : v.direction < 0 ? "↓" : "·";
      return arrow + " " + v.source;
    }).join("  |  ");

    var rationale =
      "Composite score " + score.toFixed(2) + " across " + votes.length + " factors. " +
      "Per Bulkowski's statistics, the dominant pattern's average post-breakout move is reflected in the projected target. " +
      "Key drivers: " + bullets + ".";

    return {
      direction: direction,
      label: label,
      score: score,
      confidence: confidence,
      target: target,
      lower: lower,
      upper: upper,
      rationale: rationale
    };
  }
})();
