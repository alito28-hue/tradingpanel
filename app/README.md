# TradingPanel — Intraday Momentum

This folder contains the intraday momentum dashboard and backtest utilities.

Quick commands

- Start a local static preview (open from `app`):

```bash
cd /Users/alito28/Library/CloudStorage/Dropbox/Mac\ (2)/Desktop/tradingpanel/app
python3 -m http.server 8001
# open http://localhost:8001/intraday_backtest.html or intraday_momentum_dashboard.html
```

- Run the headless backtest (Node 18+/24+ required):

```bash
cd /Users/alito28/Library/CloudStorage/Dropbox/Mac\ (2)/Desktop/tradingpanel/app/scripts
node run_backtest.js
# outputs: ../backtest_result.json and ../backtest_log.txt
```

- Export JSON results into `app/results/` and generate per-scenario CSVs:

```bash
cd /Users/alito28/Library/CloudStorage/Dropbox/Mac\ (2)/Desktop/tradingpanel
node app/scripts/export_results_to_csv.js
# outputs: app/results/backtest_result.json, *_trades.csv, *_metrics.json
```

Where to find results

- JSON: `app/results/backtest_result.json`
- CSVs: `app/results/con_filtro_de_régimen_1h_trades.csv` and `app/results/sin_filtro_de_régimen_1h_trades.csv`
- Metrics: `app/results/*_metrics.json`

Notes

- Node: the backtest script and exporter rely on `global.fetch` available in Node 18+ (we recommend Node 24 for parity with local runs).
- This project is self-contained in this folder and has its own Git repository; I will not modify other projects.
- If you want, I can also add a minimal `package.json` and `.nvmrc` at the repository root (already prepared).
