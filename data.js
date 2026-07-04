// Embedded fallback OHLCV for Elm Company (7203.SR / Tadawul).
//
// The last 21 bars (04 Jun 2026 → 02 Jul 2026) are REAL prints supplied
// from the Investing.com CSV; everything before that is a synthetic
// warm-up so the backtest and empirical baseline have enough history.
// The synthetic tail is designed to hand off smoothly into the real
// series (June 3 close ≈ 692 → June 4 real open 694).
//
// Live fetch (live.js) still supersedes this on a working network.
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

  // 21 REAL bars from Investing.com CSV — most recent Tadawul session
  // is Thu 02 Jul 2026 with close 678.00 SAR. Volumes given in K → ×1000.
  var REAL_BARS = [
    { date: "2026-06-04", open: 694.00, high: 705.00, low: 694.00, close: 702.00, volume: 57290  },
    { date: "2026-06-07", open: 697.00, high: 699.00, low: 684.00, close: 690.00, volume: 129100 },
    { date: "2026-06-08", open: 685.50, high: 692.00, low: 679.00, close: 691.00, volume: 78920  },
    { date: "2026-06-09", open: 691.00, high: 710.00, low: 691.00, close: 709.00, volume: 167230 },
    { date: "2026-06-10", open: 708.50, high: 713.00, low: 695.00, close: 696.00, volume: 91260  },
    { date: "2026-06-11", open: 696.00, high: 708.50, low: 693.00, close: 701.00, volume: 75940  },
    { date: "2026-06-14", open: 705.00, high: 710.00, low: 703.00, close: 704.00, volume: 48790  },
    { date: "2026-06-15", open: 710.00, high: 719.00, low: 704.00, close: 714.50, volume: 110820 },
    { date: "2026-06-16", open: 715.00, high: 720.00, low: 712.50, close: 713.00, volume: 74010  },
    { date: "2026-06-17", open: 713.00, high: 739.00, low: 710.00, close: 737.00, volume: 191780 },
    { date: "2026-06-18", open: 736.50, high: 736.50, low: 720.00, close: 725.50, volume: 193780 },
    { date: "2026-06-21", open: 726.50, high: 726.50, low: 716.00, close: 716.00, volume: 43420  },
    { date: "2026-06-22", open: 715.00, high: 715.00, low: 701.00, close: 701.00, volume: 66260  },
    { date: "2026-06-23", open: 701.00, high: 709.50, low: 697.00, close: 698.00, volume: 69320  },
    { date: "2026-06-24", open: 698.00, high: 702.00, low: 692.00, close: 693.50, volume: 80640  },
    { date: "2026-06-25", open: 693.50, high: 699.50, low: 691.00, close: 692.00, volume: 60270  },
    { date: "2026-06-28", open: 692.00, high: 694.50, low: 683.50, close: 686.50, volume: 45630  },
    { date: "2026-06-29", open: 687.00, high: 691.00, low: 678.00, close: 685.50, volume: 54810  },
    { date: "2026-06-30", open: 687.50, high: 690.00, low: 679.50, close: 687.00, volume: 82370  },
    { date: "2026-07-01", open: 689.00, high: 695.00, low: 685.50, close: 685.50, volume: 55550  },
    { date: "2026-07-02", open: 686.50, high: 690.00, low: 678.00, close: 678.00, volume: 48820  }
  ];

  // Build 199 synthetic Tadawul sessions ending Wed 03 Jun 2026, then
  // append the 21 real bars. Total = 220.
  function buildSyntheticPrefix() {
    var rng = mulberry32(72035);
    var end = new Date("2026-06-03T00:00:00Z");
    var sessions = [];
    var d = new Date(end);
    while (sessions.length < 199) {
      if (!isWeekend(d)) sessions.unshift(new Date(d));
      d = addDays(d, -1);
    }

    // Anchors chosen so the synthetic path exhibits the macro H&S top
    // (peak ≈ 1090) that historically played out on 7203 during
    // 2025–early 2026, breaks down through the neckline, bottoms
    // in April 2026, and then recovers to ≈ 692 by early June —
    // matching where the real CSV picks up (704 → 690 range).
    var anchors = [
      { i: 0,   p: 940  },
      { i: 20,  p: 1050 },   // left shoulder
      { i: 45,  p: 975  },   // left trough
      { i: 70,  p: 1090 },   // head — 52-week high
      { i: 95,  p: 985  },   // right trough
      { i: 120, p: 1045 },   // right shoulder
      { i: 150, p: 830  },   // breakdown through neckline
      { i: 170, p: 620  },
      { i: 185, p: 515  },   // 52-week low
      { i: 195, p: 640  },
      { i: 198, p: 692  }    // seamless hand-off to real bar 199 (open 694)
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
      var wave =
        14 * Math.sin((i / sessions.length) * Math.PI * 2 * 1.5) +
        7 * Math.sin((i / sessions.length) * Math.PI * 2 * 4.1);
      var noise = (rng() - 0.5) * 9;
      var close = base + wave + noise;
      var rangePct = 0.012 + rng() * 0.018;
      var open = close + (rng() - 0.5) * close * 0.008;
      var high = Math.max(open, close) + rng() * close * rangePct * 0.5;
      var low = Math.min(open, close) - rng() * close * rangePct * 0.5;
      var volume = Math.round(80000 + rng() * 200000);
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
    asOfFallback: "2026-07-02",
    fallbackNote: "Last 21 sessions from Investing.com CSV; earlier bars synthetic warm-up."
  };
  window.STOCK_DATA = buildSyntheticPrefix().concat(REAL_BARS);
  window.STOCK_DATA_SOURCE = "fallback";
})();
