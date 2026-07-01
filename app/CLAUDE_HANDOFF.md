# Claude Code Handoff — TradingPanel Intraday Momentum

## Context
Este proyecto es una herramienta de análisis intradiario para BTCUSDT usando datos históricos de Binance en 1H y 1M.

Objetivo actual:
- Evaluar una estrategia intradiaria con señales en 1m
- Usar un filtro de régimen en 1h como comparación
- Simular entradas y salidas con stop/trailing realistas
- Modelar comisiones de órdenes límite maker reales
- Preparar el camino para una futura integración con BingX / ejecución de bot

## Estado actual

- `app/intraday_backtest.html`
  - Interfaz de backtest y comparación con/sin régimen 1H
  - Usa `Maker fee % por lado` como entrada de comisión
  - El calculo neto es ahora `grossPnlPct - feePct * 2`
  - Default actual: `0.05`% por lado

- `app/scripts/run_backtest.js`
  - Runner headless que descarga velas 1H/1M desde Binance
  - Simula señales, entradas, stops y trailing
  - Calcula `grossPnlPct` y `netPnlPct` usando 2 lados de maker fee
  - Exporta `app/backtest_result.json` y `app/backtest_log.txt`

- `app/scripts/export_results_to_csv.js`
  - Convierte resultados JSON a CSV y JSON de métricas bajo `app/results/`

- `app/scripts/analyze_trades.js`
  - Resume los CSV generados
  - Imprime win rate, avg win/loss, total PnL neto y top trades

## Últimos resultados verificados

- Con filtro de régimen 1H:
  - Trades: 181
  - Win rate: 81.77%
  - Total PnL neto: +188.34%

- Sin filtro de régimen 1H:
  - Trades: 205
  - Win rate: 84.88%
  - Total PnL neto: +295.75%

## Archivos clave

- `app/intraday_backtest.html`
- `app/scripts/run_backtest.js`
- `app/scripts/export_results_to_csv.js`
- `app/scripts/analyze_trades.js`
- `app/backtest_result.json`
- `app/results/`

## Revisión específica de comisiones

- El modelo actual asume órdenes límite maker en Binance.
- La entrada `Maker fee % por lado` se aplica tanto en compra como en venta.
- Por default, el costo total de comisión por trade es `0.05% * 2 = 0.10%`.
- Esto está alineado con la evidencia de órdenes límite demostradas en las capturas.

## Qué necesita Claude Code saber

1. El proyecto es auto-contenido bajo `app/`.
2. Las dos variantes comparadas son:
   - `Con filtro de régimen 1H`
   - `Sin filtro de régimen 1H`
3. El corredor de datos es Binance REST (klines 1h y 1m).
4. El cálculo de PnL neto usa comisiones maker reales de 0.05% por cada lado de trade.
5. Los resultados ya fueron verificados con una ejecución reciente.

## Siguientes pasos recomendados

- Revisar si el filtro de régimen 1H debe concretarse como una guard de mercado o solo como un filtro de entrada.
- Asegurar que la lógica de señales en `buildAnalysis` y `gateEntries` no incorpore lookahead.
- Preparar un módulo separado para la ejecución en BingX que use exactamente el mismo cálculo de comisión.
- Añadir, si se quiere, un `package.json` y `.nvmrc` en la raíz para estandarizar el entorno.

## Comandos útiles

```bash
cd /Users/alito28/Library/Application\ Support/Code/User/workspaceStorage/efc13e83fbb0fafcf580f8519a9fb11c/GitHub.copilot-chat
```

```bash
cd /Users/alito28/Library/CloudStorage/Dropbox/Mac\ \(2\)/Desktop/tradingpanel/app
python3 -m http.server 8001
# abrir http://localhost:8001/intraday_backtest.html
```

```bash
cd /Users/alito28/Library/CloudStorage/Dropbox/Mac\ \(2\)/Desktop/tradingpanel
node app/scripts/run_backtest.js
node app/scripts/export_results_to_csv.js
node app/scripts/analyze_trades.js
```

---

> Nota: no hay cambios pendientes fuera de los archivos listados. El modelo de comisión ya está actualizado y ha sido validado con un backtest reciente.
