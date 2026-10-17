import './env.js' // ВАЖНО: первым — грузит .env.local до остальных модулей
import { createHmac } from 'node:crypto'
import express from 'express'
import { supabaseAdmin } from './supabaseAdmin.js'
import {
  getRates, getRateHistory, getRatesWithHistory, getAchievements, createTransfer,
  adjustBalance, logTransaction, setAchievementProgress, logPurchase,
  getExchangeHistory, getTransferHistory, getBonusHistory, getPurchaseHistory, getGameHistory,
  getAllHistory,
} from './db.js'
import { startBot } from './bot.js'

const PORT = Number(process.env.API_PORT ?? 3001)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

const supabase = supabaseAdmin

// Активные заезды Краш: userId -> { crashPoint, stake, startedAt }.
// Точка краша хранится на сервере и НЕ доверяется клиенту — иначе можно «подкрутить»
// проигрыш в выигрыш. Запись удаляется при кашинге/краше.
const activeCrashRounds = new Map()

const app = express()
app.use(express.json({ limit: '16kb' }))

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------
function ensureSupabase(response) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    response.status(503).json({ error: 'Supabase не настроен: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env.local.' })
    return false
  }
  return true
}

function round2(value) {
  return Number(Number(value).toFixed(2))
}

// Проверка подписи Telegram initData (защита от подмены).
// Если TELEGRAM_BOT_TOKEN не задан — режим разработки (проверка отключена).
function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: true, dev: true }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { ok: false }

  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n')

  const secretKey = createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest()
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  return { ok: computed === hash }
}

function parseTelegramUser(initData) {
  try {
    const params = new URLSearchParams(initData)
    const raw = params.get('user')
    if (!raw) return null
    const user = JSON.parse(raw)
    if (!user || typeof user.id !== 'number') return null
    return user
  } catch {
    return null
  }
}

// Достаём профиль из запроса. Поддерживаем заголовок Authorization: tma <initData>.
function getIdentity(request) {
  const header = request.get('authorization') ?? ''
  const initData = header.startsWith('tma ') ? header.slice(4) : ''
  if (initData) {
    const verified = verifyTelegramInitData(initData)
    if (!verified.ok) return { error: 'Недействительная подпись Telegram.' }
    const user = parseTelegramUser(initData)
    if (user) return { userId: String(user.id), tg: user }
  }

  // Резервный вариант: явный userId (для локальной разработки вне Telegram).
  const fallback = typeof request.body?.userId === 'string' ? request.body.userId : ''
  if (/^\d{1,24}$/.test(fallback)) return { userId: fallback, tg: null }

  return { error: 'Не удалось определить пользователя.' }
}

