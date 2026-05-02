// Optional live-data loader for 7203.SR.
//
// Browser fetch goes through a CORS-friendly proxy because Yahoo's chart
// endpoint does not send permissive CORS headers. If the call fails, the
// dashboard keeps the embedded fallback series defined in data.js.
//
// Proxies are tried in order; the first that returns a parseable Yahoo
// chart payload wins. Replace these with your own proxy / API key in
// production.
(function () {
  var SYMBOL = "7203.SR";
  var YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(SYMBOL) + "?interval=1d&range=1y";
  var PROXIES = [
    function (url) { return "https://corsproxy.io/?" + encodeURIComponent(url); },
    function (url) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(url); }
  ];

  function parseYahoo(payload) {
    var result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
    if (!result) return null;
    var ts = result.timestamp || [];
    var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!q) return null;
    var rows = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null) continue;
      rows.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: +q.open[i].toFixed(2),
        high: +q.high[i].toFixed(2),
        low: +q.low[i].toFixed(2),
        close: +q.close[i].toFixed(2),
        volume: q.volume[i] || 0
      });
    }
    return rows.length > 50 ? rows : null;
  }

  async function tryFetch(proxyFn) {
    var url = proxyFn(YAHOO);
    var res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("http " + res.status);
    var text = await res.text();
    var json = JSON.parse(text);
    var rows = parseYahoo(json);
    if (!rows) throw new Error("empty payload");
    return rows;
  }

  async function loadLive() {
    for (var i = 0; i < PROXIES.length; i++) {
      try {
        var rows = await tryFetch(PROXIES[i]);
        return { rows: rows, source: "live" };
      } catch (e) {
        // try next proxy
      }
    }
    return null;
  }

  window.LiveData = { load: loadLive };
})();
