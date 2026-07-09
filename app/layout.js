import './globals.css';

export const metadata = {
  title: 'TradingPanel — Intraday Momentum',
  description: 'Intraday momentum dashboard and backtest utilities',
  icons: { icon: '/logo.png' },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
