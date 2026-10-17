// Telegram-бот на Telegraf для BUDZEN.
// Запускается из server/index.js после поднятия API-сервера.
// Токен берётся из process.env.TELEGRAM_BOT_TOKEN (загружается server/env.js ДО этого модуля).
import { Telegraf, Markup } from 'telegraf'
import { HttpsProxyAgent } from 'https-proxy-agent'

// Ссылка для открытия Mini App. Задаётся через переменную окружения.
// Реальный адрес должен быть HTTPS и привязан к боту (BotFather → Configure Mini App).
// Пример: https://your-domain.com/  или  https://t.me/YourBotName/app
const MINI_APP_URL = process.env.MINI_APP_URL || ''

// Telegram принимает webApp-кнопку только для валидного HTTPS-URL.
// Заглушки (t.me/your_bot/app, localhost, 127.0.0.1, example.com) отклоняются или
// сохраняются как пустой URL — поэтому считаем их невалидными.
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

// Сетевой прокси. Во многих сетях (VPN-клиент / корпоративная сеть) прямой доступ
// к api.telegram.org из Node заблокирован (ETIMEDOUT), хотя системный прокси Windows
// работает. Node системный прокси автоматически НЕ использует — задаём явно.
// Берём из TELEGRAM_PROXY, иначе из HTTPS_PROXY / HTTP_PROXY.
const PROXY_URL = process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''

let bot = null

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN

  // Без токена бот не запускается, но API-сервер продолжает работать.
  if (!token) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запущен.')
    return null
  }

  const options = {}
  if (PROXY_URL) {
    // Агент с прокси для всех запросов Telegraf к Telegram API.
    options.telegram = { agent: new HttpsProxyAgent(PROXY_URL) }
    console.log(`[bot] Использую прокси: ${PROXY_URL.replace(/\/\/[^@]*@/, '//***@')}`)
  } else {
    console.log('[bot] Прокси не задан — подключаюсь к Telegram напрямую.')
  }

  bot = new Telegraf(token, options)

  // Отправляет приветствие с кнопкой приложения. Если webApp-кнопка невалидна
  // (не задан реальный HTTPS URL Mini App) — отправляет сообщение БЕЗ неё,
  // чтобы пользователь гарантированно получил ответ, а не молчание.
  async function sendStartMessage(ctx, text) {
    // 1) Пробуем кнопку-приложение (только если URL валиден).
    if (MINI_APP_URL_VALID) {
      try {
        await ctx.reply(
          text,
          Markup.inlineKeyboard([Markup.button.webApp('🚀 Открыть BUDZEN', MINI_APP_URL)]),
        )
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/BUTTON_URL_INVALID|BUTTON_INVALID|wrong HTTP URL/i.test(message)) {
          console.error('[bot] Не удалось отправить сообщение с кнопкой:', message)
        }
        // Падаем в фолбэк ниже.
      }
    }

    // 2) Фолбэк: сообщение с обычной URL-кнопкой (если есть валидный URL).
    if (MINI_APP_URL_VALID) {
      try {
        await ctx.reply(
          text,
          Markup.inlineKeyboard([Markup.button.url('🚀 Открыть BUDZEN', MINI_APP_URL)]),
        )
        return
      } catch (error) {
        console.error('[bot] Не удалось отправить сообщение с url-кнопкой:', error instanceof Error ? error.message : error)
      }
    }

    // 3) Фолбэк: просто текст без кнопки — доставится всегда.
    try {
      await ctx.reply(
        `${text}\n\n(Кнопка приложения появится, когда будет задан MINI_APP_URL — публичный HTTPS-адрес Mini App.)`,
      )
    } catch (error) {
      console.error('[bot] Не удалось отправить текстовое сообщение:', error instanceof Error ? error.message : error)
    }
  }

  // /start — приветствие и кнопка открытия Mini App (WebApp).
  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ? `, ${ctx.from.first_name}` : ''
    const text = `Привет${name} 👋\n\nДобро пожаловать в BUDZEN — твою игровую экономику.\nОбменивай валюты, участвуй в играх и зарабатывай BC.`
    await sendStartMessage(ctx, text)
  })

  // Ответ на прочие текстовые сообщения — подсказка про Mini App.
  bot.on('text', async (ctx) => {
    await sendStartMessage(ctx, 'Открой приложение — команда /start покажет кнопку.')
  })

  bot.catch((error) => {
    console.error('[bot] Ошибка обработки обновления:', error instanceof Error ? error.message : error)
  })

  // Устанавливает синюю кнопку-меню (слева в поле ввода чата), открывающую Mini App.
  // Telegram требует валидный HTTPS-URL для кнопки типа web_app.
  async function setupMenuButton() {
    try {
      if (MINI_APP_URL_VALID) {
        await bot.telegram.setChatMenuButton({
          menuButton: { type: 'web_app', text: 'BUDZEN', web_app: { url: MINI_APP_URL } },
        })
        console.log('[bot] Синяя кнопка-меню (Mini App) установлена.')
      } else {
        // Без валидного URL ставим безопасное меню с командами, чтобы кнопка не пропала.
        await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } })
        console.log('[bot] MINI_APP_URL не задан — кнопка-меню установлена как «команды».')
      }
    } catch (error) {
      console.error('[bot] Не удалось установить кнопку-меню:', error instanceof Error ? error.message : error)
      try {
        await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } })
      } catch {
        // Игнорируем: фолбэк тоже не удался.
      }
    }
  }

  // Запуск в режиме long polling. Ошибки не должны ронять API-сервер.
  bot.launch()
    .then(() => console.log('[bot] Telegram-бот запущен (long polling).'))
    .catch((error) => {
      console.error('[bot] Не удалось запустить бота:', error instanceof Error ? error.message : error)
      console.error('[bot] Проверьте TELEGRAM_BOT_TOKEN и доступ к api.telegram.org.')
    })

  // Ставим войс-меню/команды и кнопку-меню после старта.
  bot.telegram.setMyCommands([
    { command: 'start', description: 'Открыть BUDZEN' },
  ]).catch(() => {})
  void setupMenuButton()

  // Аккуратно останавливаем бота при завершении процесса.
  const stop = (signal) => {
    try {
      bot.stop(signal)
      console.log(`[bot] Остановлен по сигналу ${signal}.`)
    } catch {
      // Игнорируем ошибки остановки при выходе.
    }
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  return bot
}
