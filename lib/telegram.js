// Sends a message via the Telegram Bot API. Silently does nothing if the
// bot isn't configured yet, so the worker doesn't crash before Telegram is
// set up — create a bot with @BotFather, then set TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID.
async function sendMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.error('Telegram send failed:', await res.text());
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

module.exports = { sendMessage };
