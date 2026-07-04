// levels.js — Fibonacci retracements + classic pivot points.
//
// Fibonacci: identifies the dominant swing over `lookback` bars (from the
// most extreme high AND the most extreme low), determines which came last
// to set the swing direction, and generates the standard retracement
// levels (23.6, 38.2, 50, 61.8, 78.6 %) plus extension targets (127.2,
// 161.8, 200 %) for the countertrend / trend-continuation cases.
//
// Classic pivots use the prior N sessions (default 5 = last week on
// Tadawul) to compute PP, R1/R2/R3, S1/S2/S3 for the current bar.
(function () {
  function fibonacci(candles, opts) {
    opts = opts || {};
    var lookback = Math.min(candles.length, opts.lookback || 60);
    if (lookback < 10) return null;
    var start = candles.length - lookback;
    var highIdx = start, lowIdx = start;
    var high = candles[start].high, low = candles[start].low;
    for (var i = start + 1; i < candles.length; i++) {
      if (candles[i].high > high) { high = candles[i].high; highIdx = i; }
      if (candles[i].low < low)   { low  = candles[i].low;  lowIdx  = i; }
    }
    var direction = highIdx > lowIdx ? "up" : "down"; // last leg direction
    var rng = high - low;
    if (rng <= 0) return null;

    var ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
    var retracements = ratios.map(function (r) {
      return {
        ratio: r,
        label: (r * 100).toFixed(1) + "%",
        // Retracement measured back from the last leg's move
        price: direction === "up" ? high - rng * r : low + rng * r
      };
    });

    var extRatios = [1.272, 1.618, 2.0];
    var extensions = extRatios.map(function (r) {
      return {
        ratio: r,
        label: (r * 100).toFixed(1) + "%",
        price: direction === "up" ? low + rng * r : high - rng * r
      };
    });

    return {
      lookback: lookback,
      swingHigh: { price: high, date: candles[highIdx].date },
      swingLow:  { price: low,  date: candles[lowIdx].date },
      direction: direction,
      retracements: retracements,
      extensions: extensions
    };
  }

  // Classic pivots based on last N sessions' aggregate H/L/C.
  function classicPivots(candles, opts) {
    opts = opts || {};
    var lookback = Math.min(candles.length, opts.lookback || 5);
    if (lookback < 1) return null;
    var recent = candles.slice(-lookback);
    var high = -Infinity, low = Infinity;
    recent.forEach(function (c) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    });
    var close = candles[candles.length - 1].close;
    var pp = (high + low + close) / 3;
    return {
      lookback: lookback,
      PP: pp,
      R1: 2 * pp - low,
      R2: pp + (high - low),
      R3: high + 2 * (pp - low),
      S1: 2 * pp - high,
      S2: pp - (high - low),
      S3: low - 2 * (high - pp)
    };
  }

  // Returns the level (fib or pivot) closest to a given price along with
  // its distance in ATRs (used for "near a fib / pivot level" rules).
  function nearestLevel(price, fib, pivots, atr) {
    var candidates = [];
    if (fib) {
      fib.retracements.forEach(function (r) {
        candidates.push({ kind: "fib", label: r.label, price: r.price });
      });
    }
    if (pivots) {
      ["S3","S2","S1","PP","R1","R2","R3"].forEach(function (k) {
        candidates.push({ kind: "pivot", label: k, price: pivots[k] });
      });
    }
    if (!candidates.length || !isFinite(atr) || atr <= 0) return null;
    candidates.forEach(function (c) { c.distATR = Math.abs(price - c.price) / atr; });
    candidates.sort(function (a, b) { return a.distATR - b.distATR; });
    return candidates[0];
  }

  window.Levels = {
    fibonacci: fibonacci,
    classicPivots: classicPivots,
    nearestLevel: nearestLevel
  };
})();
