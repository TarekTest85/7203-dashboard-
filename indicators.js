// Technical indicators: SMA, EMA, RSI, MACD, ATR, Bollinger, ADX,
// ROC (rate of change), Stochastic, daily returns, σ, swing pivots.
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

  // Standard deviation over a rolling window.
  function rollingStdev(values, period) {
    var out = new Array(values.length).fill(null);
    for (var i = period - 1; i < values.length; i++) {
      var mean = 0;
      for (var j = i - period + 1; j <= i; j++) mean += values[j];
      mean /= period;
      var sq = 0;
      for (var k = i - period + 1; k <= i; k++) sq += Math.pow(values[k] - mean, 2);
      out[i] = Math.sqrt(sq / period);
    }
    return out;
  }

  // Bollinger Bands (period=20, k=2 by default). Returns mid (SMA),
  // upper, lower, and a z-score (how many σ the price sits from the mid).
  function bollinger(values, period, k) {
    period = period || 20; k = k == null ? 2 : k;
    var mid = sma(values, period);
    var sd = rollingStdev(values, period);
    var upper = [], lower = [], z = [];
    for (var i = 0; i < values.length; i++) {
      if (mid[i] == null || sd[i] == null) {
        upper.push(null); lower.push(null); z.push(null);
      } else {
        upper.push(mid[i] + k * sd[i]);
        lower.push(mid[i] - k * sd[i]);
        z.push(sd[i] === 0 ? 0 : (values[i] - mid[i]) / sd[i]);
      }
    }
    return { mid: mid, upper: upper, lower: lower, z: z };
  }

  // ADX (trend strength) using Wilder smoothing. Returns ADX series (no
  // +DI/-DI breakdown — ADX magnitude is what we use for regime).
  function adx(candles, period) {
    period = period || 14;
    var len = candles.length;
    var tr = new Array(len), plusDM = new Array(len), minusDM = new Array(len);
    tr[0] = candles[0].high - candles[0].low;
    plusDM[0] = 0; minusDM[0] = 0;
    for (var i = 1; i < len; i++) {
      var h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      var up = candles[i].high - candles[i - 1].high;
      var dn = candles[i - 1].low - candles[i].low;
      plusDM[i]  = (up > dn && up > 0)  ? up : 0;
      minusDM[i] = (dn > up && dn > 0) ? dn : 0;
    }
    function wilder(src) {
      var out = new Array(len).fill(null);
      var sum = 0;
      for (var i = 0; i < len; i++) {
        if (i < period) { sum += src[i]; if (i === period - 1) out[i] = sum; }
        else { out[i] = out[i - 1] - out[i - 1] / period + src[i]; }
      }
      return out;
    }
    var trN = wilder(tr), pN = wilder(plusDM), mN = wilder(minusDM);
    var dx = new Array(len).fill(null);
    for (var j = 0; j < len; j++) {
      if (trN[j] == null || trN[j] === 0) continue;
      var pdi = 100 * pN[j] / trN[j];
      var mdi = 100 * mN[j] / trN[j];
      var den = pdi + mdi;
      dx[j] = den === 0 ? 0 : 100 * Math.abs(pdi - mdi) / den;
    }
    var adxArr = new Array(len).fill(null);
    var firstAdx = period * 2 - 1;
    if (firstAdx < len) {
      var seed = 0, n = 0;
      for (var k2 = period; k2 <= firstAdx; k2++) { if (dx[k2] != null) { seed += dx[k2]; n++; } }
      adxArr[firstAdx] = n ? seed / n : null;
      for (var m = firstAdx + 1; m < len; m++) {
        if (adxArr[m - 1] == null || dx[m] == null) continue;
        adxArr[m] = (adxArr[m - 1] * (period - 1) + dx[m]) / period;
      }
    }
    return adxArr;
  }

  // Rate of change (%). roc[i] = (price[i] / price[i-period] - 1) * 100.
  function roc(values, period) {
    var out = new Array(values.length).fill(null);
    for (var i = period; i < values.length; i++) {
      if (values[i - period] === 0) continue;
      out[i] = (values[i] / values[i - period] - 1) * 100;
    }
    return out;
  }

  // Stochastic oscillator. %K = 100 * (close - lowK) / (highK - lowK).
  function stochastic(candles, kPeriod, dPeriod) {
    kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
    var k = new Array(candles.length).fill(null);
    for (var i = kPeriod - 1; i < candles.length; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - kPeriod + 1; j <= i; j++) {
        if (candles[j].high > hi) hi = candles[j].high;
        if (candles[j].low < lo) lo = candles[j].low;
      }
      var range = hi - lo;
      k[i] = range === 0 ? 50 : 100 * (candles[i].close - lo) / range;
    }
    var d = sma(k.map(function (v) { return v == null ? 0 : v; }), dPeriod);
    for (var x = 0; x < k.length; x++) if (k[x] == null) d[x] = null;
    return { k: k, d: d };
  }

  // Daily simple returns (close-to-close).
  function dailyReturns(values) {
    var out = [];
    for (var i = 1; i < values.length; i++) {
      out.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    return out;
  }

  // Sample standard deviation of an array.
  function stdev(values) {
    if (!values.length) return 0;
    var mean = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
    var sq = values.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0);
    return Math.sqrt(sq / Math.max(1, values.length - 1));
  }

  // Rolling-window h-day forward returns. returns[i] = (close[i+h]/close[i]) - 1.
  // Skips the last h entries (no forward return available).
  function horizonReturns(closes, h) {
    var out = [];
    for (var i = 0; i + h < closes.length; i++) {
      out.push((closes[i + h] - closes[i]) / closes[i]);
    }
    return out;
  }

  // Empirical percentile (linear interpolation). q in [0, 1].
  function percentile(values, q) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var pos = q * (s.length - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos), frac = pos - lo;
    return s[lo] + (s[hi] - s[lo]) * frac;
  }

  // Pearson correlation between two equal-length series.
  function correlation(x, y) {
    var n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (var j = 0; j < n; j++) {
      var dx = x[j] - mx, dy = y[j] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    var den = Math.sqrt(sxx * syy);
    return den === 0 ? 0 : sxy / den;
  }

  // OLS slope of y on x (no intercept needed if both centred — we keep
  // intercept implicit by returning β = cov(x,y)/var(x)).
  function olsSlope(x, y) {
    var n = Math.min(x.length, y.length);
    if (n < 2) return { beta: null, t: null, r2: null };
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var sxx = 0, sxy = 0, syy = 0;
    for (var j = 0; j < n; j++) {
      var dx = x[j] - mx, dy = y[j] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx === 0) return { beta: null, t: null, r2: null };
    var beta = sxy / sxx;
    var alpha = my - beta * mx;
    var sse = 0;
    for (var k = 0; k < n; k++) {
      var resid = y[k] - (alpha + beta * x[k]);
      sse += resid * resid;
    }
    var sigma2 = sse / Math.max(1, n - 2);
    var seBeta = Math.sqrt(sigma2 / sxx);
    var t = seBeta === 0 ? 0 : beta / seBeta;
    var r2 = syy === 0 ? 0 : 1 - sse / syy;
    return { beta: beta, t: t, r2: r2, n: n };
  }

  window.Indicators = {
    sma: sma, ema: ema, rsi: rsi, macd: macd, atr: atr,
    bollinger: bollinger, adx: adx, roc: roc, stochastic: stochastic,
    dailyReturns: dailyReturns, stdev: stdev, rollingStdev: rollingStdev,
    horizonReturns: horizonReturns, percentile: percentile,
    correlation: correlation, olsSlope: olsSlope,
    swings: swings
  };
})();