// Получить пользователя или создать нового с балансами по умолчанию.
async function getOrCreateUser(userId, tg) {
  const { data: existing, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  if (existing) return existing

  const insert = {
    id: Number(userId),
    username: tg?.username ?? null,
    first_name: tg?.first_name ?? null,
    last_name: tg?.last_name ?? null,
    photo_url: tg?.photo_url ?? null,
  }
  const { data: created, error: createError } = await supabase
    .from('users')
    .insert(insert)
    .select('*')
    .single()
  if (createError) throw createError

  await supabase.from('quest_progress').insert({ user_id: Number(userId) }).select('user_id').maybeSingle()
  return created
}

function publicProfile(user) {
  return {
    id: String(user.id),
    username: user.username ? `@${user.username}` : '@demo_user',
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Demo User',
    photoUrl: user.photo_url ?? '',
    balanceBc: Number(user.balance_bc),
    balanceA: Number(user.balance_a),
    balanceB: Number(user.balance_b),
    totalSent: Number(user.total_sent),
    totalDeposited: Number(user.total_deposited),
    level: Number(user.level),
    xp: Number(user.xp),
    dailyStreak: Number(user.daily_streak),
    lastBonusDate: user.last_bonus_date,
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth — вход/регистрация
// ---------------------------------------------------------------------------
app.post('/api/auth', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) {
    response.status(401).json({ error: identity.error })
    return
  }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)
    response.json({ profile: publicProfile(user) })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось выполнить вход.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/exchange — обмен BC ⇄ A ⇄ B (по реальным курсам из таблицы rates)
// ---------------------------------------------------------------------------
app.post('/api/exchange', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const from = request.body?.from
  const to = request.body?.to
  const amount = Number(request.body?.amount)

  if (!['BC', 'A', 'B'].includes(from) || !['BC', 'A', 'B'].includes(to) || from === to) {
    response.status(400).json({ error: 'Некорректная пара валют.' })
    return
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    response.status(400).json({ error: 'Сумма должна быть больше нуля.' })
    return
  }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)
    const balanceKey = { BC: 'balance_bc', A: 'balance_a', B: 'balance_b' }
    const fromKey = balanceKey[from]
    const toKey = balanceKey[to]
    const available = Number(user[fromKey])
    if (amount > available) {
      response.status(400).json({ error: `Недостаточно ${from} для обмена.` })
      return
    }

    // Курсы из базы: 1 единица валюты = rate BC. BC всегда 1.
    const rates = await getRates()
    const unit = { BC: 1, A: rates.A?.rate ?? 1, B: rates.B?.rate ?? 1 }
    const rate = unit[from] / unit[to]
    const received = Number((amount * rate).toFixed(4))
    const update = {
      [fromKey]: round2(available - amount),
      [toKey]: round2(Number(user[toKey]) + received),
    }

    const { data: updated, error } = await supabase
      .from('users')
      .update(update)
      .eq('id', identity.userId)
      .select('*')
      .single()
    if (error) throw error

    if (from === 'BC') {
      const { data: quest } = await supabase.from('quest_progress').select('*').eq('user_id', identity.userId).maybeSingle()
      await supabase.from('quest_progress').upsert({
        user_id: Number(identity.userId),
        exchange_bc: round2(Number(quest?.exchange_bc ?? 0) + amount),
      })
    }

    // История обменов + достижения.
    await logTransaction(identity.userId, 'exchange', amount, from, { from, to, received, rate }).catch(() => {})
    if (from === 'BC') await setAchievementProgress(identity.userId, 'first_exchange', 1).catch(() => {})

    response.json({ profile: publicProfile(updated), received })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось выполнить обмен.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/transfer — перевод BC другому пользователю (комиссия 2%)
// ---------------------------------------------------------------------------
const TRANSFER_FEE_RATE = 0.02

app.post('/api/transfer', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const recipientRaw = String(request.body?.recipient ?? '').trim()
  const amount = Number(request.body?.amount)

  if (!recipientRaw) { response.status(400).json({ error: 'Укажите получателя.' }); return }
  if (!Number.isFinite(amount) || amount <= 0) { response.status(400).json({ error: 'Сумма должна быть больше нуля.' }); return }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)

    // Ищем получателя по ID или username.
    let recipient = null
    if (/^\d{1,24}$/.test(recipientRaw)) {
      const { data } = await supabase.from('users').select('*').eq('id', recipientRaw).maybeSingle()
      recipient = data
    } else {
      const username = recipientRaw.replace(/^@/, '')
      const { data } = await supabase.from('users').select('*').eq('username', username).maybeSingle()
      recipient = data
    }

    if (!recipient) { response.status(404).json({ error: 'Получатель не найден.' }); return }
    if (String(recipient.id) === String(user.id)) { response.status(400).json({ error: 'Нельзя перевести самому себе.' }); return }

    const fee = round2(amount * TRANSFER_FEE_RATE)
    const total = round2(amount + fee)
    if (total > Number(user.balance_bc)) {
      response.status(400).json({ error: `Недостаточно BC. Нужно ${total} BC с учётом комиссии.` })
      return
    }

    // Выполняем перевод через db.js: списание, зачисление и запись истории.
    await createTransfer(user.id, recipient.id, amount)

    // Обновляем счётчик «Отправлено» у отправителя.
    const { data: updated, error } = await supabase
      .from('users')
      .update({ total_sent: round2(Number(user.total_sent) + total) })
      .eq('id', user.id)
      .select('*')
      .single()
    if (error) throw error

    response.json({ profile: publicProfile(updated), received: amount, fee })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось выполнить перевод.' })
  }
})

