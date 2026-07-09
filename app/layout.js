import './globals.css';
import LogoutLink from './components/LogoutLink';

export const metadata = {
  title: 'TradingPanel — Intraday Momentum',
  description: 'Intraday momentum dashboard and backtest utilities',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <LogoutLink />
      </body>
    </html>
  );
}
