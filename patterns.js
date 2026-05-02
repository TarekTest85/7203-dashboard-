// Bulkowski-style chart pattern detection.
//
// Probabilities and average move statistics are sourced from
// Thomas N. Bulkowski's "Visual Guide to Chart Patterns" / "Encyclopedia of
// Chart Patterns" (Wiley). They represent average post-breakout behaviour
// across thousands of historical occurrences and are used here to score the
// next-week trend forecast.
(function () {
  // Reference statistics (post-breakout, all-market averages).
  var STATS = {
    "Head and Shoulders Top":      { bias: "bear", avgMove: -22, breakoutDown: 0.93, throwbackOrPullback: 0.50 },
    "Head and Shoulders Bottom":   { bias: "bull", avgMove:  38, breakoutUp:   0.95, throwbackOrPullback: 0.45 },
    "Double Top":                  { bias: "bear", avgMove: -20, breakoutDown: 0.79, throwbackOrPullback: 0.61 },
    "Double Bottom":               { bias: "bull", avgMove:  40, breakoutUp:   0.86, throwbackOrPullback: 0.64 },
    "Ascending Triangle":          { bias: "bull", avgMove:  35, breakoutUp:   0.70 },
    "Descending Triangle":         { bias: "bear", avgMove: -16, breakoutDown: 0.64 },
    "Symmetrical Triangle":        { bias: "neutral", avgMove: 31, breakoutEither: 1.0 },
    "Rising Wedge":                { bias: "bear", avgMove: -14, breakoutDown: 0.69 },
    "Falling Wedge":               { bias: "bull", avgMove:  32, breakoutUp:   0.68 },
    "Bull Flag":                   { bias: "bull", avgMove:  23, breakoutUp:   0.67 },
    "Bear Flag":                   { bias: "bear", avgMove: -10, breakoutDown: 0.65 },
    "Cup with Handle":             { bias: "bull", avgMove:  34, breakoutUp:   0.74 }
  };

  function linregSlope(xs, ys) {
    var n = xs.length;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i];
      sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return { m: 0, b: sy / n };
    var m = (n * sxy - sx * sy) / denom;
    var b = (sy - m * sx) / n;
    return { m: m, b: b };
  }

  function near(a, b, tolPct) {
    return Math.abs(a - b) / ((a + b) / 2) <= tolPct;
  }

  // Head and Shoulders Top / Bottom -----------------------------------------
  function detectHeadAndShoulders(candles, swings) {
    var found = [];
    var highs = swings.highs;
    var lows = swings.lows;

    // Top: requires 3 highs (LS, H, RS) with two intervening lows forming a neckline.
    for (var i = 0; i + 2 < highs.length; i++) {
      var ls = highs[i], hd = highs[i + 1], rs = highs[i + 2];
      if (!(hd.price > ls.price && hd.price > rs.price)) continue;
      if (!near(ls.price, rs.price, 0.05)) continue;

      // Find two lows between LS-H and H-RS.
      var l1 = lows.find(function (l) { return l.index > ls.index && l.index < hd.index; });
      var l2 = lows.find(function (l) { return l.index > hd.index && l.index < rs.index; });
      if (!l1 || !l2) continue;
      if (!near(l1.price, l2.price, 0.07)) continue;

      var neckline = (l1.price + l2.price) / 2;
      var lastClose = candles[candles.length - 1].close;
      var stage = lastClose < neckline ? "broken-down" : "forming";
      found.push({
        name: "Head and Shoulders Top",
        bias: "bear",
        confidence: stage === "broken-down" ? 0.82 : 0.55,
        neckline: neckline,
        target: neckline - (hd.price - neckline),
        anchorIndex: rs.index,
        stage: stage
      });
    }

    // Bottom: 3 lows with the middle the lowest.
    for (var k = 0; k + 2 < lows.length; k++) {
      var ll = lows[k], hl = lows[k + 1], rl = lows[k + 2];
      if (!(hl.price < ll.price && hl.price < rl.price)) continue;
      if (!near(ll.price, rl.price, 0.05)) continue;
      var h1 = highs.find(function (h) { return h.index > ll.index && h.index < hl.index; });
      var h2 = highs.find(function (h) { return h.index > hl.index && h.index < rl.index; });
      if (!h1 || !h2) continue;
      if (!near(h1.price, h2.price, 0.07)) continue;
      var neck = (h1.price + h2.price) / 2;
      var lc = candles[candles.length - 1].close;
      var st = lc > neck ? "broken-up" : "forming";
      found.push({
        name: "Head and Shoulders Bottom",
        bias: "bull",
        confidence: st === "broken-up" ? 0.82 : 0.55,
        neckline: neck,
        target: neck + (neck - hl.price),
        anchorIndex: rl.index,
        stage: st
      });
    }
    return found;
  }

  // Double Top / Bottom -----------------------------------------------------
  function detectDouble(candles, swings) {
    var found = [];
    var highs = swings.highs;
    var lows = swings.lows;

    for (var i = 0; i + 1 < highs.length; i++) {
      var a = highs[i], b = highs[i + 1];
      if (b.index - a.index < 8 || b.index - a.index > 70) continue;
      if (!near(a.price, b.price, 0.03)) continue;
      var trough = lows.find(function (l) { return l.index > a.index && l.index < b.index; });
      if (!trough) continue;
      if ((a.price - trough.price) / a.price < 0.07) continue;
      var lc = candles[candles.length - 1].close;
      var stage = lc < trough.price ? "broken-down" : "forming";
      found.push({
        name: "Double Top",
        bias: "bear",
        confidence: stage === "broken-down" ? 0.74 : 0.5,
        neckline: trough.price,
        target: trough.price - (a.price - trough.price),
        anchorIndex: b.index,
        stage: stage
      });
    }

    for (var j = 0; j + 1 < lows.length; j++) {
      var x = lows[j], y = lows[j + 1];
      if (y.index - x.index < 8 || y.index - x.index > 70) continue;
      if (!near(x.price, y.price, 0.03)) continue;
      var peak = highs.find(function (h) { return h.index > x.index && h.index < y.index; });
      if (!peak) continue;
      if ((peak.price - x.price) / x.price < 0.07) continue;
      var lc2 = candles[candles.length - 1].close;
      var st2 = lc2 > peak.price ? "broken-up" : "forming";
      found.push({
        name: "Double Bottom",
        bias: "bull",
        confidence: st2 === "broken-up" ? 0.78 : 0.55,
        neckline: peak.price,
        target: peak.price + (peak.price - x.price),
        anchorIndex: y.index,
        stage: st2
      });
    }
    return found;
  }

  // Triangles + Wedges ------------------------------------------------------
  function detectTriangleOrWedge(candles, swings) {
    var found = [];
    var highs = swings.highs.slice(-5);
    var lows = swings.lows.slice(-5);
    if (highs.length < 2 || lows.length < 2) return found;

    var hx = highs.map(function (p) { return p.index; });
    var hy = highs.map(function (p) { return p.price; });
    var lx = lows.map(function (p) { return p.index; });
    var ly = lows.map(function (p) { return p.price; });
    var topLine = linregSlope(hx, hy);
    var botLine = linregSlope(lx, ly);

    var topSlope = topLine.m;
    var botSlope = botLine.m;
    var avgPrice = (hy.reduce(function (a, b) { return a + b; }, 0) / hy.length +
                    ly.reduce(function (a, b) { return a + b; }, 0) / ly.length) / 2;
    // Normalize slope to % per session
    var topPct = topSlope / avgPrice;
    var botPct = botSlope / avgPrice;
    var lastIndex = candles.length - 1;
    var lastClose = candles[lastIndex].close;
    var topNow = topLine.m * lastIndex + topLine.b;
    var botNow = botLine.m * lastIndex + botLine.b;

    function pushTriangle(name, bias, baseConf) {
      var stage = "forming";
      if (lastClose > topNow * 1.005) stage = "broken-up";
      else if (lastClose < botNow * 0.995) stage = "broken-down";
      var conf = stage === "forming" ? baseConf : Math.min(0.85, baseConf + 0.15);
      found.push({
        name: name, bias: bias, confidence: conf,
        neckline: (topNow + botNow) / 2,
        target: bias === "bull"
          ? topNow + (topNow - botNow)
          : botNow - (topNow - botNow),
        anchorIndex: lastIndex,
        stage: stage
      });
    }

    if (Math.abs(topPct) < 0.0008 && botPct > 0.001) {
      pushTriangle("Ascending Triangle", "bull", 0.55);
    } else if (Math.abs(botPct) < 0.0008 && topPct < -0.001) {
      pushTriangle("Descending Triangle", "bear", 0.55);
    } else if (topPct < -0.0008 && botPct > 0.0008) {
      pushTriangle("Symmetrical Triangle", "neutral", 0.5);
    } else if (topPct > 0.001 && botPct > 0.001 && botPct > topPct) {
      pushTriangle("Rising Wedge", "bear", 0.5);
    } else if (topPct < -0.001 && botPct < -0.001 && topPct > botPct) {
      pushTriangle("Falling Wedge", "bull", 0.5);
    }
    return found;
  }

  // Flags (short consolidation after sharp move) ----------------------------
  function detectFlag(candles) {
    if (candles.length < 30) return [];
    var found = [];
    var n = candles.length;
    var pole = candles.slice(n - 25, n - 12);
    var flag = candles.slice(n - 12, n);
    if (pole.length < 5 || flag.length < 5) return [];
    var poleStart = pole[0].close;
    var poleEnd = pole[pole.length - 1].close;
    var poleMove = (poleEnd - poleStart) / poleStart;
    var flagHigh = Math.max.apply(null, flag.map(function (c) { return c.high; }));
    var flagLow = Math.min.apply(null, flag.map(function (c) { return c.low; }));
    var flagRange = (flagHigh - flagLow) / flag[0].close;
    if (flagRange > 0.07) return [];

    if (poleMove > 0.10) {
      found.push({
        name: "Bull Flag",
        bias: "bull",
        confidence: 0.55,
        neckline: flagHigh,
        target: flagHigh + (poleEnd - poleStart),
        anchorIndex: n - 1,
        stage: "forming"
      });
    } else if (poleMove < -0.10) {
      found.push({
        name: "Bear Flag",
        bias: "bear",
        confidence: 0.55,
        neckline: flagLow,
        target: flagLow + (poleEnd - poleStart),
        anchorIndex: n - 1,
        stage: "forming"
      });
    }
    return found;
  }

  // Cup with Handle ---------------------------------------------------------
  function detectCupWithHandle(candles) {
    var n = candles.length;
    if (n < 80) return [];
    var window = candles.slice(n - 80);
    var closes = window.map(function (c) { return c.close; });
    var first = closes[0], last = closes[closes.length - 1];
    if (!near(first, last, 0.04)) return [];
    var minIdx = 0, minVal = Infinity;
    for (var i = 0; i < closes.length; i++) if (closes[i] < minVal) { minVal = closes[i]; minIdx = i; }
    if (minIdx < 20 || minIdx > 60) return [];
    var depth = (Math.max(first, last) - minVal) / Math.max(first, last);
    if (depth < 0.10 || depth > 0.35) return [];
    // Handle: small pullback in last 8 bars
    var handle = closes.slice(-8);
    var hMin = Math.min.apply(null, handle), hMax = Math.max.apply(null, handle);
    if ((hMax - hMin) / hMax > 0.08) return [];
    var rim = Math.max(first, last);
    return [{
      name: "Cup with Handle",
      bias: "bull",
      confidence: 0.58,
      neckline: rim,
      target: rim + (rim - minVal),
      anchorIndex: n - 1,
      stage: candles[n - 1].close > rim ? "broken-up" : "forming"
    }];
  }

  function detectAll(candles) {
    var swings = window.Indicators.swings(candles, 5);
    var results = [].concat(
      detectHeadAndShoulders(candles, swings),
      detectDouble(candles, swings),
      detectTriangleOrWedge(candles, swings),
      detectFlag(candles),
      detectCupWithHandle(candles)
    );
    // Keep only the most recent occurrence of each pattern name.
    var byName = {};
    results.forEach(function (r) {
      if (!byName[r.name] || r.anchorIndex > byName[r.name].anchorIndex) byName[r.name] = r;
    });
    return Object.keys(byName).map(function (k) {
      var p = byName[k];
      p.stats = STATS[k];
      return p;
    });
  }

  window.Patterns = { detectAll: detectAll, STATS: STATS };
})();
