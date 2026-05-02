// Technical indicators: SMA, EMA, RSI, MACD, ATR, swing pivots.
(function () {
  function sma(values, period) {
    var out = new Array(values.length).fill(null);
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    var out = new Array(values.length).fill(null);
    var k = 2 / (period + 1);
    var prev = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (prev == null) {
        if (i === period - 1) {
          var sum = 0;
          for (var j = 0; j < period; j++) sum += values[j];
          prev = sum / period;
          out[i] = prev;
        }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  function rsi(values, period) {
    period = period || 14;
    var out = new Array(values.length).fill(null);
    var gains = 0, losses = 0;
    for (var i = 1; i < values.length; i++) {
      var diff = values[i] - values[i - 1];
      var gain = diff > 0 ? diff : 0;
      var loss = diff < 0 ? -diff : 0;
      if (i <= period) {
        gains += gain;
        losses += loss;
        if (i === period) {
          var avgG = gains / period, avgL = losses / period;
          var rs = avgL === 0 ? 100 : avgG / avgL;
          out[i] = 100 - 100 / (1 + rs);
        }
      } else {
        gains = (gains * (period - 1) + gain) / period;
        losses = (losses * (period - 1) + loss) / period;
        var rs2 = losses === 0 ? 100 : gains / losses;
        out[i] = 100 - 100 / (1 + rs2);
      }
    }
    // Wilder's smoothing variant — close enough for dashboard purposes.
    return out;
  }

  function macd(values, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var emaFast = ema(values, fast);
    var emaSlow = ema(values, slow);
    var line = values.map(function (_, i) {
      return emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null;
    });
    var lineFiltered = line.map(function (v) { return v == null ? 0 : v; });
    var sig = ema(lineFiltered, signal);
    // Mask signal until enough macd values exist.
    for (var i = 0; i < line.length; i++) if (line[i] == null) sig[i] = null;
    var hist = line.map(function (v, i) {
      return v != null && sig[i] != null ? v - sig[i] : null;
    });
    return { line: line, signal: sig, hist: hist };
  }

  function atr(candles, period) {
    period = period || 14;
    var trs = [];
    for (var i = 0; i < candles.length; i++) {
      if (i === 0) { trs.push(candles[i].high - candles[i].low); continue; }
      var prevClose = candles[i - 1].close;
      var tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      );
      trs.push(tr);
    }
    return sma(trs, period);
  }

  // Detect swing highs/lows by checking that bar `i` is the strict extreme
  // within a +/- `lookback` window.
  function swings(candles, lookback) {
    lookback = lookback || 5;
    var highs = [], lows = [];
    for (var i = lookback; i < candles.length - lookback; i++) {
      var isHigh = true, isLow = true;
      for (var j = 1; j <= lookback; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
        if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) highs.push({ index: i, price: candles[i].high, date: candles[i].date });
      if (isLow) lows.push({ index: i, price: candles[i].low, date: candles[i].date });
    }
    return { highs: highs, lows: lows };
  }

  window.Indicators = { sma: sma, ema: ema, rsi: rsi, macd: macd, atr: atr, swings: swings };
})();
