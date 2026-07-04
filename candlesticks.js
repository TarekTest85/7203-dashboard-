// candlesticks.js — Canonical Japanese candlestick pattern detection.
//
// Each detector takes (candles, i) and returns { detected, strength }.
// Strength ∈ [0, 1] scales with how cleanly the geometry matches.
//
// Patterns split by direction:
//   bull: Bullish Engulfing, Hammer, Piercing, Morning Star, Three White Soldiers, Dragonfly Doji
//   bear: Bearish Engulfing, Shooting Star, Dark Cloud, Evening Star, Three Black Crows, Gravestone Doji
(function () {
  function body(c) { return Math.abs(c.close - c.open); }
  function range(c) { return Math.max(1e-9, c.high - c.low); }
  function upper(c) { return c.high - Math.max(c.open, c.close); }
  function lower(c) { return Math.min(c.open, c.close) - c.low; }
  function bull(c) { return c.close > c.open; }
  function bear(c) { return c.close < c.open; }

  function priorTrend(candles, i, lookback, direction) {
    // True if the previous `lookback` bars trend in `direction` ("up"/"down")
    var start = Math.max(0, i - lookback);
    if (start >= i - 1) return false;
    var first = candles[start].close, last = candles[i - 1].close;
    if (direction === "down") return last < first;
    return last > first;
  }

  var PATTERNS = [
    {
      key: "bull_engulfing", name: "Bullish Engulfing", direction: "bull",
      description: "Bearish bar fully engulfed by next bullish bar's body",
      detect: function (c, i) {
        if (i < 1) return null;
        var p = c[i - 1], t = c[i];
        if (!(bear(p) && bull(t))) return null;
        if (!(t.open <= p.close && t.close >= p.open)) return null;
        if (body(t) <= body(p)) return null;
        return { strength: Math.min(1, body(t) / (body(p) + 1e-9) / 3) };
      }
    },
    {
      key: "bear_engulfing", name: "Bearish Engulfing", direction: "bear",
      description: "Bullish bar fully engulfed by next bearish bar's body",
      detect: function (c, i) {
        if (i < 1) return null;
        var p = c[i - 1], t = c[i];
        if (!(bull(p) && bear(t))) return null;
        if (!(t.open >= p.close && t.close <= p.open)) return null;
        if (body(t) <= body(p)) return null;
        return { strength: Math.min(1, body(t) / (body(p) + 1e-9) / 3) };
      }
    },
    {
      key: "hammer", name: "Hammer", direction: "bull",
      description: "Small body near top, long lower wick, after a decline",
      detect: function (c, i) {
        var t = c[i], b = body(t), r = range(t);
        if (b / r > 0.35) return null;
        if (lower(t) < 2 * b) return null;
        if (upper(t) > 0.30 * r) return null;
        if (!priorTrend(c, i, 5, "down")) return null;
        return { strength: Math.min(1, lower(t) / (b * 3 + 1e-9)) };
      }
    },
    {
      key: "shooting_star", name: "Shooting Star", direction: "bear",
      description: "Small body near bottom, long upper wick, after a rise",
      detect: function (c, i) {
        var t = c[i], b = body(t), r = range(t);
        if (b / r > 0.35) return null;
        if (upper(t) < 2 * b) return null;
        if (lower(t) > 0.30 * r) return null;
        if (!priorTrend(c, i, 5, "up")) return null;
        return { strength: Math.min(1, upper(t) / (b * 3 + 1e-9)) };
      }
    },
    {
      key: "piercing", name: "Piercing Line", direction: "bull",
      description: "Bearish bar; next opens below its low, closes above its midpoint",
      detect: function (c, i) {
        if (i < 1) return null;
        var p = c[i - 1], t = c[i];
        if (!bear(p) || !bull(t)) return null;
        if (t.open >= p.low) return null;
        var mid = (p.open + p.close) / 2;
        if (t.close <= mid || t.close >= p.open) return null;
        return { strength: 0.7 };
      }
    },
    {
      key: "dark_cloud", name: "Dark Cloud Cover", direction: "bear",
      description: "Bullish bar; next opens above its high, closes below its midpoint",
      detect: function (c, i) {
        if (i < 1) return null;
        var p = c[i - 1], t = c[i];
        if (!bull(p) || !bear(t)) return null;
        if (t.open <= p.high) return null;
        var mid = (p.open + p.close) / 2;
        if (t.close >= mid || t.close <= p.open) return null;
        return { strength: 0.7 };
      }
    },
    {
      key: "morning_star", name: "Morning Star", direction: "bull",
      description: "Large bearish → small-body gap-down → large bullish closing above bar-1 midpoint",
      detect: function (c, i) {
        if (i < 2) return null;
        var b1 = c[i - 2], b2 = c[i - 1], b3 = c[i];
        if (!bear(b1) || !bull(b3)) return null;
        if (body(b1) < 0.6 * range(b1) || body(b3) < 0.6 * range(b3)) return null;
        if (body(b2) > 0.4 * range(b1)) return null;
        var mid = (b1.open + b1.close) / 2;
        if (b3.close < mid) return null;
        return { strength: 0.85 };
      }
    },
    {
      key: "evening_star", name: "Evening Star", direction: "bear",
      description: "Large bullish → small-body gap-up → large bearish closing below bar-1 midpoint",
      detect: function (c, i) {
        if (i < 2) return null;
        var b1 = c[i - 2], b2 = c[i - 1], b3 = c[i];
        if (!bull(b1) || !bear(b3)) return null;
        if (body(b1) < 0.6 * range(b1) || body(b3) < 0.6 * range(b3)) return null;
        if (body(b2) > 0.4 * range(b1)) return null;
        var mid = (b1.open + b1.close) / 2;
        if (b3.close > mid) return null;
        return { strength: 0.85 };
      }
    },
    {
      key: "three_white_soldiers", name: "Three White Soldiers", direction: "bull",
      description: "Three consecutive bullish bars with rising closes",
      detect: function (c, i) {
        if (i < 2) return null;
        for (var k = i - 2; k <= i; k++) {
          if (!bull(c[k]) || body(c[k]) < 0.5 * range(c[k])) return null;
          if (upper(c[k]) > 0.25 * range(c[k])) return null;
        }
        if (!(c[i].close > c[i - 1].close && c[i - 1].close > c[i - 2].close)) return null;
        return { strength: 0.8 };
      }
    },
    {
      key: "three_black_crows", name: "Three Black Crows", direction: "bear",
      description: "Three consecutive bearish bars with falling closes",
      detect: function (c, i) {
        if (i < 2) return null;
        for (var k = i - 2; k <= i; k++) {
          if (!bear(c[k]) || body(c[k]) < 0.5 * range(c[k])) return null;
          if (lower(c[k]) > 0.25 * range(c[k])) return null;
        }
        if (!(c[i].close < c[i - 1].close && c[i - 1].close < c[i - 2].close)) return null;
        return { strength: 0.8 };
      }
    },
    {
      key: "dragonfly_doji", name: "Dragonfly Doji", direction: "bull",
      description: "Long lower wick, near-zero body at top of range — reversal after decline",
      detect: function (c, i) {
        var t = c[i], b = body(t), r = range(t);
        if (b / r > 0.08) return null;
        if (lower(t) < 0.6 * r) return null;
        if (upper(t) > 0.15 * r) return null;
        if (!priorTrend(c, i, 5, "down")) return null;
        return { strength: 0.7 };
      }
    },
    {
      key: "gravestone_doji", name: "Gravestone Doji", direction: "bear",
      description: "Long upper wick, near-zero body at bottom of range — reversal after rise",
      detect: function (c, i) {
        var t = c[i], b = body(t), r = range(t);
        if (b / r > 0.08) return null;
        if (upper(t) < 0.6 * r) return null;
        if (lower(t) > 0.15 * r) return null;
        if (!priorTrend(c, i, 5, "up")) return null;
        return { strength: 0.7 };
      }
    }
  ];

  function detectAll(candles, i) {
    if (i == null) i = candles.length - 1;
    if (i < 0 || i >= candles.length) return [];
    var results = [];
    PATTERNS.forEach(function (p) {
      var r = p.detect(candles, i);
      if (r) results.push({
        key: p.key, name: p.name, direction: p.direction,
        description: p.description, strength: r.strength
      });
    });
    return results;
  }

  // True if ANY bullish pattern fires at bar i.
  function anyBullish(candles, i) {
    return PATTERNS.some(function (p) { return p.direction === "bull" && p.detect(candles, i); });
  }
  function anyBearish(candles, i) {
    return PATTERNS.some(function (p) { return p.direction === "bear" && p.detect(candles, i); });
  }

  window.Candlesticks = {
    detectAll: detectAll,
    anyBullish: anyBullish,
    anyBearish: anyBearish,
    PATTERNS: PATTERNS
  };
})();
