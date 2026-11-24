# market-dashboard

Market comparison dashboard: overlay stocks, gold, crypto and macro indicators on one chart.
Static site on GitHub Pages, charts by [lightweight-charts](https://github.com/tradingview/lightweight-charts) 5.3.0 (pinned, unpkg).

**Live:** https://marumarunoai.github.io/market-dashboard/

## How it works

- `indicators.json` is the one indicator list. Each entry: `id, name, source, symbol, category, scale` (`pct` = shared % axis rebased to the leftmost visible bar; `own` = its own pane and price axis), optional `on` (shown by default), `backfill` (Yahoo symbol used before a live source's history starts), `marks` (FRED series whose changes are marked, used for Fed hikes/cuts).
- Server-side sources (Yahoo, FRED) have no browser CORS, so `fetch.py` runs in `.github/workflows/fetch.yml` every 4h and commits `data/<id>.json` plus `data/status.json`. A failed fetch keeps the previous file and records the error, which the UI shows.
- Browser-direct sources (CORS `*`): Binance klines via `data-api.binance.vision` (falls back to `api.binance.com`), alternative.me Fear & Greed.
- Adding an indicator from an existing source = one line in `indicators.json`. A new source = one function in `FETCH` (app.js) or `FETCHERS` (fetch.py).

## Data sources (tested 2026-11-24)

| Source | Works | History | 4H | Browser CORS |
|---|---|---|---|---|
| Yahoo v8 chart (query1/query2) | yes | daily from listing (^GSPC 1970, NVDA 1999, GC=F 2000, ^VIX 1990, DX-Y.NYB 1971) via `period1=0` (`range=max` returns monthly bars) | 60m bars ~730 days, bucketed to 4H | no |
| Stooq CSV | no: TLS connection refused from the build box | – | – | – |
| Binance api.binance.com | HTTP 451 (geo-blocked from US-hosted machines) | – | – | – |
| Binance data-api.binance.vision | yes | BTC/ETH from 2017-08-17, PAXG from 2020-08-28 | yes, native 4h | yes |
| CoinGecko public | 365 days only (full history is paid) | – | – | yes |
| alternative.me F&G (`limit=0`) | yes | 2018-02-01 | no (daily) | yes |
| FRED `fredgraph.csv` (keyless) | yes for all tested series; `DTWEXBGSUSD` and `WILL5000IND` 404 (use `DTWEXBGS`) | full | no | no |

BTC/ETH daily before Binance's first bar come from Yahoo `BTC-USD` (2014-09) / `ETH-USD`.
FRED uses the API when the `FRED_API_KEY` secret exists, otherwise keyless `fredgraph.csv`.

Gold is COMEX front-month futures (GC=F); PAXG is the live 4H alternative.
