// Sends a message via the Telegram Bot API. Silently does nothing if the
// bot isn't configured yet, so the worker doesn't crash before Telegram is
// set up — create a bot with @BotFather, then set TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID.
//
// parseMode is opt-in ('HTML' for <b>bold</b> etc.) and off by default —
// every existing caller sends plain text with characters like `·`, `%`, `$`
// that are fine as-is, and turning HTML parsing on globally would break any
// message that happens to contain a literal `<` or `&`. Only pass it for a
// message you've built specifically as HTML.
async function sendMessage(text, parseMode) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const body = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error('Telegram send failed:', await res.text());
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

module.exports = { sendMessage };
