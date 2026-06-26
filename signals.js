// signals.js — BUY/SELL/HOLD rule engine.
//
// Each rule is a deterministic trigger evaluated at a single bar `i`.
// For the current bar we get a fire/no-fire decision; for every prior
// bar we run the same logic to walk-forward-backtest each rule, giving
// us its historical hit-rate and average h-day forward return.
//
// The aggregate action is a hit-rate-weighted vote across fired rules.
// We never look ahead — rule logic uses only data up to bar i.
(function () {
  function valAt(arr, i) { return arr && i >= 0 && i < arr.length ? arr[i] : null; }

  // Rule shape:
  //   { key, name, action: "BUY"|"SELL", description,
  //     evaluate(ind, candles, i) → { fired: bool, strength: 0..1 } }
  var RULES = [
    {
      key: "golden_cross",
      name: "Golden Cross + Trend",
      action: "BUY",
      description: "SMA20 crossed above SMA50 within the last 5 bars, price above SMA20, ADX > 18 (trending market)",
      evaluate: function (ind, candles, i) {
        if (i < 50) return { fired: false };
        var s20 = valAt(ind.sma20, i), s50 = valAt(ind.sma50, i), adxV = valAt(ind.adx, i);
        if (s20 == null || s50 == null || adxV == null) return { fired: false };
        if (!(s20 > s50 && candles[i].close > s20 && adxV > 18)) return { fired: false };
        var crossed = false;
        for (var k = Math.max(0, i - 5); k < i; k++) {
          if (ind.sma20[k] != null && ind.sma50[k] != null && ind.sma20[k] <= ind.sma50[k]) { crossed = true; break; }
        }
        if (!crossed) return { fired: false };
        return { fired: true, strength: Math.min(1, 0.3 + (adxV - 18) / 30) };
      }
    },
    {
      key: "death_cross",
      name: "Death Cross + Trend",
      action: "SELL",
      description: "SMA20 crossed below SMA50 within the last 5 bars, price below SMA20, ADX > 18 (trending market)",
      evaluate: function (ind, candles, i) {
        if (i < 50) return { fired: false };
        var s20 = valAt(ind.sma20, i), s50 = valAt(ind.sma50, i), adxV = valAt(ind.adx, i);
        if (s20 == null || s50 == null || adxV == null) return { fired: false };
        if (!(s20 < s50 && candles[i].close < s20 && adxV > 18)) return { fired: false };
        var crossed = false;
        for (var k = Math.max(0, i - 5); k < i; k++) {
          if (ind.sma20[k] != null && ind.sma50[k] != null && ind.sma20[k] >= ind.sma50[k]) { crossed = true; break; }
        }
        if (!crossed) return { fired: false };
        return { fired: true, strength: Math.min(1, 0.3 + (adxV - 18) / 30) };
      }
    },
    {
      key: "rsi_oversold_bounce",
      name: "RSI Oversold Bounce",
      action: "BUY",
      description: "RSI dipped below 30 in the last 3 bars, now turning up, today's low ≥ yesterday's low",
      evaluate: function (ind, candles, i) {
        if (i < 14) return { fired: false };
        var rsiNow = valAt(ind.rsi, i), rsiPrev = valAt(ind.rsi, i - 1);
        if (rsiNow == null || rsiPrev == null || rsiNow <= rsiPrev) return { fired: false };
        var wasOversold = false;
        for (var k = Math.max(0, i - 3); k <= i; k++) if (ind.rsi[k] != null && ind.rsi[k] < 30) { wasOversold = true; break; }
        if (!wasOversold) return { fired: false };
        if (candles[i].low < candles[i - 1].low) return { fired: false };
        return { fired: true, strength: 0.6 + Math.min(0.3, (30 - Math.min(rsiPrev, rsiNow)) / 30) };
      }
    },
    {
      key: "rsi_overbought_reversal",
      name: "RSI Overbought Reversal",
      action: "SELL",
      description: "RSI spiked above 70 in the last 3 bars, now turning down, today's high ≤ yesterday's high",
      evaluate: function (ind, candles, i) {
        if (i < 14) return { fired: false };
        var rsiNow = valAt(ind.rsi, i), rsiPrev = valAt(ind.rsi, i - 1);
        if (rsiNow == null || rsiPrev == null || rsiNow >= rsiPrev) return { fired: false };
        var wasOverbought = false;
        for (var k = Math.max(0, i - 3); k <= i; k++) if (ind.rsi[k] != null && ind.rsi[k] > 70) { wasOverbought = true; break; }
        if (!wasOverbought) return { fired: false };
        if (candles[i].high > candles[i - 1].high) return { fired: false };
        return { fired: true, strength: 0.6 + Math.min(0.3, (Math.max(rsiPrev, rsiNow) - 70) / 30) };
      }
    },
    {
      key: "macd_bull_cross",
      name: "MACD Bullish Cross",
      action: "BUY",
      description: "MACD line crossed above signal line within the last 3 bars, histogram positive",
      evaluate: function (ind, candles, i) {
        if (i < 35) return { fired: false };
        var mlNow = valAt(ind.macd.line, i), msNow = valAt(ind.macd.signal, i), mhNow = valAt(ind.macd.hist, i);
        if (mlNow == null || msNow == null || !(mlNow > msNow) || !(mhNow > 0)) return { fired: false };
        var crossed = false;
        for (var k = Math.max(0, i - 3); k < i; k++) {
          if (ind.macd.line[k] != null && ind.macd.signal[k] != null && ind.macd.line[k] <= ind.macd.signal[k]) {
            crossed = true; break;
          }
        }
        if (!crossed) return { fired: false };
        var histStrength = Math.min(1, Math.abs(mhNow) / (candles[i].close * 0.004));
        return { fired: true, strength: 0.5 + 0.4 * histStrength };
      }
    },
    {
      key: "macd_bear_cross",
      name: "MACD Bearish Cross",
      action: "SELL",
      description: "MACD line crossed below signal line within the last 3 bars, histogram negative",
      evaluate: function (ind, candles, i) {
        if (i < 35) return { fired: false };
        var mlNow = valAt(ind.macd.line, i), msNow = valAt(ind.macd.signal, i), mhNow = valAt(ind.macd.hist, i);
        if (mlNow == null || msNow == null || !(mlNow < msNow) || !(mhNow < 0)) return { fired: false };
        var crossed = false;
        for (var k = Math.max(0, i - 3); k < i; k++) {
          if (ind.macd.line[k] != null && ind.macd.signal[k] != null && ind.macd.line[k] >= ind.macd.signal[k]) {
            crossed = true; break;
          }
        }
        if (!crossed) return { fired: false };
        var histStrength = Math.min(1, Math.abs(mhNow) / (candles[i].close * 0.004));
        return { fired: true, strength: 0.5 + 0.4 * histStrength };
      }
    },
    {
      key: "bb_breakout_up",
      name: "Bollinger Breakout Up",
      action: "BUY",
      description: "Close above upper Bollinger Band on volume ≥ 1.2× the 20-day average",
      evaluate: function (ind, candles, i) {
        if (i < 20) return { fired: false };
        var upper = valAt(ind.bb.upper, i);
        if (upper == null || candles[i].close <= upper) return { fired: false };
        var sumVol = 0, n = 0;
        for (var k = Math.max(0, i - 20); k < i; k++) { sumVol += candles[k].volume || 0; n++; }
        var avgVol = sumVol / Math.max(1, n);
        if (avgVol <= 0 || candles[i].volume < avgVol * 1.2) return { fired: false };
        return { fired: true, strength: 0.65 };
      }
    },
    {
      key: "bb_breakout_down",
      name: "Bollinger Breakout Down",
      action: "SELL",
      description: "Close below lower Bollinger Band on volume ≥ 1.2× the 20-day average",
      evaluate: function (ind, candles, i) {
        if (i < 20) return { fired: false };
        var lower = valAt(ind.bb.lower, i);
        if (lower == null || candles[i].close >= lower) return { fired: false };
        var sumVol = 0, n = 0;
        for (var k = Math.max(0, i - 20); k < i; k++) { sumVol += candles[k].volume || 0; n++; }
        var avgVol = sumVol / Math.max(1, n);
        if (avgVol <= 0 || candles[i].volume < avgVol * 1.2) return { fired: false };
        return { fired: true, strength: 0.65 };
      }
    }
  ];

  // For each rule, sweep history and record (fires, hits, avg-return).
  // Hit = forward-h return signed in the rule's direction.
  function backtestRules(candles, ind, horizonDays) {
    var WARMUP = 50;
    var results = {};
    RULES.forEach(function (rule) {
      var hits = 0, fires = 0, sumRet = 0;
      for (var i = WARMUP; i < candles.length - horizonDays; i++) {
        var r = rule.evaluate(ind, candles, i);
        if (!r.fired) continue;
        fires++;
        var fwd = (candles[i + horizonDays].close - candles[i].close) / candles[i].close;
        sumRet += fwd;
        var expectedSign = rule.action === "BUY" ? 1 : -1;
        if ((fwd > 0 && expectedSign > 0) || (fwd < 0 && expectedSign < 0)) hits++;
      }
      results[rule.key] = {
        fires: fires,
        hitRate: fires >= 3 ? hits / fires : null,
        avgReturn: fires > 0 ? sumRet / fires : null
      };
    });
    return results;
  }

  function evaluateNow(candles, ind, horizonDays, forecast) {
    var iNow = candles.length - 1;
    var stats = backtestRules(candles, ind, horizonDays);

    var rows = RULES.map(function (rule) {
      var r = rule.evaluate(ind, candles, iNow);
      var s = stats[rule.key];
      // If not currently firing, find most recent firing within last 30 bars.
      var barsAgo = null;
      if (!r.fired) {
        for (var k = iNow - 1; k >= Math.max(0, iNow - 30); k--) {
          var e = rule.evaluate(ind, candles, k);
          if (e.fired) { barsAgo = iNow - k; break; }
        }
      }
      return {
        key: rule.key,
        name: rule.name,
        action: rule.action,
        description: rule.description,
        fired: r.fired,
        strength: r.strength || 0,
        barsAgo: barsAgo,
        hitRate: s.hitRate,
        fires: s.fires,
        avgReturn: s.avgReturn
      };
    });

    // Aggregate: weight by hit-rate × strength. Default hit-rate to 0.5
    // when there aren't enough fires (no information either way).
    var netScore = 0, totalWeight = 0;
    rows.forEach(function (rf) {
      if (!rf.fired) return;
      var dir = rf.action === "BUY" ? 1 : -1;
      var hr = rf.hitRate != null ? rf.hitRate : 0.5;
      var weight = hr * (rf.strength || 0.5);
      netScore += dir * weight;
      totalWeight += weight;
    });
    var normalized = totalWeight > 0 ? netScore / totalWeight : 0;
    var action = normalized > 0.3 ? "BUY" : normalized < -0.3 ? "SELL" : "HOLD";
    var confidence = Math.min(0.9, Math.abs(normalized));

    // Risk / reward from the forecast's target + invalidation level.
    var rr = null, riskPct = null, rewardPct = null;
    if (forecast && forecast.target != null && forecast.invalidation && forecast.lastClose) {
      var price = forecast.lastClose;
      var reward = Math.abs(forecast.target - price);
      var risk = Math.abs(price - forecast.invalidation.price);
      if (risk > 0) {
        rr = reward / risk;
        riskPct = (risk / price) * 100;
        rewardPct = (reward / price) * 100;
      }
    }

    // Kelly-light position sizing:
    //   f* = (p · b − q) / b   where p = hit-prob, q = 1−p, b = R:R
    //   Display ¼ Kelly, capped at 20% of capital.
    var positionPct = null;
    if (action !== "HOLD" && rr != null && forecast && forecast.probHit != null) {
      var p = forecast.probHit, q = 1 - p;
      var f = (p * rr - q) / rr;
      positionPct = Math.max(0, Math.min(0.20, f / 4));
    }

    var firedBuy = rows.filter(function (r) { return r.fired && r.action === "BUY"; }).length;
    var firedSell = rows.filter(function (r) { return r.fired && r.action === "SELL"; }).length;

    return {
      action: action,
      confidence: confidence,
      score: normalized,
      rules: rows,
      rr: rr,
      riskPct: riskPct,
      rewardPct: rewardPct,
      positionPct: positionPct,
      firedBuy: firedBuy,
      firedSell: firedSell
    };
  }

  window.SignalEngine = { evaluate: evaluateNow, RULES: RULES };
})();
