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

## Hosted online

Pushes to this branch (or `main`) deploy automatically to GitHub Pages via
`.github/workflows/pages.yml`. To enable:

1. Open the repo on GitHub → **Settings → Pages**.
2. Set **Source** to *GitHub Actions*.
3. Re-run the latest workflow if needed.

The deployed URL is shown on the workflow run summary and is typically:

```
https://<owner>.github.io/7203-dashboard-/
```

## Live vs demo data

On load (and when you click **Refresh**), `live.js` attempts to pull the
last year of daily candles for `7203.SR` from Yahoo Finance through a
public CORS proxy (`corsproxy.io`, falling back to `allorigins.win`). The
header pill shows **LIVE** if the fetch succeeded, otherwise **DEMO**.

The embedded fallback in `data.js` is anchored to the publicly reported
last close of **575.00 SAR (29 Apr 2026)**, prior close 570.50 SAR, and
52-week range ~504.50 – 1,090.00 SAR — verified against Investing.com,
StockAnalysis.com and Tadawul.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Layout & containers |
| `style.css` | Dashboard styling |
| `data.js` | Embedded fallback OHLCV anchored to verified Tadawul levels |
| `live.js` | Fetches a fresh 1-year series from Yahoo Finance via CORS proxy |
| `indicators.js` | SMA / EMA / RSI / MACD / ATR / swing pivot detection |
| `patterns.js` | Bulkowski pattern detection + reference statistics |
| `app.js` | Wires charts, detection and forecast together |
| `.github/workflows/pages.yml` | Deploys the static site to GitHub Pages |

## Replacing the data source

`data.js` produces a deterministic 220-session series anchored to
verified Tadawul price levels for offline use. `live.js` fetches the
real series at runtime. To swap in your own data feed, expose a
function that returns:

```js
[{ date: "YYYY-MM-DD", open, high, low, close, volume }, ...]
```

…then call `render(rows, "live")` from `app.js`.

## Disclaimer

This is an educational dashboard. The pattern probabilities cited come
from Bulkowski's published research on past market behaviour and do not
guarantee future returns. Nothing here is investment advice.
