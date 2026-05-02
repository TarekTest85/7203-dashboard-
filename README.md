# 7203.SR — Tadawul Trend Dashboard

A single-page web dashboard for **Elm Company** (ticker **7203** on the
Saudi Stock Exchange / Tadawul) that estimates the next-week price trend
using chart-pattern detection inspired by **Thomas N. Bulkowski's
*Visual Guide to Chart Patterns***.

## What it does

- Renders a price chart with 20- and 50-session simple moving averages.
- Computes RSI(14) and MACD(12, 26, 9) with histogram.
- Detects the following Bulkowski patterns:
  - Head and Shoulders (Top / Bottom)
  - Double Top / Double Bottom
  - Ascending / Descending / Symmetrical Triangle
  - Rising / Falling Wedge
  - Bull Flag / Bear Flag
  - Cup with Handle
- Applies Bulkowski's published post-breakout statistics (average move,
  breakout direction probability) and combines them with trend, RSI and
  MACD votes into a composite next-week forecast (5 trading sessions,
  Sun–Thu on Tadawul). Output: direction, projected close, expected
  range (±1.2 ATR), and confidence.

## Run it

It's a static page — open `index.html` in any browser, or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

No build step, no dependencies beyond Chart.js (loaded from CDN).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Layout & containers |
| `style.css` | Dashboard styling |
| `data.js` | Generates the OHLCV series for 7203.SR (replace with a live fetch in production) |
| `indicators.js` | SMA / EMA / RSI / MACD / ATR / swing pivot detection |
| `patterns.js` | Bulkowski pattern detection + reference statistics |
| `app.js` | Wires charts, detection and forecast together |

## Replacing the synthetic data

`data.js` currently produces a deterministic 220-session series so the
dashboard renders consistently offline. To use live Tadawul data, replace
`buildSeries()` with a fetch call (e.g. Tadawul's market data API or a
provider such as Yahoo Finance: `7203.SR`) that returns the same array
shape:

```js
[{ date: "YYYY-MM-DD", open, high, low, close, volume }, ...]
```

## Disclaimer

This is an educational dashboard. The pattern probabilities cited come
from Bulkowski's published research on past market behaviour and do not
guarantee future returns. Nothing here is investment advice.
