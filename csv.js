// csv.js — CSV/OHLCV parser for user-uploaded files.
//
// Supports:
//   · Investing.com Arabic ("تاريخ","اخر سعر","سعر الفتح", …) with
//     DD/MM/YYYY dates, RTL marks, and K/M volume suffixes.
//   · Yahoo Finance / generic English ("Date,Open,High,Low,Close,
//     Adj Close,Volume") with ISO or MM/DD/YYYY dates.
//
// Auto-detects the format from the header row. Returns bars sorted
// ascending by date (oldest first), matching what the dashboard uses.
(function () {
  function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

  // Remove RTL / LTR marks and zero-width chars often embedded in
  // Arabic CSVs (U+200E, U+200F, U+202A-E, U+FEFF).
  function stripBidi(s) {
    return String(s == null ? "" : s).replace(/[​-‏‪-‮﻿]/g, "").trim();
  }

  // Convert Arabic-Indic (U+0660-0669) and Eastern-Arabic (U+06F0-06F9)
  // digits to ASCII 0-9.
  function toAsciiDigits(s) {
    return s.replace(/[٠-٩]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x30);
    }).replace(/[۰-۹]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x30);
    });
  }

  function parseCsvRow(line) {
    var out = [], cur = "", inQ = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
        continue;
      }
      if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map(function (v) { return stripBidi(toAsciiDigits(v)); });
  }

  function parseNum(s) {
    if (s == null) return NaN;
    var t = stripBidi(toAsciiDigits(String(s))).replace(/,/g, "").replace(/%$/, "");
    if (!t) return NaN;
    return parseFloat(t);
  }

  function parseVolume(s) {
    var t = stripBidi(toAsciiDigits(String(s == null ? "" : s))).replace(/,/g, "");
    if (!t) return 0;
    var mul = 1;
    var mtch = t.match(/^([+-]?\d*\.?\d+)\s*([KMB])?$/i);
    if (mtch) {
      var num = parseFloat(mtch[1]);
      var suf = (mtch[2] || "").toUpperCase();
      if (suf === "K") mul = 1e3;
      else if (suf === "M") mul = 1e6;
      else if (suf === "B") mul = 1e9;
      return Math.round(num * mul);
    }
    return parseInt(t, 10) || 0;
  }

  // Date parsing:
  //   "2026-07-02"        → 2026-07-02
  //   "02/07/2026"        → 2026-07-02 (DD/MM/YYYY, Investing.com AR)
  //   "07/02/2026"        → 2026-07-02 (MM/DD/YYYY, US)  ← disambiguate
  // We disambiguate DD/MM vs MM/DD by looking at the second segment:
  // if > 12 it must be day. If ambiguous, prefer DD/MM only when the
  // format was detected as Investing.com AR.
  function parseDate(s, format) {
    var t = stripBidi(toAsciiDigits(String(s == null ? "" : s)));
    if (!t) return null;
    var iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return iso[1] + "-" + pad(iso[2]) + "-" + pad(iso[3]);
    var slash = t.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (slash) {
      var a = parseInt(slash[1], 10), b = parseInt(slash[2], 10), y = slash[3];
      if (format === "investing_ar" || a > 12) {
        // DD/MM/YYYY
        return y + "-" + pad(b) + "-" + pad(a);
      }
      if (b > 12) {
        // MM/DD/YYYY
        return y + "-" + pad(a) + "-" + pad(b);
      }
      // Ambiguous: assume MM/DD/YYYY for the generic branch.
      return y + "-" + pad(a) + "-" + pad(b);
    }
    return null;
  }

  function pad(x) { var s = String(x); return s.length < 2 ? "0" + s : s; }

  function detectFormat(headers) {
    var joined = headers.map(function (h) { return h.toLowerCase(); }).join("|");
    if (/تاريخ|اخر سعر|سعر الفتح|الحجم/.test(headers.join(" "))) return "investing_ar";
    if (/^date/.test(joined) && /open/.test(joined) && /close/.test(joined)) return "yahoo";
    // Investing.com English: "Date","Price","Open","High","Low","Vol.","Change %"
    if (/date/.test(joined) && /price/.test(joined) && /vol\./.test(joined)) return "investing_en";
    return null;
  }

  function headerIndex(headers, match) {
    for (var i = 0; i < headers.length; i++) if (match.test(headers[i].toLowerCase())) return i;
    return -1;
  }

  function parse(text) {
    if (!text) return { error: "empty" };
    text = stripBOM(text);
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return { error: "too few rows" };
    var headers = parseCsvRow(lines[0]);
    var fmt = detectFormat(headers);
    if (!fmt) return { error: "unrecognised header row: " + headers.join(", ") };

    // Column indices per format.
    var idx;
    if (fmt === "investing_ar") {
      idx = { date: 0, close: 1, open: 2, high: 3, low: 4, vol: 5 };
    } else if (fmt === "investing_en") {
      idx = {
        date: headerIndex(headers, /^date/),
        close: headerIndex(headers, /^price/),
        open: headerIndex(headers, /^open/),
        high: headerIndex(headers, /^high/),
        low: headerIndex(headers, /^low/),
        vol: headerIndex(headers, /^vol\./)
      };
    } else {
      // yahoo — expect Date,Open,High,Low,Close[,Adj Close],Volume
      idx = {
        date: headerIndex(headers, /^date/),
        open: headerIndex(headers, /^open/),
        high: headerIndex(headers, /^high/),
        low: headerIndex(headers, /^low/),
        close: headerIndex(headers, /^close/),
        vol: headerIndex(headers, /^volume/)
      };
    }
    for (var k in idx) {
      if (idx[k] < 0) return { error: "missing column: " + k };
    }

    var bars = [];
    for (var i = 1; i < lines.length; i++) {
      var row = parseCsvRow(lines[i]);
      if (row.length < headers.length - 1) continue;
      var date = parseDate(row[idx.date], fmt);
      var close = parseNum(row[idx.close]);
      var open = parseNum(row[idx.open]);
      var high = parseNum(row[idx.high]);
      var low = parseNum(row[idx.low]);
      var vol = parseVolume(row[idx.vol]);
      if (!date || !isFinite(close) || close <= 0) continue;
      if (!isFinite(open)) open = close;
      if (!isFinite(high)) high = Math.max(open, close);
      if (!isFinite(low)) low = Math.min(open, close);
      bars.push({
        date: date,
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume: vol
      });
    }
    // Sort ascending by date and dedupe (last write wins).
    bars.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var out = [];
    for (var m = 0; m < bars.length; m++) {
      if (out.length && out[out.length - 1].date === bars[m].date) out[out.length - 1] = bars[m];
      else out.push(bars[m]);
    }
    return { format: fmt, bars: out };
  }

  window.CSVParser = { parse: parse, detectFormat: detectFormat };
})();
