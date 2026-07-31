# Protocolo de análisis de señales (lectura discrecional, no automatizada)

Definido el 23/07/2026. Este es el proceso fijo a seguir cada vez que Alex envía una posible señal long/short para analizar. No reemplaza su decisión — es un análisis de apoyo, él ejecuta manualmente.

## Qué envía Alex

Capturas de las 4 temporalidades del activo (ej. 1m, 5m, 15m, 1h — o las que tenga abiertas en ese momento), idealmente con MACD y RSI visibles en cada una, y el order book visible cuando esté disponible.

**Exchange (actualizado 24/07):** se pasó de BingX a Binance para las capturas — cuenta ya verificada. Motivo: BingX limita el order book a 10 niveles fijos alrededor del precio actual, lo que lo vuelve solo confirmatorio (nunca se ve un nivel hasta que el precio ya está encima). Binance muestra más profundidad, así que el book puede volver a usarse para anticipar paredes lejos del precio actual, no solo para confirmar al llegar. El resto del protocolo no cambia.

## Qué se analiza en cada señal

1. **Test o retest del nivel**: ¿es la primera vez que el precio toca esa zona de soporte/resistencia, o ya la tocó antes y la sostuvo/rechazó? Un retest confirmado es estructuralmente más fuerte que un primer toque. Señalar explícitamente cuál de los dos es.

2. **RSI y MACD en cada una de las 4 temporalidades**: no alcanza con que una sola temporalidad muestre agotamiento — señalar cuáles están en zona de sobrecompra/sobreventa, cuáles tienen el histograma del MACD expandiéndose (momentum acelerando) vs achicándose/plano (momentum agotándose), y si hay alineación entre timeframes rápidos (1m/5m) y lentos (15m/1h) o si están en conflicto.

3. **Order book**: paredes de compra/venta visibles cerca del precio actual, desbalance del book (% compra vs venta que suele mostrar BingX), y si hay liquidez relevante entre el precio actual y un SL/TP razonable.

4. **SL sugerido**: un nivel de stop razonable basado en la estructura real (debajo/encima del soporte o resistencia relevante, no un % arbitrario), explicando por qué ese nivel específico.

## Modelo de Análisis Técnico para Entradas (versión de Alex, 30/07/2026)

Formalización propia de Alex del marco de arriba, en uso en vivo — reemplaza/amplía el punteo anterior como referencia de trabajo:

1. **Análisis multitemporal (macro vs. micro)**: 4H define la tendencia principal (MACD + estructura de máximos/mínimos manda) — nunca operar en contra de 4H sin confirmación estructural masiva. 1H/15M se usa para ubicar retrocesos, pausas o zonas de confluencia donde el precio se alinea de nuevo con la tendencia macro.

2. **Niveles clave y trampas de liquidez**: mapeo estricto de Daily/Weekly Highs-Lows y soportes/resistencias locales. Evaluar si un rompimiento es genuino o un barrido de liquidez (trampa de stops) antes de una reversión — no anticipar techos/pisos sin ver la reacción del precio.

3. **Confluencia de indicadores de momento**: MACD para validar fuerza de impulsos en temporalidades mayores (evitar operar contra la inercia). RSI/medias móviles para sobrecompra-sobreventa relativa y soporte dinámico de tendencia.

4. **Order book y flujo (contexto auxiliar)**: el book y el % compradores/vendedores es complementario, no decide — desequilibrios extremos a veces buscan inducir error operativo. La estructura del gráfico manda sobre el order book.

5. **Plan de ejecución y riesgo**: esperar confirmación (no perseguir el precio ni operar por FOMO), entrada en confluencia técnica real (no niveles arbitrarios), SL en el punto donde la tesis estructural queda invalidada (debajo del swing low / arriba del swing high), R:R definido por la estructura previa.

## Lo que este análisis NO hace

No da una señal de "comprar/vender" con certeza — da el estado real de la evidencia (alineada, mixta, o en contra) para que la decisión final y el timing de ejecución sean de Alex. Ya establecimos en la sesión del 23/07 que ninguna señal, técnica o de indicador, llega temprana Y confiable a la vez — este protocolo busca que la lectura sea honesta sobre esa tensión, no que la resuelva.

## Alertas automáticas (Warrior Momentum, stocks vía Webull) — 24/07

Solo notifica, no ejecuta nada — Alex pidió automatizar la ejecución en Webull y no se puede (regla fija: nunca se ejecutan trades ni se mueve dinero de una cuenta, sin excepción). Esto SÍ se armó: Pine indicator (no strategy) en `docs/estrategias/PINE_ALERTA_WARRIOR.txt`, basado en `WARRIOR-MOMEMTUM.txt` (vela roja + MACD histograma positivo + horario 04:00-09:30 NY) → alerta de TradingView vía webhook → `worker/index.js` ruta `POST /tv-webhook/<TV_WEBHOOK_SECRET>` → Telegram (reusa `sendMessage` de `lib/telegram.js`, mismo bot que ya usa el bot de BTC).

Pendiente para que funcione en la práctica:
- Definir `TV_WEBHOOK_SECRET` como variable de entorno en Railway (mismo lugar que `WORKER_API_SECRET`, `TELEGRAM_BOT_TOKEN`).
- Alex: `git push` para que Railway despliegue el cambio de `worker/index.js` (mismo caso que Vercel — no lee la carpeta local en vivo).
- Por cada ticker del scanner, pegar el Pine en TradingView y crear la alerta apuntando al webhook (instrucciones completas en el .txt).

## Log de operaciones (app/trades, ex Excel)

Página `/trades` en la app (link "Operaciones →" desde el dashboard), datos en `app/results/manual_trades.json`. División de trabajo acordada el 23/07:

- **Claude carga**: cuando Alex manda el detalle de una operación (fecha/hora entrada, monto, palanca, resultado, gastos, PnL real), Claude edita `manual_trades.json` directo.
- **Alex pushea**: Vercel despliega desde GitHub, no lee la carpeta local en vivo — así que después de que Claude carga, Alex hace `git add -A && git commit -m "trade" && git push` para que se vea reflejado en la versión de Vercel. Claude no tiene credenciales de push configuradas en este entorno.

## Historial de casos reales (ir agregando)

- **23/07/2026, entrada 15:11**: Long BTCUSDT, entrada 64,737.1, SL 64,640 (riesgo ~$100), salida 15:44 con ~$77-122 de ganancia (R:R realizado ~0.8-1.2:1). Primer toque de la zona de soporte, MACD en 15m todavía negativo/recién aplanándose al momento de la entrada (no confirmado).
- **Comparación, mismo día ~16:45**: el mismo nivel de soporte (~64,650-64,660) tuvo un segundo toque; en ese momento el MACD de 1m y 5m ya había cruzado a positivo y se expandía con fuerza. El movimiento posterior fue mucho más limpio y extendido (~400+ puntos) que el capturado en la entrada de las 15:11.
