  
    // Express-приложение BUDZEN как модуль.
// Используется и локальным сервером (server/index.js), и Vercel-функцией (api/index.js).
import { createHmac } from 'node:crypto'
import express from 'express'
import { supabaseAdmin } from './supabaseAdmin.js'
import {
  getRates, getRateHistory, getRatesWithHistory, getAchievements, createTransfer,
  adjustBalance, logTransaction, setAchievementProgress, logPurchase,
  getExchangeHistory, getTransferHistory, getBonusHistory, getPurchaseHistory, getGameHistory,
  getAllHistory,
  adminGiveBalanceByUsername, adminBanUserByUsername, adminUnbanUserByUsername,
  adminListPendingWithdrawals, adminSetWithdrawalStatus,
  creditStarsPurchase,
} from './db.js'
import { createBot, buildInvoiceByStars, starsForBc, BC_PER_STAR, MIN_STARS, MAX_STARS } from './bot.js'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

// Telegram ID администратора — единственный, кому доступна админ-панель.
const ADMIN_TELEGRAM_ID = '1685473570'

const supabase = supabaseAdmin

// Активные заезды Краш: userId -> { crashPoint, stake, startedAt }.
// ВАЖНО: в serverless (Vercel) этот Map не сохраняется между вызовами.
// Для полноценной игры «Краш» в проде нужен внешний store (например, Redis/Supabase).
const activeCrashRounds = new Map()

export const app = express()
app.use(express.json({ limit: '16kb' }))

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------
function ensureSupabase(response) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    response.status(503).json({ error: 'Supabase не настроен: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY.' })
    return false
  }
  return true
}

function round2(value) {
  return Number(Number(value).toFixed(2))
}

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

function getIdentity(request) {
  const header = request.get('authorization') ?? ''
  const initData = header.startsWith('tma ') ? header.slice(4) : ''
  if (initData) {
    const verified = verifyTelegramInitData(initData)
    if (!verified.ok) return { error: 'Недействительная подпись Telegram.' }
    const user = parseTelegramUser(initData)
    if (user) return { userId: String(user.id), tg: user }
  }

  const fallback = typeof request.body?.userId === 'string' ? request.body.userId : ''
  if (/^\d{1,24}$/.test(fallback)) return { userId: fallback, tg: null }

  return { error: 'Не удалось определить пользователя.' }
}