// ---------------------------------------------------------------------------
// GET /api/withdrawals?userId=
// ---------------------------------------------------------------------------
app.get('/api/withdrawals', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный ID пользователя.' }); return }

  try {
    const { data, error } = await supabase
      .from('withdrawals')
      .select('code, amount, currency, status, created_at')
      .eq('user_id', userId)
      .order('id', { ascending: false })
      .limit(50)
    if (error) throw error

    response.json({
      withdrawals: (data ?? []).map((row) => ({
        code: row.code,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        createdAt: row.created_at,
      })),
    })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось загрузить историю заявок.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/withdrawals — создать заявку
// ---------------------------------------------------------------------------
function generateCode() {
  const hex = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0').toUpperCase()
  return `WD-${hex()}-${hex()}`
}

app.post('/api/withdrawals', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const amount = Number(request.body?.amount)
  const currency = request.body?.currency ?? 'BC'
  if (!Number.isFinite(amount) || amount <= 0) { response.status(400).json({ error: 'Сумма должна быть больше нуля.' }); return }
  if (currency !== 'BC') { response.status(400).json({ error: 'Доступен вывод только в BC.' }); return }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)
    if (amount > Number(user.balance_bc)) { response.status(400).json({ error: 'Сумма больше доступного баланса.' }); return }

    const code = generateCode()
    const { data: withdrawal, error } = await supabase
      .from('withdrawals')
      .insert({ code, user_id: user.id, amount: round2(amount), currency, status: 'pending' })
      .select('code, amount, currency, status, created_at')
      .single()
    if (error) throw error

    const { data: updated } = await supabase
      .from('users')
      .update({
        balance_bc: round2(Number(user.balance_bc) - amount),
        total_sent: round2(Number(user.total_sent) + amount),
      })
      .eq('id', user.id)
      .select('*')
      .single()

    // История операций: вывод.
    await logTransaction(identity.userId, 'withdrawal', amount, 'BC', { code, status: 'pending' }).catch(() => {})

    response.status(201).json({
      withdrawal: {
        code: withdrawal.code,
        amount: Number(withdrawal.amount),
        currency: withdrawal.currency,
        status: withdrawal.status,
        createdAt: withdrawal.created_at,
      },
      profile: updated ? publicProfile(updated) : undefined,
    })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось создать заявку.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/bonus/daily — ежедневный бонус
// ---------------------------------------------------------------------------
app.post('/api/bonus/daily', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)
    const today = new Date().toISOString().slice(0, 10)
    if (user.last_bonus_date === today) { response.status(400).json({ error: 'Бонус за сегодня уже получен.' }); return }

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const streak = user.last_bonus_date === yesterday ? Number(user.daily_streak) + 1 : 1
    const reward = streak % 7 === 0 ? 50 : 10

    const { data: updated, error } = await supabase
      .from('users')
      .update({
        balance_bc: round2(Number(user.balance_bc) + reward),
        daily_streak: streak,
        last_bonus_date: today,
      })
      .eq('id', user.id)
      .select('*')
      .single()
    if (error) throw error

    await supabase.from('daily_bonus_claims').insert({ user_id: user.id, amount: reward, streak_day: streak, claim_date: today })

    // История операций + достижения.
    await logTransaction(identity.userId, 'bonus', reward, 'BC', { streak }).catch(() => {})
    await setAchievementProgress(identity.userId, 'first_bonus', 1).catch(() => {})
    await setAchievementProgress(identity.userId, 'week_streak', streak).catch(() => {})

    response.json({ profile: publicProfile(updated), reward })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось получить бонус.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/purchase — демо-покупка BC за звёзды (100 ⭐ = 1000 BC)
// ---------------------------------------------------------------------------
app.post('/api/purchase', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const stars = Number(request.body?.stars)
  if (!Number.isInteger(stars) || stars <= 0) { response.status(400).json({ error: 'Укажите целое число звёзд больше нуля.' }); return }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)
    const amount = stars * 10
    const { data: updated, error } = await supabase
      .from('users')
      .update({
        balance_bc: round2(Number(user.balance_bc) + amount),
        total_deposited: round2(Number(user.total_deposited) + amount),
      })
      .eq('id', user.id)
      .select('*')
      .single()
    if (error) throw error

    // История покупок: payments + transactions.
    await logPurchase(identity.userId, stars, amount, 'paid').catch(() => {})

    response.json({ profile: publicProfile(updated), amount })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось выполнить покупку.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/games/upgrade — Апгрейдер (ставка, шанс, выплата)
// ---------------------------------------------------------------------------
app.post('/api/games/upgrade', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const stake = Number(request.body?.stake)
  const chance = Number(request.body?.chance)

  if (!Number.isFinite(stake) || stake <= 0) { response.status(400).json({ error: 'Введите ставку больше нуля.' }); return }
  if (!Number.isFinite(chance) || chance < 1 || chance > 80) { response.status(400).json({ error: 'Введите шанс от 1 до 80%.' }); return }

  try {
    await getOrCreateUser(identity.userId, identity.tg)
    // Списываем ставку сразу.
    await adjustBalance(identity.userId, 'balance_bc', -stake)

    const won = Math.random() * 100 < chance
    const payout = won ? round2(stake * 100 / chance) : 0

    if (won) await adjustBalance(identity.userId, 'balance_bc', payout)
    // История игрового раунда (хранится с meta.game, чтобы вынести в отдельную таблицу позже).
    await logTransaction(identity.userId, 'purchase', payout, 'BC', { game: 'upgrade', stake, chance, won, payout }).catch(() => {})
    if (won) await setAchievementProgress(identity.userId, 'first_upgrade', 1)

    const { getUserById } = await import('./db.js')
    const updated = await getUserById(identity.userId)
    response.json({ profile: publicProfile(updated), won, payout, stake })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось выполнить раунд.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/games/crash/start — Краш: начать заезд (списать ставку)
// ---------------------------------------------------------------------------
app.post('/api/games/crash/start', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const stake = Number(request.body?.stake)
  if (!Number.isFinite(stake) || stake <= 0) { response.status(400).json({ error: 'Введите ставку больше нуля.' }); return }

  try {
    await getOrCreateUser(identity.userId, identity.tg)
    await adjustBalance(identity.userId, 'balance_bc', -stake)

    // Точка краша: краш растёт экспоненциально.
    const roll = Math.random()
    const crashPoint = roll < 0.65
      ? Number((1 + Math.random() * 0.5).toFixed(2))
      : Number((1.5 * Math.pow(120 / 1.5, Math.random())).toFixed(2))

    // Запоминаем заезд на сервере — при кашинге будем сравнивать с ЭТОЙ точкой.
    activeCrashRounds.set(identity.userId, { crashPoint, stake, startedAt: Date.now() })

    const { getUserById } = await import('./db.js')
    const updated = await getUserById(identity.userId)
    response.json({ profile: publicProfile(updated), crashPoint })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось начать заезд.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/games/crash/cashout — Краш: забрать выигрыш
// ---------------------------------------------------------------------------
app.post('/api/games/crash/cashout', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const multiplier = Number(request.body?.multiplier)

  if (!Number.isFinite(multiplier) || multiplier < 1) { response.status(400).json({ error: 'Некорректный множитель.' }); return }

  try {
    await getOrCreateUser(identity.userId, identity.tg)

    // Берём активный заезд с сервера. Точка краша НЕ берётся из тела запроса —
    // иначе клиент мог бы прислать выгодную ему точку.
    const round = activeCrashRounds.get(identity.userId)
    if (!round) {
      response.status(400).json({ error: 'Нет активного заезда. Начните новый.' })
      return
    }

    const { stake, crashPoint } = round

    // Защита: забрать можно только если множитель меньше точки краша.
    // Небольшая погрешность (0.9999) не нужна: клиент шлёт ровно видимое значение,
    // и оно гарантированно ниже краша, если игрок успел.
    if (multiplier >= crashPoint) {
      activeCrashRounds.delete(identity.userId)
      await logTransaction(identity.userId, 'purchase', 0, 'BC', { game: 'crash', stake, multiplier: crashPoint, crashPoint, cashed: false, payout: 0 }).catch(() => {})
      const { getUserById } = await import('./db.js')
      const current = await getUserById(identity.userId)
      response.json({ profile: publicProfile(current), payout: 0, crashed: true })
      return
    }

    activeCrashRounds.delete(identity.userId)
    const payout = round2(stake * multiplier)
    await adjustBalance(identity.userId, 'balance_bc', payout)
    await logTransaction(identity.userId, 'purchase', payout, 'BC', { game: 'crash', stake, multiplier, crashPoint, cashed: true, payout }).catch(() => {})

    const { getUserById } = await import('./db.js')
    const updated = await getUserById(identity.userId)
    response.json({ profile: publicProfile(updated), payout, crashed: false })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось забрать выигрыш.' })
  }
})

// ---------------------------------------------------------------------------
// GET /api/history/exchanges?userId= — история обменов
// ---------------------------------------------------------------------------
app.get('/api/history/exchanges', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getExchangeHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю обменов.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/history/transfers?userId= — история переводов
// ---------------------------------------------------------------------------
app.get('/api/history/transfers', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getTransferHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю переводов.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/history/bonuses?userId= — история бонусов
// ---------------------------------------------------------------------------
app.get('/api/history/bonuses', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getBonusHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю бонусов.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/history/purchases?userId= — история покупок
// ---------------------------------------------------------------------------
app.get('/api/history/purchases', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getPurchaseHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю покупок.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/history/games?userId=&game=upgrade|crash — история игр
// ---------------------------------------------------------------------------
app.get('/api/history/games', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  const game = request.query.game === 'crash' ? 'crash' : 'upgrade'
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getGameHistory(userId, game) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю игр.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/history/all?userId= — единая лента всей истории операций
// ---------------------------------------------------------------------------
app.get('/api/history/all', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getAllHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/rates — текущие курсы + история за 7 дней (из базы)
// ---------------------------------------------------------------------------
app.get('/api/rates', async (_request, response) => {
  if (!ensureSupabase(response)) return
  try {
    // Читаем курсы и историю графика из rate_history (см. getRatesWithHistory).
    const { rates, history } = await getRatesWithHistory(7)
    response.json({ rates, history })
  } catch (error) {
    console.error(error)
    // Фолбэк: если rate_history пустая/битая — отдаём хотя бы текущие курсы.
    try {
      const rates = await getRates()
      const history = {
        A: await getRateHistory('A', 7),
        B: await getRateHistory('B', 7),
      }
      response.json({ rates, history })
    } catch (fallbackError) {
      console.error(fallbackError)
      response.status(500).json({ error: 'Не удалось загрузить курсы.' })
    }
  }
})

// ---------------------------------------------------------------------------
// GET /api/achievements?userId= — список достижений + прогресс игрока
// ---------------------------------------------------------------------------
app.get('/api/achievements', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  try {
    const achievements = await getAchievements(/^\d{1,24}$/.test(userId) ? userId : null)
    response.json({ achievements })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось загрузить достижения.' })
  }
})

// ---------------------------------------------------------------------------
app.listen(PORT, '127.0.0.1', () => {
  console.log(`BUDZEN API listening on http://127.0.0.1:${PORT}`)
  // Запускаем Telegram-бота вместе с API. Ошибки бота не роняют сервер.
  startBot()
})
