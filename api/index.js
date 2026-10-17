// Vercel Serverless-функция: отдаёт Express-приложение BUDZEN.
// Vercel автоматически роутит запросы /api/* на этот файл (см. vercel.json).
import { app } from '../server/app.js'

export default app