async function getOrCreateUser(userId, tg) {
  const { data: existing, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  if (existing) {
    // Обновляем username/имя/фото из Telegram, если они изменились (например, юзер сменил @тег).
    if (tg && (tg.username ?? null) !== existing.username) {
      const { data: refreshed } = await supabase
        .from('users')
        .update({
          username: tg.username ?? null,
          first_name: tg.first_name ?? existing.first_name,
          last_name: tg.last_name ?? existing.last_name,
          photo_url: tg.photo_url ?? existing.photo_url,
        })
        .eq('id', userId)
        .select('*')
        .single()
      if (refreshed) return refreshed
    }
    return existing
  }

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

// Если пользователь забанен — сразу отвечаем 403 и возвращаем true (действие отменено).
function blockedIfBanned(user, response) {
  if (user && user.is_banned === true) {
    response.status(403).json({ error: `Вы забанены.${user.ban_reason ? ` Причина: ${user.ban_reason}` : ''}` })
    return true
  }
  return false
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
    isBanned: user.is_banned === true,
    banReason: user.ban_reason ?? null,
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth
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
// POST /api/exchange
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
    // Параллельно: получаем/создаём пользователя и читаем курсы.
    const [user, rates] = await Promise.all([
      getOrCreateUser(identity.userId, identity.tg),
      getRates(),
    ])
    if (blockedIfBanned(user, response)) return
    const balanceKey = { BC: 'balance_bc', A: 'balance_a', B: 'balance_b' }
    const fromKey = balanceKey[from]
    const toKey = balanceKey[to]
    const available = Number(user[fromKey])
    if (amount > available) {
      response.status(400).json({ error: `Недостаточно ${from} для обмена.` })
      return
    }

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

    // Побочные эффекты выполняем ПАРАЛЛЕЛЬНО (а не по цепочке) и ждём их —
    // так ответ уходит быстрее, но данные гарантированно сохраняются в serverless.
    await Promise.all([
      from === 'BC'
        ? (async () => {
            try {
              const { data: quest } = await supabase.from('quest_progress').select('*').eq('user_id', identity.userId).maybeSingle()
              await supabase.from('quest_progress').upsert({
                user_id: Number(identity.userId),
                exchange_bc: round2(Number(quest?.exchange_bc ?? 0) + amount),
              })
            } catch { /* игнорируем */ }
          })()
        : Promise.resolve(),
      logTransaction(identity.userId, 'exchange', amount, from, { from, to, received, rate }).catch(() => {}),
      from === 'BC' ? setAchievementProgress(identity.userId, 'first_exchange', 1).catch(() => {}) : Promise.resolve(),
    ])

    response.json({ profile: publicProfile(updated), received })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось выполнить обмен.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/transfer
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
    if (blockedIfBanned(user, response)) return

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

    await createTransfer(user.id, recipient.id, amount)

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
// GET /api/withdrawals
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
// POST /api/withdrawals
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
    if (blockedIfBanned(user, response)) return
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
// POST /api/bonus/daily
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

    // Записи-побочки независимы — выполняем их ПАРАЛЛЕЛЬНО, чтобы не ждать
    // по цепочке (~250 мс на каждый запрос к удалённой Supabase).
    await Promise.all([
      supabase.from('daily_bonus_claims').insert({ user_id: user.id, amount: reward, streak_day: streak, claim_date: today }),
      logTransaction(identity.userId, 'bonus', reward, 'BC', { streak }).catch(() => {}),
      setAchievementProgress(identity.userId, 'first_bonus', 1).catch(() => {}),
      setAchievementProgress(identity.userId, 'week_streak', streak).catch(() => {}),
    ])

    response.json({ profile: publicProfile(updated), reward })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось получить бонус.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/purchase
// ---------------------------------------------------------------------------
app.post('/api/purchase', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const stars = Number(request.body?.stars)
  if (!Number.isInteger(stars) || stars <= 0) { response.status(400).json({ error: 'Укажите целое число звёзд больше нуля.' }); return }

  try {
    const user = await getOrCreateUser(identity.userId, identity.tg)
    if (blockedIfBanned(user, response)) return
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

    await logPurchase(identity.userId, stars, amount, 'paid').catch(() => {})

    response.json({ profile: publicProfile(updated), amount })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось выполнить покупку.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/games/upgrade
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
    const gameUser = await getOrCreateUser(identity.userId, identity.tg)
    if (blockedIfBanned(gameUser, response)) return
    await adjustBalance(identity.userId, 'balance_bc', -stake)

    const won = Math.random() * 100 < chance
    const payout = won ? round2(stake * 100 / chance) : 0

    if (won) await adjustBalance(identity.userId, 'balance_bc', payout)
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
// POST /api/games/crash/start
// ---------------------------------------------------------------------------
app.post('/api/games/crash/start', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const stake = Number(request.body?.stake)
  if (!Number.isFinite(stake) || stake <= 0) { response.status(400).json({ error: 'Введите ставку больше нуля.' }); return }

  try {
    const crashUser = await getOrCreateUser(identity.userId, identity.tg)
    if (blockedIfBanned(crashUser, response)) return
    await adjustBalance(identity.userId, 'balance_bc', -stake)

    const roll = Math.random()
    const crashPoint = roll < 0.65
      ? Number((1 + Math.random() * 0.5).toFixed(2))
      : Number((1.5 * Math.pow(120 / 1.5, Math.random())).toFixed(2))

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
// POST /api/games/crash/cashout
// ---------------------------------------------------------------------------
app.post('/api/games/crash/cashout', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const multiplier = Number(request.body?.multiplier)

  if (!Number.isFinite(multiplier) || multiplier < 1) { response.status(400).json({ error: 'Некорректный множитель.' }); return }

  try {
    const cashoutUser = await getOrCreateUser(identity.userId, identity.tg)
    if (blockedIfBanned(cashoutUser, response)) return

    const round = activeCrashRounds.get(identity.userId)
    if (!round) {
      response.status(400).json({ error: 'Нет активного заезда. Начните новый.' })
      return
    }

    const { stake, crashPoint } = round

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
// GET /api/history/*
// ---------------------------------------------------------------------------
app.get('/api/history/exchanges', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getExchangeHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю обменов.' }) }
})

app.get('/api/history/transfers', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getTransferHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю переводов.' }) }
})

app.get('/api/history/bonuses', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getBonusHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю бонусов.' }) }
})

app.get('/api/history/purchases', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getPurchaseHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю покупок.' }) }
})

app.get('/api/history/games', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  const game = request.query.game === 'crash' ? 'crash' : 'upgrade'
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getGameHistory(userId, game) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю игр.' }) }
})

app.get('/api/history/all', async (request, response) => {
  if (!ensureSupabase(response)) return
  const userId = typeof request.query.userId === 'string' ? request.query.userId : ''
  if (!/^\d{1,24}$/.test(userId)) { response.status(400).json({ error: 'Некорректный userId.' }); return }
  try {
    response.json({ items: await getAllHistory(userId) })
  } catch (error) { console.error(error); response.status(500).json({ error: 'Не удалось загрузить историю.' }) }
})

// ---------------------------------------------------------------------------
// GET /api/rates
// ---------------------------------------------------------------------------
app.get('/api/rates', async (_request, response) => {
  if (!ensureSupabase(response)) return
  try {
    const { rates, history } = await getRatesWithHistory(7)
    response.json({ rates, history })
  } catch (error) {
    console.error(error)
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
// GET /api/achievements
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
// Админ-панель. Доступ только для ADMIN_TELEGRAM_ID. Проверка — на сервере,
// по подписанному initData (или dev-fallback userId), НЕ по данным из клиента.
// ---------------------------------------------------------------------------
function requireAdmin(request, response) {
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return null }
  if (identity.userId !== ADMIN_TELEGRAM_ID) {
    response.status(403).json({ error: 'Доступ запрещён.' })
    return null
  }
  return identity
}

// POST /api/admin/give-balance — начислить/списать баланс игроку (по username).
app.post('/api/admin/give-balance', async (request, response) => {
  if (!ensureSupabase(response)) return
  if (!requireAdmin(request, response)) return

  const username = String(request.body?.username ?? '').trim().replace(/^@/, '')
  const currency = request.body?.currency
  const amount = Number(request.body?.amount)

  if (!username) { response.status(400).json({ error: 'Укажите username игрока.' }); return }
  if (!['BC', 'A', 'B'].includes(currency)) { response.status(400).json({ error: 'Некорректная валюта.' }); return }
  if (!Number.isFinite(amount) || amount === 0) { response.status(400).json({ error: 'Сумма должна быть ненулевой.' }); return }

  try {
    const updated = await adminGiveBalanceByUsername(username, currency, amount)
    response.json({ profile: publicProfile(updated) })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось начислить баланс.' })
  }
})

// POST /api/admin/ban — забанить игрока (по username).
app.post('/api/admin/ban', async (request, response) => {
  if (!ensureSupabase(response)) return
  if (!requireAdmin(request, response)) return

  const username = String(request.body?.username ?? '').trim().replace(/^@/, '')
  const reason = String(request.body?.reason ?? '').trim()
  if (!username) { response.status(400).json({ error: 'Укажите username игрока.' }); return }

  try {
    const updated = await adminBanUserByUsername(username, reason)
    response.json({ profile: publicProfile(updated) })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось забанить игрока.' })
  }
})

// POST /api/admin/unban — разбанить игрока (по username).
app.post('/api/admin/unban', async (request, response) => {
  if (!ensureSupabase(response)) return
  if (!requireAdmin(request, response)) return

  const username = String(request.body?.username ?? '').trim().replace(/^@/, '')
  if (!username) { response.status(400).json({ error: 'Укажите username игрока.' }); return }

  try {
    const updated = await adminUnbanUserByUsername(username)
    response.json({ profile: publicProfile(updated) })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось разбанить игрока.' })
  }
})

// GET /api/admin/withdrawals — список заявок на вывод со статусом pending.
app.get('/api/admin/withdrawals', async (request, response) => {
  if (!ensureSupabase(response)) return
  if (!requireAdmin(request, response)) return
  try {
    const withdrawals = await adminListPendingWithdrawals()
    response.json({ withdrawals })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Не удалось загрузить заявки.' })
  }
})

// POST /api/admin/withdrawals — одобрить/отклонить заявку.
app.post('/api/admin/withdrawals', async (request, response) => {
  if (!ensureSupabase(response)) return
  if (!requireAdmin(request, response)) return

  const code = String(request.body?.code ?? '').trim()
  const status = request.body?.status
  if (!code) { response.status(400).json({ error: 'Укажите код заявки.' }); return }
  if (!['approved', 'rejected', 'paid'].includes(status)) { response.status(400).json({ error: 'Некорректный статус.' }); return }

  try {
    const withdrawal = await adminSetWithdrawalStatus(code, status)
    response.json({ withdrawal })
  } catch (error) {
    console.error(error)
    response.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось обновить заявку.' })
  }
})

// ---------------------------------------------------------------------------
// Telegram Stars: пополнение BC.
// ---------------------------------------------------------------------------

// Ленивый singleton бота (для createInvoiceLink и обработки updates на Vercel).
let _bot = null
function getBot() {
  if (_bot) return _bot
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  _bot = createBot(token)
  return _bot
}

// POST /api/buy — создать invoice-ссылку на пополнение BC за Stars.
// Принимает amountBc (сумму BC). Звёзды считаются по курсу 1 Star = 10 BC.
app.post('/api/buy', async (request, response) => {
  if (!ensureSupabase(response)) return
  const identity = getIdentity(request)
  if (identity.error) { response.status(401).json({ error: identity.error }); return }

  const amountBc = Number(request.body?.amountBc)
  if (!Number.isFinite(amountBc) || amountBc <= 0) {
    response.status(400).json({ error: 'Укажите сумму BC больше нуля.' })
    return
  }
  const stars = starsForBc(amountBc)
  if (stars < MIN_STARS || stars > MAX_STARS) {
    response.status(400).json({ error: `Слишком большая сумма. Максимум ${MAX_STARS * BC_PER_STAR} BC.` })
    return
  }

  const bot = getBot()
  if (!bot) { response.status(503).json({ error: 'Оплата Stars недоступна: не задан TELEGRAM_BOT_TOKEN.' }); return }

  const invoice = buildInvoiceByStars(stars)
  if (!invoice) { response.status(400).json({ error: 'Не удалось собрать счёт.' }); return }

  try {
    const link = await bot.telegram.createInvoiceLink(invoice)
    response.json({ invoiceLink: link, stars, bc: stars * BC_PER_STAR })
  } catch (error) {
    console.error(error)
    response.status(502).json({ error: error instanceof Error ? error.message : 'Не удалось создать счёт.' })
  }
})

// POST /api/telegram/webhook — принимает updates от Telegram (команды и платежи).
// Нужен, чтобы на Vercel работали /buy, pre_checkout_query и successful_payment.
app.post('/api/telegram/webhook', async (request, response) => {
  // Необязательная защита: секретный заголовок Telegram (если задан TELEGRAM_WEBHOOK_SECRET).
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secret && request.get('x-telegram-bot-api-secret-token') !== secret) {
    response.status(401).json({ error: 'Недействительный секрет вебхука.' })
    return
  }
  const bot = getBot()
  if (!bot) { response.status(503).json({ error: 'Бот не настроен.' }); return }
  try {
    // Не ждём обработку: подтверждаем Telegram сразу, чтобы не было ретраев.
    void bot.handleUpdate(request.body).catch((error) => {
      console.error('[webhook] Ошибка обработки update:', error instanceof Error ? error.message : error)
    })
    response.json({ ok: true })
  } catch (error) {
    console.error(error)
    response.status(500).json({ error: 'Ошибка обработки вебхука.' })
  }
})

// ---------------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------------
app.get('/api/health', (_request, response) => {
  response.json({ ok: true, supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) })
})

export default app
