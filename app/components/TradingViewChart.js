export default function TradingViewChart({ symbol, interval, height = 400 }) {
  const src = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(symbol)}&interval=${interval}&theme=dark&style=1&timezone=Etc%2FUTC&hide_side_toolbar=0&allow_symbol_change=0&save_image=0&details=0&calendar=0&studies=%5B%5D&locale=en`;
  return (
    <iframe
      src={src}
      style={{ width: '100%', height, border: 'none', display: 'block' }}
      title={`TradingView ${symbol} ${interval}`}
    />
  );
}
