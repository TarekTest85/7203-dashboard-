// regime.js — Market regime classification (Trending / Ranging / Volatile).
//
// Uses:
//   · ADX for trend strength
//   · Current ATR relative to 60-bar median ATR for volatility state
//   · Autocorrelation of daily returns (positive → trending, negative →
//     mean-reverting/ranging)
//
// Output influences confidence in forecast.js:
//   trending  → default weighting (1.0)
//   ranging   → mild shrink (0.92) — mean-reversion signals aren't
//                well-captured by the current signal stack
//   volatile  → stronger shrink (0.75)
(function () {
  function lastValid(a) {
    for (var i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i];
    return null;
  }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  }
  function autocorr(values, lag) {
    if (values.length <= lag + 2) return 0;
    var n = values.length - lag;
    var mean = 0;
    for (var i = 0; i < values.length; i++) mean += values[i];
    mean /= values.length;
    var num = 0, den = 0;
    for (var i = 0; i < n; i++) num += (values[i] - mean) * (values[i + lag] - mean);
    for (var j = 0; j < values.length; j++) den += Math.pow(values[j] - mean, 2);
    return den > 0 ? num / den : 0;
  }

  function classify(candles, ind) {
    var n = candles.length;
    if (n < 30) return { regime: "unknown", strength: 0, confidenceMult: 1 };

    var adxLast = lastValid(ind.adx);
    var atrLast = lastValid(ind.atr);
    var atrSeries = ind.atr.filter(function (v) { return v != null; }).slice(-60);
    var medAtr = median(atrSeries);
    var atrRatio = medAtr && atrLast ? atrLast / medAtr : 1;

    // Autocorrelation of daily returns over last 60 bars
    var returns = [];
    for (var i = Math.max(1, n - 60); i < n; i++) {
      returns.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
    }
    var ac1 = autocorr(returns, 1);

    var isVolatile = atrRatio > 1.5;
    var isStronglyTrending = adxLast != null && adxLast >= 30;
    var isTrending = adxLast != null && adxLast >= 22;
    var isRanging = adxLast != null && adxLast < 20;

    var regime, strength, mult;
    if (isVolatile) {
      regime = "volatile";
      strength = Math.min(1, (atrRatio - 1) / 1.5);
      mult = 0.75;
    } else if (isStronglyTrending) {
      regime = "strong-trend";
      strength = Math.min(1, (adxLast - 30) / 20);
      mult = 1.05;
    } else if (isTrending) {
      regime = "trending";
      strength = Math.min(1, (adxLast - 22) / 8);
      mult = 1.0;
    } else if (isRanging) {
      regime = "ranging";
      strength = Math.min(1, (20 - adxLast) / 15);
      mult = 0.92;
    } else {
      regime = "transitional";
      strength = 0.5;
      mult = 0.95;
    }

    return {
      regime: regime,
      strength: strength,
      adx: adxLast,
      atrRatio: atrRatio,
      autocorr1: ac1,
      confidenceMult: mult
    };
  }

  window.Regime = { classify: classify };
})();
