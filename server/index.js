import './env.js' // ВАЖНО: первым — грузит .env.local до остальных модулей
import { app } from './app.js'
import { startBot } from './bot.js'

const PORT = Number(process.env.API_PORT ?? 3001)

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BUDZEN API listening on http://127.0.0.1:${PORT}`)
  // Запускаем Telegram-бота вместе с API. Ошибки бота не роняют сервер.
  startBot()
})
