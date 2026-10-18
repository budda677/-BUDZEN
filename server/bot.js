// Telegram-бот на Telegraf для BUDZEN.
// Два режима:
//   1) Локально — long polling через startBot() (из server/index.js).
//   2) На Vercel — webhook: createBot() + api/telegram-webhook.js вызывает handleUpdate.
import { Telegraf, Markup } from 'telegraf'
import { HttpsProxyAgent } from 'https-proxy-agent'

const MINI_APP_URL = process.env.MINI_APP_URL || ''

function isValidMiniAppUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false
    if (/your_?bot|example\.|твой|your-domain/i.test(url)) return false
    return true
  } catch {
    return false
  }
}

const MINI_APP_URL_VALID = isValidMiniAppUrl(MINI_APP_URL)

// Прокси нужен только локально. На Vercel его нет и не должно быть.
const PROXY_URL = process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''

async function sendStartMessage(ctx, text) {
  if (MINI_APP_URL_VALID) {
    try {
      await ctx.reply(text, Markup.inlineKeyboard([Markup.button.webApp('🚀 Открыть BUDZEN', MINI_APP_URL)]))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/BUTTON_URL_INVALID|BUTTON_INVALID|wrong HTTP URL/i.test(message)) {
        console.error('[bot] Не удалось отправить сообщение с кнопкой:', message)
      }
    }
    try {
      await ctx.reply(text, Markup.inlineKeyboard([Markup.button.url('🚀 Открыть BUDZEN', MINI_APP_URL)]))
      return
    } catch (error) {
      console.error('[bot] Не удалось отправить сообщение с url-кнопкой:', error instanceof Error ? error.message : error)
    }
  }
  try {
    await ctx.reply(`${text}\n\n(Кнопка приложения появится, когда задан MINI_APP_URL — публичный HTTPS-адрес Mini App.)`)
  } catch (error) {
    console.error('[bot] Не удалось отправить текстовое сообщение:', error instanceof Error ? error.message : error)
  }
}

export function createBot(token) {
  const options = {}
  if (PROXY_URL) {
    options.telegram = { agent: new HttpsProxyAgent(PROXY_URL) }
  }
  const bot = new Telegraf(token, options)

  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ? `, ${ctx.from.first_name}` : ''
    const text = `Привет${name} 👋\n\nДобро пожаловать в BUDZEN — твою игровую экономику.\nОбменивай валюты, участвуй в играх и зарабатывай BC.`
    await sendStartMessage(ctx, text)
  })

  bot.on('text', async (ctx) => {
    await sendStartMessage(ctx, 'Открой приложение — команда /start покажет кнопку.')
  })

  bot.catch((error) => {
    console.error('[bot] Ошибка обработки обновления:', error instanceof Error ? error.message : error)
  })

  return bot
}

export async function setupBotMeta(bot) {
  try {
    if (MINI_APP_URL_VALID) {
      await bot.telegram.setChatMenuButton({ menuButton: { type: 'web_app', text: 'BUDZEN', web_app: { url: MINI_APP_URL } } })
      console.log('[bot] Синяя кнопка-меню (Mini App) установлена.')
    } else {
      await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } })
      console.log('[bot] MINI_APP_URL не задан — кнопка-меню установлена как «команды».')
    }
  } catch (error) {
    console.error('[bot] Не удалось установить кнопку-меню:', error instanceof Error ? error.message : error)
  }
  try {
    await bot.telegram.setMyCommands([{ command: 'start', description: 'Открыть BUDZEN' }])
  } catch {
    // Игнорируем.
  }
}

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запущен.')
    return null
  }
  if (PROXY_URL) {
    console.log(`[bot] Использую прокси: ${PROXY_URL.replace(/\/\/[^@]*@/, '//***@')}`)
  } else {
    console.log('[bot] Прокси не задан — подключаюсь к Telegram напрямую.')
  }

  const bot = createBot(token)

  bot.launch()
    .then(() => console.log('[bot] Telegram-бот запущен (long polling).'))
    .catch((error) => {
      console.error('[bot] Не удалось запустить бота:', error instanceof Error ? error.message : error)
    })

  void setupBotMeta(bot)

  const stop = (signal) => {
    try {
      bot.stop(signal)
      console.log(`[bot] Остановлен по сигналу ${signal}.`)
    } catch {
      // Игнорируем.
    }
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  return bot
}
