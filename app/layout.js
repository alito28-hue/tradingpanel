import './globals.css';
import { ThemeProvider, ThemeToggle } from './components/ui';

export const metadata = {
  title: 'TradingPanel — Intraday Momentum',
  description: 'Intraday momentum dashboard and backtest utilities',
  icons: { icon: '/logo.png' },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          {children}
          <ThemeToggle />
        </ThemeProvider>
      </body>
    </html>
  );
}
