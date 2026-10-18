// Telegram-бот на Telegraf для BUDZEN.
// Два режима:
//   1) Локально — long polling через startBot() (из server/index.js).
//   2) На Vercel — webhook: createBot() + api/telegram-webhook.js вызывает handleUpdate.
import { Telegraf, Markup } from 'telegraf'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { creditStarsPurchase } from './db.js'

const MINI_APP_URL = process.env.MINI_APP_URL || 'https://budzen-lemon.vercel.app'

// Курс пополнения: 1 Star = 10 BC. Минимум — 1 Star (10 BC).
export const BC_PER_STAR = 10
export const MIN_STARS = 1
export const MAX_STARS = 100000

// Перевести сумму BC в целое число звёзд (вверх, чтобы не недоначислить).
export function starsForBc(bc) {
  return Math.max(MIN_STARS, Math.ceil(Number(bc) / BC_PER_STAR))
}

// Собрать объект invoice для createInvoiceLink / replyWithInvoice по количеству звёзд.
// payload кодирует число звёзд: 'buy_bc_<stars>'. При successful_payment BC = stars * BC_PER_STAR.
export function buildInvoiceByStars(stars) {
  const safeStars = Math.min(MAX_STARS, Math.max(MIN_STARS, Math.ceil(Number(stars))))
  if (!Number.isFinite(safeStars) || safeStars < MIN_STARS) return null
  const bc = safeStars * BC_PER_STAR
  return {
    title: 'Пополнение BUDZEN',
    description: `Начисление ${bc} BC на игровой баланс`,
    payload: `buy_bc_${safeStars}`,
    currency: 'XTR', // Telegram Stars
    prices: [{ label: `${bc} BC`, amount: safeStars }],
    provider_token: '', // пустая строка для цифровых товаров (Stars)
  }
}

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

  // /buy — отправить счёт на пополнение BC за Telegram Stars (по умолчанию 100 ⭐ = 1000 BC).
  bot.command('buy', async (ctx) => {
    const invoice = buildInvoiceByStars(100)
    if (!invoice) return
    try {
      await ctx.replyWithInvoice(invoice)
    } catch (error) {
      console.error('[bot] Не удалось отправить инвойс:', error instanceof Error ? error.message : error)
      await ctx.reply('Не удалось создать счёт. Попробуй позже или открой приложение.')
    }
  })

  // Telegram требует ответить на pre_checkout_query в течение 10 секунд.
  bot.on('pre_checkout_query', async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true)
    } catch (error) {
      console.error('[bot] Ошибка pre_checkout_query:', error instanceof Error ? error.message : error)
    }
  })

  // Успешная оплата — начисляем BC (stars * BC_PER_STAR).
  bot.on('successful_payment', async (ctx) => {
    try {
      const payment = ctx.message?.successful_payment
      const fromId = ctx.from?.id
      if (!payment || !fromId) return
      const stars = payment.total_amount ?? 0
      const bc = stars * BC_PER_STAR
      const updated = await creditStarsPurchase(fromId, stars, bc)
      if (updated) {
        await ctx.reply(`✅ Оплата получена! Начислено ${bc} BC (${stars} ⭐). Баланс: ${Number(updated.balance_bc).toLocaleString('ru-RU')} BC.`)
      } else {
        console.error('[bot] successful_payment: пользователь не найден по telegram_id', fromId)
        await ctx.reply('✅ Оплата получена, но не удалось найти аккаунт. Напиши в поддержку.')
      }
    } catch (error) {
      console.error('[bot] Ошибка successful_payment:', error instanceof Error ? error.message : error)
    }
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
