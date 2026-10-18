// Vercel Serverless: приём обновлений Telegram через webhook.
// Telegram вызывает этот эндпоинт на каждое сообщение/команду боту.
// Это позволяет боту работать 24/7 без запущенного ПК.
import { createBot } from '../server/bot.js'

// Переиспользуем один экземпляр бота между «тёплыми» вызовами функции.
let cachedBot = null

function getBot(token) {
  if (!cachedBot) cachedBot = createBot(token)
  return cachedBot
}

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан' })
    return
  }

  // Проверка секрета (если задан TELEGRAM_WEBHOOK_SECRET — тот же, что в setWebhook).
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (expectedSecret) {
    const got = req.headers['x-telegram-bot-api-secret-token']
    if (got !== expectedSecret) {
      res.status(401).json({ ok: false, error: 'bad secret' })
      return
    }
  }

  if (req.method !== 'POST') {
    res.status(200).json({ ok: true })
    return
  }

  // Тело уже распарсено Vercel в req.body (объект) либо это строка — приводим к объекту.
  let update = req.body
  if (typeof update === 'string') {
    try { update = JSON.parse(update) } catch { update = null }
  }
  if (!update) {
    res.status(200).json({ ok: true })
    return
  }

  try {
    const bot = getBot(token)
    await bot.handleUpdate(update)
    res.status(200).json({ ok: true })
  } catch (error) {
    console.error('[webhook] Ошибка обработки update:', error instanceof Error ? error.message : error)
    // Всегда 200, чтобы Telegram не зацикливал повторные доставки.
    res.status(200).json({ ok: false })
  }
}
