// Клиент для общения фронтенда с нашим сервером (Express → Supabase).
// Фронтенд НИКОГДА не обращается к Supabase напрямую.

type TelegramWebApp = {
  initData?: string
  initDataUnsafe?: { user?: { id?: number } }
  ready?: () => void
  expand?: () => void
}

function getTelegram(): TelegramWebApp | undefined {
  return (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp
}

// Заголовок авторизации: в Telegram — подписанный initData, иначе — локальный dev-режим.
function authHeaders(): Record<string, string> {
  const initData = getTelegram()?.initData
  if (initData) return { Authorization: `tma ${initData}` }
  return {}
}

// Локальный fallback-id, если приложение открыто не в Telegram (как в демо).
function devUserId(): string {
  const tgId = getTelegram()?.initDataUnsafe?.user?.id
  if (tgId) return String(tgId)
  return '8951066218'
}

export type PublicProfile = {
  id: string
  username: string
  name: string
  photoUrl: string
  balanceBc: number
  balanceA: number
  balanceB: number
  totalSent: number
  totalDeposited: number
  level: number
  xp: number
  dailyStreak: number
  lastBonusDate: string | null
}

export type WithdrawalItem = {
  code: string
  amount: number
  currency: 'BC'
  status: 'pending' | 'approved' | 'rejected' | 'paid'
  createdAt: string
}

export type RateInfo = { name: string; rate: number }
export type RatePoint = { day: string; rate: number }
export type RatesResponse = {
  rates: Record<string, RateInfo>
  history: Record<string, RatePoint[]>
}

export type AchievementItem = {
  code: string
  title: string
  description: string
  target: number
  rewardBc: number
  progress: number
  unlocked: boolean
}

export type ExchangeHistoryItem = {
  from: string
  to: string
  amount: number
  received: number
  rate: number
  createdAt: string
}
export type TransferHistoryItem = {
  direction: 'in' | 'out'
  amount: number
  fee: number
  total: number
  counterpartyId: string
  createdAt: string
}
export type BonusHistoryItem = {
  amount: number
  streakDay: number
  claimDate: string
  createdAt: string
}
export type PurchaseHistoryItem = {
  stars: number
  amountBc: number
  status: 'pending' | 'paid' | 'failed' | 'refunded'
  createdAt: string
}
export type GameHistoryItem = {
  stake: number
  payout: number
  detail: { won?: boolean; chance?: number; multiplier?: number; cashed?: boolean; crashPoint?: number }
  createdAt: string
}

export type HistoryCategory = 'exchange' | 'transfer' | 'bonus' | 'purchase' | 'game'
export type HistoryEntry = {
  category: HistoryCategory
  title: string
  subtitle: string
  amount: number
  currency: string
  direction: 'in' | 'out' | 'exchange'
  createdAt: string
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify({ userId: devUserId(), ...(body as object) }),
  })

  const result = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'Сервер вернул ошибку.')
  return result
}

export const api = {
  initTelegram() {
    const tg = getTelegram()
    tg?.ready?.()
    tg?.expand?.()
    // Прогрев: поднимаем холодную serverless-функцию параллельно, пока грузится UI.
    // Не ждём ответа и не влияем на логику — просто «будим» API.
    fetch('/api/health', { method: 'GET', cache: 'no-store' }).catch(() => {})
  },
  auth: () => request<{ profile: PublicProfile }>('/api/auth', {}),
  exchange: (from: string, to: string, amount: number) =>
    request<{ profile: PublicProfile; received: number }>('/api/exchange', { from, to, amount }),
  transfer: (recipient: string, amount: number) =>
    request<{ profile: PublicProfile; received: number; fee: number }>('/api/transfer', { recipient, amount }),
  listWithdrawals: (userId: string) =>
    request<{ withdrawals: WithdrawalItem[] }>(`/api/withdrawals?userId=${encodeURIComponent(userId)}`),
  createWithdrawal: (amount: number) =>
    request<{ withdrawal: WithdrawalItem; profile?: PublicProfile }>('/api/withdrawals', { amount, currency: 'BC' }),
  dailyBonus: () =>
    request<{ profile: PublicProfile; reward: number }>('/api/bonus/daily', {}),
  purchase: (stars: number) =>
    request<{ profile: PublicProfile; amount: number }>('/api/purchase', { stars }),
  rates: () => request<RatesResponse>('/api/rates'),
  achievements: (userId: string) =>
    request<{ achievements: AchievementItem[] }>(`/api/achievements?userId=${encodeURIComponent(userId)}`),
  upgrade: (stake: number, chance: number) =>
    request<{ profile: PublicProfile; won: boolean; payout: number; stake: number }>('/api/games/upgrade', { stake, chance }),
  crashStart: (stake: number) =>
    request<{ profile: PublicProfile; crashPoint: number }>('/api/games/crash/start', { stake }),
  // Сервер сам знает ставку и точку краша из активного заезда — шлём только множитель.
  crashCashout: (multiplier: number) =>
    request<{ profile: PublicProfile; payout: number; crashed: boolean }>('/api/games/crash/cashout', { multiplier }),
  historyExchanges: (userId: string) =>
    request<{ items: ExchangeHistoryItem[] }>(`/api/history/exchanges?userId=${encodeURIComponent(userId)}`),
  historyTransfers: (userId: string) =>
    request<{ items: TransferHistoryItem[] }>(`/api/history/transfers?userId=${encodeURIComponent(userId)}`),
  historyBonuses: (userId: string) =>
    request<{ items: BonusHistoryItem[] }>(`/api/history/bonuses?userId=${encodeURIComponent(userId)}`),
  historyPurchases: (userId: string) =>
    request<{ items: PurchaseHistoryItem[] }>(`/api/history/purchases?userId=${encodeURIComponent(userId)}`),
  historyGames: (userId: string, game: 'upgrade' | 'crash') =>
    request<{ items: GameHistoryItem[] }>(`/api/history/games?userId=${encodeURIComponent(userId)}&game=${game}`),
  historyAll: (userId: string) =>
    request<{ items: HistoryEntry[] }>(`/api/history/all?userId=${encodeURIComponent(userId)}`),
}
