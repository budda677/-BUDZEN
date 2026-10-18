// Функции работы с базой данных BUDZEN (серверный слой).
// Все запросы идут через supabaseAdmin (service_role).
import { supabaseAdmin } from './supabaseAdmin.js'

function round2(value) {
  return Number(Number(value).toFixed(2))
}

// Получить пользователя по id. Возвращает объект или null.
export async function getUserById(id) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

// Создать или обновить пользователя (по id). Возвращает запись.
export async function upsertUser(user) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .upsert(user, { onConflict: 'id' })
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Обновить одно поле баланса пользователя и вернуть обновлённую запись.
// field: 'balance_bc' | 'balance_a' | 'balance_b' | 'total_sent' | 'total_deposited'
export async function updateBalance(id, field, value) {
  const allowed = ['balance_bc', 'balance_a', 'balance_b', 'total_sent', 'total_deposited']
  if (!allowed.includes(field)) throw new Error(`Недопустимое поле баланса: ${field}`)

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ [field]: round2(value), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Получить текущие курсы (таблица rates). Возвращает объект { A: number, B: number }.
export async function getRates() {
  const { data, error } = await supabaseAdmin
    .from('rates')
    .select('ticker, name, rate')
  if (error) throw error

  const rates = {}
  for (const row of data ?? []) {
    rates[row.ticker] = { name: row.name, rate: Number(row.rate) }
  }
  return rates
}

// Обновить/вставить курс на сегодня в rate_history (актуальная точка графика).
export async function upsertRateHistory(ticker, rate, day) {
  const { error } = await supabaseAdmin
    .from('rate_history')
    .upsert(
      { ticker, rate: Number(rate), day },
      { onConflict: 'ticker,day' },
    )
  if (error) throw error
}

// Получить историю курсов за последние N дней для каждого тикера.
// Берём САМЫЕ СВЕЖИЕ дни (order по убыванию + limit), затем разворачиваем по возрастанию.
// Возвращает { A: [{ day, rate }], B: [...] }.
export async function getRateHistory(ticker, days = 7) {
  const { data, error } = await supabaseAdmin
    .from('rate_history')
    .select('ticker, rate, day')
    .eq('ticker', ticker)
    .order('day', { ascending: false })
    .limit(days)
  if (error) throw error
  return (data ?? [])
    .map((row) => ({ day: row.day, rate: Number(row.rate) }))
    .reverse()
}

// Текущие курсы + история за N дней — читаем ОБЕ части из rate_history.
// Курс = последняя точка истории; если истории нет — фолбэк на таблицу rates.
export async function getRatesWithHistory(days = 7) {
  // История по обоим тикерам из rate_history.
  const { data, error } = await supabaseAdmin
    .from('rate_history')
    .select('ticker, rate, day')
    .order('day', { ascending: true })
  if (error) throw error

  const rows = data ?? []
  const history = { A: [], B: [] }
  for (const row of rows) {
    if (history[row.ticker]) history[row.ticker].push({ day: row.day, rate: Number(row.rate) })
  }
  // Оставляем последние N дней для каждого тикера.
  for (const ticker of Object.keys(history)) {
    history[ticker] = history[ticker].slice(-days)
  }

  // Названия валют берём из rates (если есть).
  const rates = await getRates()

  // Текущий курс = последняя точка истории, иначе — из rates.
  const result = {}
  for (const ticker of ['A', 'B']) {
    const points = history[ticker] ?? []
    const lastFromHistory = points.length > 0 ? points[points.length - 1].rate : null
    result[ticker] = {
      name: rates[ticker]?.name ?? ticker,
      rate: lastFromHistory ?? rates[ticker]?.rate ?? 1,
    }
  }

  return { rates: result, history }
}

// Получить список достижений + прогресс конкретного пользователя.
export async function getAchievements(userId) {
  // Два независимых запроса к Supabase — выполняем параллельно, а не по цепочке.
  const [listResult, progressResult] = await Promise.all([
    supabaseAdmin
      .from('achievements')
      .select('code, title, description, target, reward_bc, sort_order')
      .order('sort_order', { ascending: true }),
    userId
      ? supabaseAdmin
          .from('user_achievements')
          .select('achievement, progress, unlocked')
          .eq('user_id', userId)
      : Promise.resolve({ data: [] }),
  ])
  if (listResult.error) throw listResult.error
  const list = listResult.data

  const progressMap = {}
  for (const row of progressResult.data ?? []) {
    progressMap[row.achievement] = { progress: Number(row.progress), unlocked: row.unlocked }
  }

  return (list ?? []).map((row) => ({
    code: row.code,
    title: row.title,
    description: row.description,
    target: Number(row.target),
    rewardBc: Number(row.reward_bc),
    progress: progressMap[row.code]?.progress ?? 0,
    unlocked: progressMap[row.code]?.unlocked ?? false,
  }))
}

// Создать заявку на вывод валюты A или B. Возвращает созданную запись.
// Вывод BC запрещён. Списывает нужную валюту с баланса пользователя.
export async function createWithdrawal(userId, amount, currency) {
  const cur = String(currency ?? '').toUpperCase()
  if (cur !== 'A' && cur !== 'B') throw new Error('Вывод доступен только в валютах A и B.')
  const field = cur === 'A' ? 'balance_a' : 'balance_b'

  const user = await getUserById(userId)
  if (!user) throw new Error('Пользователь не найден.')
  if (Number(amount) > Number(user[field])) throw new Error(`Недостаточно ${cur} для вывода.`)

  const code = generateWithdrawalCode()
  const { data, error } = await supabaseAdmin
    .from('withdrawals')
    .insert({
      code,
      user_id: userId,
      amount: round2(amount),
      currency: cur,
      status: 'pending',
    })
    .select('*')
    .single()
  if (error) throw error

  // Списываем валюту с баланса.
  await adjustBalance(userId, field, -Number(amount))
  return data
}

// Создать перевод BC от одного пользователя другому (комиссия 2%).
// Списывает у отправителя total, зачисляет получателю amount.
export async function createTransfer(fromId, toId, amount) {
  const TRANSFER_FEE_RATE = 0.02
  const fee = round2(amount * TRANSFER_FEE_RATE)
  const total = round2(amount + fee)

  const sender = await getUserById(fromId)
  if (!sender) throw new Error('Отправитель не найден.')
  if (total > Number(sender.balance_bc)) throw new Error('Недостаточно BC с учётом комиссии.')

  const recipient = await getUserById(toId)
  if (!recipient) throw new Error('Получатель не найден.')

  // Списываем у отправителя
  await updateBalance(fromId, 'balance_bc', Number(sender.balance_bc) - total)
  // Зачисляем получателю
  await updateBalance(toId, 'balance_bc', Number(recipient.balance_bc) + amount)

  // Запись в историю переводов
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .insert({
      from_user_id: fromId,
      to_user_id: toId,
      amount: round2(amount),
      fee,
      total,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Записать операцию в историю (таблица transactions).
export async function logTransaction(userId, type, amount, currency = 'BC', meta = null) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .insert({ user_id: userId, type, amount: round2(amount), currency, meta })
  if (error) throw error
}

// Изменить баланс пользователя на дельту (может быть отрицательной).
// Возвращает обновлённую запись. Проверяет, что баланс не уйдёт ниже нуля.
export async function adjustBalance(id, field, delta) {
  const allowed = ['balance_bc', 'balance_a', 'balance_b']
  if (!allowed.includes(field)) throw new Error(`Недопустимое поле баланса: ${field}`)

  const user = await getUserById(id)
  if (!user) throw new Error('Пользователь не найден.')

  const next = round2(Number(user[field]) + delta)
  if (next < 0) throw new Error('Недостаточно средств.')

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ [field]: next, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Записать/обновить прогресс достижения игрока.
export async function setAchievementProgress(userId, achievement, progress) {
  const { data: existing } = await supabaseAdmin
    .from('user_achievements')
    .select('progress, unlocked')
    .eq('user_id', userId)
    .eq('achievement', achievement)
    .maybeSingle()

  const bestProgress = Math.max(Number(existing?.progress ?? 0), Number(progress))
  const { data: ach } = await supabaseAdmin
    .from('achievements')
    .select('target')
    .eq('code', achievement)
    .maybeSingle()
  const unlocked = ach ? bestProgress >= Number(ach.target) : (existing?.unlocked ?? false)

  const { error } = await supabaseAdmin
    .from('user_achievements')
    .upsert({
      user_id: userId,
      achievement,
      progress: bestProgress,
      unlocked,
      unlocked_at: unlocked ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,achievement' })
  if (error) throw error
}

// ---------------------------------------------------------------------------
// История операций по разделам
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 20

// Обмен: из transactions (type = 'exchange').
export async function getExchangeHistory(userId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, currency, meta, created_at')
    .eq('user_id', userId)
    .eq('type', 'exchange')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((row) => ({
    from: row.meta?.from ?? 'BC',
    to: row.meta?.to ?? 'BC',
    amount: Number(row.amount),
    received: Number(row.meta?.received ?? 0),
    rate: Number(row.meta?.rate ?? 0),
    createdAt: row.created_at,
  }))
}

// Переводы: из transfers (отправленные и полученные).
export async function getTransferHistory(userId, limit = HISTORY_LIMIT) {
  const { data: sent, error: sentError } = await supabaseAdmin
    .from('transfers')
    .select('amount, fee, total, to_user_id, created_at')
    .eq('from_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (sentError) throw sentError

  const { data: received, error: receivedError } = await supabaseAdmin
    .from('transfers')
    .select('amount, from_user_id, created_at')
    .eq('to_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (receivedError) throw receivedError

  const rows = [
    ...(sent ?? []).map((row) => ({
      direction: 'out',
      amount: Number(row.amount),
      fee: Number(row.fee),
      total: Number(row.total),
      counterpartyId: String(row.to_user_id),
      createdAt: row.created_at,
    })),
    ...(received ?? []).map((row) => ({
      direction: 'in',
      amount: Number(row.amount),
      fee: 0,
      total: Number(row.amount),
      counterpartyId: String(row.from_user_id),
      createdAt: row.created_at,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return rows.slice(0, limit)
}

// Бонусы: из daily_bonus_claims.
export async function getBonusHistory(userId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabaseAdmin
    .from('daily_bonus_claims')
    .select('amount, streak_day, claim_date, claimed_at')
    .eq('user_id', userId)
    .order('claimed_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((row) => ({
    amount: Number(row.amount),
    streakDay: Number(row.streak_day),
    claimDate: row.claim_date,
    createdAt: row.claimed_at,
  }))
}

// Покупки: из payments.
export async function getPurchaseHistory(userId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabaseAdmin
    .from('payments')
    .select('stars, amount_bc, status, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((row) => ({
    stars: Number(row.stars),
    amountBc: Number(row.amount_bc),
    status: row.status,
    createdAt: row.created_at,
  }))
}

// Игры: из transactions с meta.game ('upgrade' | 'crash').
export async function getGameHistory(userId, game, limit = HISTORY_LIMIT) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, meta, created_at')
    .eq('user_id', userId)
    .eq('type', 'purchase')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return (data ?? [])
    .filter((row) => row.meta?.game === game)
    .slice(0, limit)
    .map((row) => ({
      stake: Number(row.meta?.stake ?? 0),
      payout: Number(row.amount),
      detail: row.meta ?? {},
      createdAt: row.created_at,
    }))
}

// Единая лента истории: собирает все типы операций в один список.
// Возвращает массив { category, title, subtitle, amount, currency, direction, createdAt }.
export async function getAllHistory(userId, limit = 100) {
  const [exchanges, transfers, bonuses, purchases, upgrades, crashes] = await Promise.all([
    getExchangeHistory(userId, limit).catch(() => []),
    getTransferHistory(userId, limit).catch(() => []),
    getBonusHistory(userId, limit).catch(() => []),
    getPurchaseHistory(userId, limit).catch(() => []),
    getGameHistory(userId, 'upgrade', limit).catch(() => []),
    getGameHistory(userId, 'crash', limit).catch(() => []),
  ])

  const items = []

  for (const e of exchanges) {
    items.push({
      category: 'exchange',
      title: `Обмен ${formatAmount(e.amount)} ${e.from} → ${formatAmount(e.received)} ${e.to}`,
      subtitle: `курс ${formatAmount(e.rate)}`,
      amount: e.received,
      currency: e.to,
      direction: 'exchange',
      createdAt: e.createdAt,
    })
  }

  for (const t of transfers) {
    items.push({
      category: 'transfer',
      title: t.direction === 'in' ? `Перевод от ${t.counterpartyId}` : `Перевод для ${t.counterpartyId}`,
      subtitle: t.direction === 'out' ? `комиссия ${formatAmount(t.fee)} BC` : 'получено',
      amount: t.amount,
      currency: 'BC',
      direction: t.direction,
      createdAt: t.createdAt,
    })
  }

  for (const b of bonuses) {
    items.push({
      category: 'bonus',
      title: 'Ежедневный бонус',
      subtitle: `день серии ${b.streakDay}`,
      amount: b.amount,
      currency: 'BC',
      direction: 'in',
      createdAt: b.createdAt,
    })
  }

  for (const p of purchases) {
    items.push({
      category: 'purchase',
      title: `Покупка BC за ${formatAmount(p.stars)} ⭐`,
      subtitle: p.status === 'paid' ? 'выполнено' : p.status,
      amount: p.amountBc,
      currency: 'BC',
      direction: 'in',
      createdAt: p.createdAt,
    })
  }

  for (const g of upgrades) {
    const won = Number(g.payout) > 0
    items.push({
      category: 'game',
      title: `Апгрейдер · шанс ${g.detail.chance ?? '—'}%`,
      subtitle: won ? 'выигрыш' : 'проигрыш',
      amount: won ? Number(g.payout) : Number(g.stake),
      currency: 'BC',
      direction: won ? 'in' : 'out',
      createdAt: g.createdAt,
    })
  }

  for (const c of crashes) {
    const cashed = c.detail.cashed === true
    items.push({
      category: 'game',
      title: cashed ? `Краш · забрал на ${formatAmount(c.detail.multiplier ?? 0)}×` : 'Краш · не успел',
      subtitle: cashed ? 'выигрыш' : 'проигрыш',
      amount: cashed ? Number(c.payout) : Number(c.stake),
      currency: 'BC',
      direction: cashed ? 'in' : 'out',
      createdAt: c.createdAt,
    })
  }

  return items
    .filter((item) => item.createdAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
}

function formatAmount(value) {
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
}

// Записать покупку (payments + transactions).
export async function logPurchase(userId, stars, amountBc, status = 'paid') {
  const { error: payError } = await supabaseAdmin
    .from('payments')
    .insert({ user_id: userId, stars, amount_bc: round2(amountBc), status })
  if (payError) throw payError
  await logTransaction(userId, 'purchase', amountBc, 'BC', { stars })
}

// Начислить BC по оплате Telegram Stars. Ищем пользователя по telegram_id (id в users),
// увеличиваем balance_bc и total_deposited, пишем в payments (status='paid').
// Возвращает обновлённую запись пользователя (или null, если пользователь не найден).
export async function creditStarsPurchase(telegramId, stars, amountBc) {
  const user = await getUserById(telegramId)
  if (!user) return null

  const { data: updated, error } = await supabaseAdmin
    .from('users')
    .update({
      balance_bc: round2(Number(user.balance_bc) + Number(amountBc)),
      total_deposited: round2(Number(user.total_deposited) + Number(amountBc)),
      updated_at: new Date().toISOString(),
    })
    .eq('id', telegramId)
    .select('*')
    .single()
  if (error) throw error

  const { error: payError } = await supabaseAdmin
    .from('payments')
    .insert({ user_id: telegramId, stars, amount_bc: round2(amountBc), status: 'paid' })
  if (payError) throw payError

  await logTransaction(telegramId, 'purchase', amountBc, 'BC', { stars, source: 'telegram_stars' }).catch(() => {})
  return updated
}

// Вспомогательное: сгенерировать код заявки вида WD-XXXX-XXXX.
function generateWithdrawalCode() {
  const hex = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0').toUpperCase()
  return `WD-${hex()}-${hex()}`
}

// ---------------------------------------------------------------------------
// Админ-функции. ВАЖНО: проверка прав администратора выполняется на уровне
// роутов (server/app.js) до вызова этих функций. Здесь — только работа с БД.
// ---------------------------------------------------------------------------

// Начислить (или списать, если amount < 0) баланс игроку.
export async function adminGiveBalance(userId, currency, amount) {
  const field = { BC: 'balance_bc', A: 'balance_a', B: 'balance_b' }[currency]
  if (!field) throw new Error('Некорректная валюта.')
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Сумма должна быть ненулевой.')

  const user = await getUserById(userId)
  if (!user) throw new Error('Игрок не найден.')

  const next = round2(Number(user[field]) + amount)
  if (next < 0) throw new Error('Баланс не может стать отрицательным.')

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ [field]: next, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('*')
    .single()
  if (error) throw error

  await logTransaction(userId, 'admin_give', amount, currency, { by: 'admin', field }).catch(() => {})
  return data
}

// Забанить пользователя с указанием причины.
export async function adminBanUser(userId, reason) {
  const user = await getUserById(userId)
  if (!user) throw new Error('Игрок не найден.')

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ is_banned: true, ban_reason: reason || null, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Разбанить пользователя.
export async function adminUnbanUser(userId) {
  const user = await getUserById(userId)
  if (!user) throw new Error('Игрок не найден.')

  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ is_banned: false, ban_reason: null, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Список заявок на вывод со статусом pending (для админ-панели).
export async function adminListPendingWithdrawals(limit = 100) {
  const { data, error } = await supabaseAdmin
    .from('withdrawals')
    .select('code, user_id, amount, currency, status, created_at')
    .eq('status', 'pending')
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((row) => ({
    code: row.code,
    userId: String(row.user_id),
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
  }))
}

// Изменить статус заявки на вывод ('approved' | 'rejected' | 'paid').
export async function adminSetWithdrawalStatus(code, status) {
  if (!['approved', 'rejected', 'paid'].includes(status)) throw new Error('Некорректный статус.')
  const { data, error } = await supabaseAdmin
    .from('withdrawals')
    .update({ status })
    .eq('code', code)
    .select('code, user_id, amount, currency, status, created_at')
    .single()
  if (error) throw error
  return {
    code: data.code,
    userId: String(data.user_id),
    amount: Number(data.amount),
    currency: data.currency,
    status: data.status,
    createdAt: data.created_at,
  }
}

// Найти пользователя по username (без @, регистронезависимо). Возвращает запись или null.
export async function findUserByUsername(username) {
  const clean = String(username ?? '').trim().replace(/^@/, '')
  if (!clean) throw new Error('Укажите username.')
  // username хранится как есть из Telegram (без @). Postgres ILIKE через ilike() даёт регистронезависимый поиск.
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .ilike('username', clean)
    .maybeSingle()
  if (error) throw error
  return data
}

// Начислить/списать баланс игроку по username.
export async function adminGiveBalanceByUsername(username, currency, amount) {
  const user = await findUserByUsername(username)
  if (!user) throw new Error('Игрок с таким username не найден.')
  return adminGiveBalance(String(user.id), currency, amount)
}

// Забанить игрока по username.
export async function adminBanUserByUsername(username, reason) {
  const user = await findUserByUsername(username)
  if (!user) throw new Error('Игрок с таким username не найден.')
  return adminBanUser(String(user.id), reason)
}

// Разбанить игрока по username.
export async function adminUnbanUserByUsername(username) {
  const user = await findUserByUsername(username)
  if (!user) throw new Error('Игрок с таким username не найден.')
  return adminUnbanUser(String(user.id))
}
