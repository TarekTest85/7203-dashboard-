// Standalone history browser. Reads snapshots from HistoryStore
// (localStorage), groups them by save-date, and supports filtering by
// date range, symbol substring, and forecast direction.
(function () {
  var els = {
    dateFrom: document.getElementById("dateFrom"),
    dateTo: document.getElementById("dateTo"),
    symFilter: document.getElementById("symFilter"),
    dirFilter: document.getElementById("dirFilter"),
    reset: document.getElementById("resetFilters"),
    summary: document.getElementById("filterSummary"),
    groups: document.getElementById("dateGroups"),
    clear: document.getElementById("historyClear"),
    exportBtn: document.getElementById("historyExport")
  };

  function savedDate(entry) { return entry.savedAt.slice(0, 10); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function fmtClock(iso) {
    var d = new Date(iso);
    return d.toISOString().slice(11, 16) + " UTC";
  }
  function fmtDateLong(ymdStr) {
    var d = new Date(ymdStr + "T12:00:00Z");
    return d.toUTCString().slice(0, 16); // "Sat, 02 May 2026"
  }
  function ccyOf(symbol) { return /\.SR$/i.test(symbol) ? "SAR" : "USD"; }

  function applyFilters(entries) {
    var from = els.dateFrom.value;
    var to = els.dateTo.value;
    var sym = (els.symFilter.value || "").trim().toUpperCase();
    var dir = els.dirFilter.value;
    return entries.filter(function (e) {
      var d = savedDate(e);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (sym && e.symbol.toUpperCase().indexOf(sym) === -1) return false;
      if (dir && e.forecast.direction !== dir) return false;
      return true;
    });
  }

  function render() {
    var all = window.HistoryStore.getAll(); // newest first
    var filtered = applyFilters(all);

    // Group by save date
    var groups = {};
    filtered.forEach(function (e) {
      var key = savedDate(e);
      (groups[key] = groups[key] || []).push(e);
    });
    var dateKeys = Object.keys(groups).sort().reverse();

    els.summary.textContent =
      filtered.length + " snapshot" + (filtered.length === 1 ? "" : "s") +
      " across " + dateKeys.length + " day" + (dateKeys.length === 1 ? "" : "s") +
      (filtered.length !== all.length ? "  ·  filtered from " + all.length + " total" : "");

    els.groups.innerHTML = "";

    if (filtered.length === 0) {
      var empty = document.createElement("div");
      empty.className = "card";
      empty.innerHTML = '<p class="card-sub">No snapshots match. Press <strong>Load</strong>, <strong>Refresh</strong>, or change the horizon on the dashboard to start a history.</p>';
      els.groups.appendChild(empty);
      return;
    }

    dateKeys.forEach(function (date) {
      var section = document.createElement("section");
      section.className = "date-group";
      section.innerHTML =
        '<header class="date-group-head">' +
          '<h3>' + fmtDateLong(date) + '</h3>' +
          '<span class="date-group-count">' + groups[date].length + '</span>' +
        '</header>' +
        '<div class="date-group-body"></div>';
      var body = section.querySelector(".date-group-body");

      // Sort entries within a day newest-first
      groups[date].sort(function (a, b) { return new Date(b.savedAt) - new Date(a.savedAt); });

      groups[date].forEach(function (e) { body.appendChild(buildSnapshot(e)); });
      els.groups.appendChild(section);
    });
  }

  function buildSnapshot(e) {
    var dirClass = e.forecast.direction || "flat";
    var ccy = ccyOf(e.symbol);
    var conf = Math.round((e.forecast.confidence || 0) * 100);
    var pct = ((e.forecast.target - e.lastClose) / e.lastClose) * 100;
    var horizon = e.horizonWeeks + "W (" + (e.horizonWeeks * 5) + " sessions)";

    var card = document.createElement("article");
    card.className = "snap " + dirClass;

    var dayCardsHtml = "";
    if (e.forecast.days && e.forecast.days.length) {
      dayCardsHtml = '<div class="snap-days">' +
        e.forecast.days.map(function (d) {
          var dpct = ((d.target - e.lastClose) / e.lastClose) * 100;
          var ddir = d.target > e.lastClose ? "up" : d.target < e.lastClose ? "down" : "flat";
          var dconf = Math.round((d.confidence || 0) * 100);
          return '<div class="snap-day ' + ddir + '">' +
            '<div class="snap-day-num">D' + d.dayIndex + '</div>' +
            '<div class="snap-day-date">' + d.date + '</div>' +
            '<div class="snap-day-target">' + d.target.toFixed(2) + '</div>' +
            '<div class="snap-day-pct ' + ddir + '">' + (dpct >= 0 ? "+" : "") + dpct.toFixed(2) + '%</div>' +
            '<div class="snap-day-conf">' + dconf + '%</div>' +
          '</div>';
        }).join("") +
      '</div>';
    }

    var patternsHtml = "";
    if (e.patterns && e.patterns.length) {
      patternsHtml = '<div class="snap-patterns">' +
        e.patterns.map(function (p) {
          return '<span class="snap-pattern ' + (p.bias === "bull" ? "up" : p.bias === "bear" ? "down" : "flat") + '">' +
            p.name + ' · ' + p.stage + '</span>';
        }).join("") +
      '</div>';
    }

    card.innerHTML =
      '<header class="snap-head">' +
        '<div class="snap-id">' +
          '<span class="snap-symbol">' + e.symbol + '</span>' +
          '<span class="snap-time">' + fmtClock(e.savedAt) + ' · ' +
              (e.source === "live" ? '<span class="src-live">LIVE</span>' : '<span class="src-demo">DEMO</span>') +
              ' · close ' + e.lastDate + '</span>' +
        '</div>' +
        '<div class="snap-actions">' +
          '<button class="btn btn-primary btn-sm restore-btn" data-id="' + e.id + '">Open in dashboard</button>' +
          '<button class="hist-remove" data-id="' + e.id + '" title="Remove">✕</button>' +
        '</div>' +
      '</header>' +

      '<div class="snap-kpis">' +
        '<div class="kpi"><div class="kpi-label">Direction</div>' +
            '<div class="kpi-value dir-' + dirClass + '">' + (e.forecast.label || "—") + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Last close</div>' +
            '<div class="kpi-value">' + e.lastClose.toFixed(2) + ' ' + ccy + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Target ' + horizon + '</div>' +
            '<div class="kpi-value">' + e.forecast.target.toFixed(2) + ' ' + ccy +
            ' <span class="kpi-pct ' + dirClass + '">(' + (pct >= 0 ? "+" : "") + pct.toFixed(2) + '%)</span></div></div>' +
        '<div class="kpi"><div class="kpi-label">Expected range</div>' +
            '<div class="kpi-value">' + e.forecast.lower.toFixed(2) + ' – ' + e.forecast.upper.toFixed(2) + ' ' + ccy + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Composite score</div>' +
            '<div class="kpi-value">' + (e.forecast.score >= 0 ? "+" : "") + e.forecast.score.toFixed(2) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Confidence</div>' +
            '<div class="kpi-value">' + conf + '%</div>' +
            '<div class="hist-conf-bar"><div class="hist-conf-fill" style="width:' + conf + '%"></div></div>' +
        '</div>' +
      '</div>' +

      patternsHtml +
      dayCardsHtml +

      (e.forecast.rationale ? '<p class="snap-rationale">' + e.forecast.rationale + '</p>' : '');

    card.querySelector(".restore-btn").addEventListener("click", function () {
      window.location.href = "index.html?restore=" + encodeURIComponent(e.id);
    });
    card.querySelector(".hist-remove").addEventListener("click", function () {
      window.HistoryStore.remove(parseInt(e.id, 10));
      render();
    });

    return card;
  }

  // ── Filter & global handlers ──
  ["input", "change"].forEach(function (ev) {
    [els.dateFrom, els.dateTo, els.symFilter, els.dirFilter].forEach(function (el) {
      el.addEventListener(ev, render);
    });
  });

  els.reset.addEventListener("click", function () {
    els.dateFrom.value = "";
    els.dateTo.value = "";
    els.symFilter.value = "";
    els.dirFilter.value = "";
    render();
  });

  els.clear.addEventListener("click", function () {
    if (confirm("Clear all history snapshots? This cannot be undone.")) {
      window.HistoryStore.clear();
      render();
    }
  });

  els.exportBtn.addEventListener("click", function () {
    var data = window.HistoryStore.getAll();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "7203-dashboard-history-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // Pre-fill the "to" date with today so the picker feels less empty.
  els.dateTo.max = ymd(new Date());
  els.dateFrom.max = ymd(new Date());

  render();
})();
