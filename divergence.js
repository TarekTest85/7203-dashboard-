// divergence.js — Detects RSI and MACD divergence with price.
//
// Bullish divergence: price prints a lower low but the indicator prints
//   a HIGHER low — momentum is fading on the downside, hint of reversal.
// Bearish divergence: price prints a higher high but the indicator
//   prints a LOWER high — upside momentum weakening.
//
// Algorithm:
//   1. Look at last `lookback` bars (default 30).
//   2. Find the two most recent local extrema of price (using a 3-bar
//      pivot test — bar strictly extreme against 2 bars on each side).
//   3. Check the indicator's value at those bar indices to see if it
//      moved in the opposite direction with meaningful magnitude.
//   4. Report strength = how "unequal" the divergence is.
(function () {
  function localLows(closes, start, end) {
    var lows = [];
    for (var i = Math.max(start + 2, 2); i <= Math.min(end - 2, closes.length - 3); i++) {
      if (closes[i] < closes[i - 1] && closes[i] < closes[i - 2] &&
          closes[i] < closes[i + 1] && closes[i] < closes[i + 2]) {
        lows.push({ index: i, value: closes[i] });
      }
    }
    return lows;
  }
  function localHighs(closes, start, end) {
    var highs = [];
    for (var i = Math.max(start + 2, 2); i <= Math.min(end - 2, closes.length - 3); i++) {
      if (closes[i] > closes[i - 1] && closes[i] > closes[i - 2] &&
          closes[i] > closes[i + 1] && closes[i] > closes[i + 2]) {
        highs.push({ index: i, value: closes[i] });
      }
    }
    return highs;
  }

  // Returns a divergence descriptor or null.
  //   candles      full OHLCV series
  //   indicator    same-length array (may contain nulls)
  //   endIdx       last index to consider (default: last bar)
  //   lookback     how far back to search for extrema
  //   minPct       minimum relative price move between the two extrema
  //   minRange     minimum absolute indicator move
  function detectOne(candles, indicator, endIdx, lookback, minPct, minRange) {
    if (endIdx == null) endIdx = candles.length - 1;
    if (lookback == null) lookback = 30;
    if (minPct == null) minPct = 0.01;
    if (minRange == null) minRange = 2;
    var closes = candles.map(function (c) { return c.close; });
    var start = Math.max(0, endIdx - lookback);

    var lows = localLows(closes, start, endIdx);
    if (lows.length >= 2) {
      var a = lows[lows.length - 2], b = lows[lows.length - 1];
      if (indicator[a.index] != null && indicator[b.index] != null) {
        var priceDrop = (a.value - b.value) / a.value;
        var indUp = indicator[b.index] - indicator[a.index];
        if (priceDrop >= minPct && indUp >= minRange) {
          return {
            type: "bullish",
            firstIdx: a.index, secondIdx: b.index,
            firstPrice: a.value, secondPrice: b.value,
            firstInd: indicator[a.index], secondInd: indicator[b.index],
            strength: Math.min(1, (priceDrop * 100) / 3 + indUp / 15)
          };
        }
      }
    }

    var highs = localHighs(closes, start, endIdx);
    if (highs.length >= 2) {
      var c = highs[highs.length - 2], d = highs[highs.length - 1];
      if (indicator[c.index] != null && indicator[d.index] != null) {
        var priceRise = (d.value - c.value) / c.value;
        var indDown = indicator[c.index] - indicator[d.index];
        if (priceRise >= minPct && indDown >= minRange) {
          return {
            type: "bearish",
            firstIdx: c.index, secondIdx: d.index,
            firstPrice: c.value, secondPrice: d.value,
            firstInd: indicator[c.index], secondInd: indicator[d.index],
            strength: Math.min(1, (priceRise * 100) / 3 + indDown / 15)
          };
        }
      }
    }
    return null;
  }

  function detectAll(candles, ind, endIdx) {
    // RSI: momentum indicator on 0..100 scale, minRange ≈ 3
    // MACD histogram: use minRange scaled to price
    var closes = candles.map(function (c) { return c.close; });
    var priceScale = closes[closes.length - 1] || 100;
    var rsiDiv = detectOne(candles, ind.rsi, endIdx, 30, 0.01, 3);
    var macdDiv = detectOne(candles, ind.macd.hist, endIdx, 30, 0.01, priceScale * 0.002);
    return { rsi: rsiDiv, macd: macdDiv };
  }

  window.Divergence = { detectAll: detectAll, detectOne: detectOne };
})();
