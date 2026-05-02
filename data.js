// Historical data for Elm Company (7203.SR / Tadawul).
// Generated with a deterministic PRNG so the dashboard renders the same
// dataset every load. Replace `buildSeries` with a fetch from a real data
// provider (e.g. Tadawul / Yahoo Finance) when wiring up live data.
(function () {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function addDays(date, n) {
    var d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function isWeekend(d) {
    // Tadawul trades Sunday–Thursday; weekend is Friday (5) & Saturday (6).
    var w = d.getDay();
    return w === 5 || w === 6;
  }

  function fmt(d) { return d.toISOString().slice(0, 10); }

  // Generate ~220 trading sessions ending 2026-05-01.
  function buildSeries() {
    var rng = mulberry32(72035);
    var end = new Date("2026-05-01T00:00:00Z");
    var sessions = [];
    var d = new Date(end);
    while (sessions.length < 220) {
      if (!isWeekend(d)) sessions.unshift(new Date(d));
      d = addDays(d, -1);
    }

    // Price path: drift + cyclic component + a head-and-shoulders shape near the end.
    var price = 920;
    var out = [];
    for (var i = 0; i < sessions.length; i++) {
      var t = i / sessions.length;

      // Long-term drift.
      var drift = 0.18;

      // Two macro waves.
      var wave =
        18 * Math.sin((i / sessions.length) * Math.PI * 2 * 1.4) +
        9 * Math.sin((i / sessions.length) * Math.PI * 2 * 3.2);

      // Engineered Head & Shoulders top in the last ~60 sessions:
      //   left shoulder, head, right shoulder followed by a neckline break.
      var late = sessions.length - i;
      var hs = 0;
      if (late <= 60 && late > 0) {
        var p = (60 - late) / 60; // 0 -> 1 across the last 60 sessions
        // Three Gaussian bumps: shoulder, head, shoulder
        function bump(center, width, amp) {
          var x = (p - center) / width;
          return amp * Math.exp(-x * x);
        }
        hs =
          bump(0.18, 0.07, 28) +     // left shoulder
          bump(0.45, 0.08, 46) +     // head (higher)
          bump(0.72, 0.07, 26);      // right shoulder (lower than head)
        // Post right-shoulder breakdown begins after p ~ 0.82
        if (p > 0.82) hs -= 30 * (p - 0.82) / 0.18;
      }

      var noise = (rng() - 0.5) * 6;
      var close = 900 + drift * i + wave + hs + noise;

      // Build OHLC around close
      var rangePct = 0.012 + rng() * 0.018;
      var open = close + (rng() - 0.5) * close * 0.008;
      var high = Math.max(open, close) + rng() * close * rangePct * 0.5;
      var low = Math.min(open, close) - rng() * close * rangePct * 0.5;
      var volume = Math.round(120000 + rng() * 380000 + (Math.abs(hs) > 20 ? 250000 : 0));

      out.push({
        date: fmt(sessions[i]),
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume: volume
      });
    }
    return out;
  }

  window.STOCK_META = {
    symbol: "7203.SR",
    name: "Elm Company",
    nameAr: "شركة علم",
    market: "Tadawul"
  };
  window.STOCK_DATA = buildSeries();
})();
