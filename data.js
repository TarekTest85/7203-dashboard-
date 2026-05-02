// Embedded fallback OHLCV for Elm Company (7203.SR / Tadawul).
//
// Anchored to publicly reported levels: last close ~575 SAR (2026-04-29),
// previous close 570.50 SAR, 52-week range ~504.50 – 1,090.00 SAR. Used
// when the live Yahoo Finance fetch is unavailable (e.g. opening the
// page from disk, or behind a corporate CORS block).
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

  // Tadawul trades Sun–Thu; weekend is Fri (5) & Sat (6).
  function isWeekend(d) {
    var w = d.getDay();
    return w === 5 || w === 6;
  }

  function fmt(d) { return d.toISOString().slice(0, 10); }

  // Build ~220 sessions ending 2026-04-29 with the published last close 575.00.
  function buildSeries() {
    var rng = mulberry32(72035);
    var end = new Date("2026-04-29T00:00:00Z");
    var sessions = [];
    var d = new Date(end);
    while (sessions.length < 220) {
      if (!isWeekend(d)) sessions.unshift(new Date(d));
      d = addDays(d, -1);
    }

    // Trajectory anchors (date, target close in SAR) — interpolated linearly
    // and overlaid with cyclical + noise components. Designed so the implied
    // 52-week range (~504 – 1,090) and last close (575) match real reporting,
    // and a Head-and-Shoulders top is detectable in the upper half.
    var anchors = [
      { i: 0,   p: 950  },
      { i: 20,  p: 1050 },   // left shoulder
      { i: 45,  p: 975  },   // left trough (neckline level)
      { i: 70,  p: 1090 },   // head — 52-week high
      { i: 95,  p: 985  },   // right trough (neckline)
      { i: 120, p: 1045 },   // right shoulder (≈ left shoulder)
      { i: 150, p: 830  },   // breakdown through neckline
      { i: 180, p: 720  },
      { i: 200, p: 510  },   // 52-week low
      { i: 219, p: 575  }    // last close anchor
    ];

    function interp(i) {
      for (var k = 0; k < anchors.length - 1; k++) {
        var a = anchors[k], b = anchors[k + 1];
        if (i >= a.i && i <= b.i) {
          var t = (i - a.i) / (b.i - a.i);
          return a.p + (b.p - a.p) * t;
        }
      }
      return anchors[anchors.length - 1].p;
    }

    var out = [];
    for (var i = 0; i < sessions.length; i++) {
      var base = interp(i);

      // Cyclic component (noise around the anchored path).
      var wave =
        14 * Math.sin((i / sessions.length) * Math.PI * 2 * 1.5) +
        7 * Math.sin((i / sessions.length) * Math.PI * 2 * 4.1);

      var noise = (rng() - 0.5) * 9;
      var close = base + wave + noise;

      // Pin the very last bar to the published close.
      if (i === sessions.length - 1) close = 575.00;
      // Pin the second-to-last bar near the published prior close.
      if (i === sessions.length - 2) close = 570.50;

      var rangePct = 0.012 + rng() * 0.018;
      var open = close + (rng() - 0.5) * close * 0.008;
      var high = Math.max(open, close) + rng() * close * rangePct * 0.5;
      var low = Math.min(open, close) - rng() * close * rangePct * 0.5;
      var volume = Math.round(150000 + rng() * 420000);

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
    market: "Tadawul",
    asOfFallback: "2026-04-29"
  };
  window.STOCK_DATA = buildSeries();
  window.STOCK_DATA_SOURCE = "fallback";
})();
