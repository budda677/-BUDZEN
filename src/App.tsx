import { useEffect, useMemo, useRef, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  api, type PublicProfile, type RatePoint,
  type ExchangeHistoryItem, type TransferHistoryItem, type BonusHistoryItem,
  type PurchaseHistoryItem, type GameHistoryItem, type HistoryEntry, type HistoryCategory,
  type AdminWithdrawalItem,
} from './api'
import './App.css'

// Telegram ID администратора — кому видна вкладка «Админ».
const ADMIN_TELEGRAM_ID = '1685473570'

type RateState = { rates: CurrencyBalances; history: Record<RateTicker, RatePoint[]> }
type RateTicker = 'A' | 'B'
type ExchangeTicker = 'BC' | RateTicker
type CurrencyBalances = Record<RateTicker, number>
type CrashPhase = 'ready' | 'running' | 'crashed' | 'cashed'
type CrashHistoryEntry = { multiplier: number; outcome: 'crashed' | 'cashed' }
type WithdrawalStatus = 'pending' | 'approved' | 'rejected' | 'paid'
type WithdrawalRequest = { code: string; amount: number; currency: 'A' | 'B'; status: WithdrawalStatus; createdAt: string }
type QuestId = 'exchange' | 'invite' | 'upgrader'
type TelegramUser = { id?: number; first_name?: string; last_name?: string; username?: string }
type ProfileIdentity = { id: string; name: string; username: string }
type DailyBonusState = { lastClaimDate: string | null; streak: number }
type QuestState = {
  exchangeBcProgress: number
  inviteCompleted: boolean
  upgraderCompleted: boolean
  claimed: Record<QuestId, boolean>
}

const currencies: { name: string; ticker: RateTicker; amount: string; color: string; icon: string }[] = [
  { name: 'ALPHA', ticker: 'A', amount: '1 000', color: '#e8b94e', icon: 'A' },
  { name: 'BETA', ticker: 'B', amount: '500', color: '#4d91ff', icon: 'B' },
]
const games = ['Апгрейдер', 'Краш', 'Батл']
const upgradeChances = [10, 25, 50, 75]
const maxUpgradeChance = 80
const quickSpinDuration = 1500
const longSpinDuration = 6000
const activitySections = ['История', 'Ежедневный бонус', 'Квесты', 'Достижения', 'Рефералы', 'Партнёры']
const rateTickers: RateTicker[] = ['A', 'B']
const historyFilters: { id: HistoryCategory | 'all'; label: string; icon: string }[] = [
  { id: 'all', label: 'Всё', icon: '✦' },
  { id: 'exchange', label: 'Обмены', icon: '⇄' },
  { id: 'transfer', label: 'Переводы', icon: '↗' },
  { id: 'bonus', label: 'Бонусы', icon: '★' },
  { id: 'purchase', label: 'Покупки', icon: '⭑' },
  { id: 'game', label: 'Игры', icon: '⌁' },
]
const currencyBalanceStorageKey = 'budzen-demo-currency-balances'
const dailyBonusStorageKey = 'budzen-demo-daily-bonus'
const questStorageKey = 'budzen-demo-quests'
const referralVisitsStorageKey = 'budzen-demo-referral-visits'
const referralVisitSeenStorageKey = 'budzen-demo-referral-visit-seen'
const profileAvatarStorageKey = 'budzen-demo-profile-avatar'
const lastBalanceStorageKey = 'budzen-demo-last-bc-balance'
const referralCode = 'BUDZEN8951066218'
const incomingReferralVisit = new URLSearchParams(window.location.search).get('ref') === referralCode
const dailyBonusAmount = 10
const streakBonusAmount = 50
const questRewardAmount = 5
const transferFeeRate = 0.02
const startingCurrencyBalances: CurrencyBalances = { A: 1000, B: 500 }
// Строит SVG path дуги радиуса r вокруг центра (cx,cy). Дуга шириной `chance`
// процентов, СИММЕТРИЧНО относительно низа колеса (где стоит указатель при
// повороте 0°) — так визуал совпадает с computeUpgradeRotation.
function upgradeArcPath(chance: number, cx = 160, cy = 160, r = 116) {
  const spanDeg = chance * 3.6
  // Центр дуги внизу = 90° в стандартных SVG-координатах (0° → вправо, по часовой).
  const centerDeg = 90
  const startDeg = centerDeg - spanDeg / 2
  const endDeg = centerDeg + spanDeg / 2
  const toXY = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
  }
  const start = toXY(startDeg)
  const end = toXY(endDeg)
  const largeArc = spanDeg > 180 ? 1 : 0
  // sweep=1 — по часовой (как идёт увеличение угла).
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

// Подбирает накопительный угол поворота указателя под результат раунда.
//
// Геометрия: стрелка по умолчанию смотрит ВНИЗ (6 часов). Выигрышная дуга
// (upgradeArcPath) центрирована ровно внизу и имеет ширину chance*3.6°.
// Стрелка при повороте на `rotation` смотрит на (180 + rotation)° от верха.
//
//  • выигрыш — поворот указывает в центр дуги, с запасом ~18% от её полуширины,
//    чтобы остриё было ЯВНО внутри, а не на краю;
//  • проигрыш — поворот уводит стрелку в центр СВОБОДНОЙ зоны (напротив дуги),
//    тоже с запасом от границ.
function computeUpgradeRotation(won: boolean, chance: number, extraTurns: number) {
  const winHalf = (chance * 3.6) / 2          // полуширина выигрышной дуги, °
  const freeHalf = (360 - chance * 3.6) / 2   // полуширина свободной зоны, °

  let baseRotation: number
  if (won) {
    // Ограничиваем «яблочко» до 82% полуширины, чтобы даже при широкой дуге
    // стрелка не вставала у самого края.
    const safeHalf = Math.max(0, winHalf * 0.82)
    baseRotation = (Math.random() * 2 - 1) * safeHalf
  } else {
    // Центр свободной зоны — напротив дуги (поворот 180°). Берём не более
    // 82% её полуширины, чтобы гарантированно не задеть выигрышную дугу.
    const safeHalf = Math.max(0, freeHalf * 0.82)
    baseRotation = 180 + (Math.random() * 2 - 1) * safeHalf
  }

  return extraTurns * 360 + baseRotation
}




const exchangeAssets: { ticker: ExchangeTicker; name: string }[] = [
  { ticker: 'BC', name: 'BUDDA COINS' },
  { ticker: 'A', name: 'ALPHA' },
  { ticker: 'B', name: 'BETA' },
]

function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDateKey(key: string, offset: number) {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + offset)
  return dateKey(date)
}

function formatRateDay(key: string) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
}

// Преобразует ответ сервера (курсы + история) в состояние графика.
function buildHistory(
  history: Record<string, { day: string; rate: number }[]>,
  rates: Record<string, { name: string; rate: number }>,
): Record<RateTicker, RatePoint[]> {
  const result = { A: [] as RatePoint[], B: [] as RatePoint[] }
  for (const ticker of rateTickers) {
    const points = history[ticker] ?? []
    if (points.length > 0) {
      result[ticker] = points.map((point) => ({ day: formatRateDay(point.day), rate: point.rate }))
    } else {
      // Если истории нет — показываем хотя бы текущий курс одной точкой.
      const fallbackRate = rates[ticker]?.rate ?? 1
      result[ticker] = [{ day: formatRateDay(dateKey(new Date())), rate: fallbackRate }]
    }
  }
  return result
}

const initialTodayDate = dateKey(new Date())
const crashRoadYAt = (x: number) => 218 + Math.sin(x / 180) * 12 + Math.sin(x / 65) * 5
const crashRoadPath = Array.from({ length: 47 }, (_, index) => {
  const x = -200 + index * 80
  return `${index === 0 ? 'M' : 'L'} ${x} ${crashRoadYAt(x)}`
}).join(' ')

function loadCurrencyBalances(): CurrencyBalances {
  try {
    const saved = window.localStorage.getItem(currencyBalanceStorageKey)
    if (saved) {
      const parsed: unknown = JSON.parse(saved)
      if (typeof parsed === 'object' && parsed !== null) {
        const balances = parsed as Partial<CurrencyBalances>
        if (['A', 'B'].every((ticker) => {
          const value = balances[ticker as RateTicker]
          return typeof value === 'number' && Number.isFinite(value) && value >= 0
        })) return balances as CurrencyBalances
      }
    }
  } catch {
    // Use demo holdings when browser storage is unavailable or invalid.
  }

  return { ...startingCurrencyBalances }
}

// Последний известный реальный баланс BC — чтобы при повторном заходе не мелькало ложное «1000».
function loadLastBalance(): number | null {
  try {
    const saved = window.localStorage.getItem(lastBalanceStorageKey)
    if (saved != null) {
      const value = Number(saved)
      if (Number.isFinite(value) && value >= 0) return value
    }
  } catch {
    // storage недоступен — считаем, что кэша нет.
  }
  return null
}

function loadDailyBonus(): DailyBonusState {
  try {
    const saved = window.localStorage.getItem(dailyBonusStorageKey)
    if (saved) {
      const parsed: unknown = JSON.parse(saved)
      if (typeof parsed === 'object' && parsed !== null) {
        const state = parsed as Partial<DailyBonusState>
        if ((state.lastClaimDate === null || typeof state.lastClaimDate === 'string') && Number.isInteger(state.streak) && (state.streak ?? -1) >= 0) {
          return state as DailyBonusState
        }
      }
    }
  } catch {
    // Start a fresh demo streak if storage is unavailable or invalid.
  }

  return { lastClaimDate: null, streak: 0 }
}

function loadQuestState(): QuestState {
  const emptyState: QuestState = {
    exchangeBcProgress: 0,
    inviteCompleted: false,
    upgraderCompleted: false,
    claimed: { exchange: false, invite: false, upgrader: false },
  }

  try {
    const saved = window.localStorage.getItem(questStorageKey)
    if (saved) {
      const parsed: unknown = JSON.parse(saved)
      if (typeof parsed === 'object' && parsed !== null) {
        const state = parsed as Partial<QuestState>
        if (typeof state.exchangeBcProgress === 'number' && Number.isFinite(state.exchangeBcProgress)
          && typeof state.inviteCompleted === 'boolean' && typeof state.upgraderCompleted === 'boolean'
          && typeof state.claimed === 'object' && state.claimed !== null) {
          return {
            exchangeBcProgress: Math.max(0, state.exchangeBcProgress),
            inviteCompleted: state.inviteCompleted,
            upgraderCompleted: state.upgraderCompleted,
            claimed: {
              exchange: state.claimed.exchange === true,
              invite: state.claimed.invite === true,
              upgrader: state.claimed.upgrader === true,
            },
          }
        }
      }
    }
  } catch {
    // Start fresh demo quests if storage is unavailable or invalid.
  }

  return emptyState
}

function loadReferralVisits() {
  try {
    const savedCount = Number(window.localStorage.getItem(referralVisitsStorageKey))
    const count = Number.isInteger(savedCount) && savedCount >= 0 ? savedCount : 0
    const alreadyCounted = window.localStorage.getItem(referralVisitSeenStorageKey) === '1'
    return incomingReferralVisit && !alreadyCounted ? count + 1 : count
  } catch {
    // Count the incoming demo visit for this page session if storage is unavailable.
  }

  return incomingReferralVisit ? 1 : 0
}

function loadTelegramIdentity(): ProfileIdentity {
  const telegramWindow = window as Window & {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: TelegramUser } } }
  }
  const user = telegramWindow.Telegram?.WebApp?.initDataUnsafe?.user
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ')

  return {
    id: user?.id ? String(user.id) : '8951066218',
    name: name || 'Demo User',
    username: user?.username ? `@${user.username}` : '@demo_user',
  }
}

function loadProfileAvatar() {
  try {
    return window.localStorage.getItem(profileAvatarStorageKey) ?? ''
  } catch {
    return ''
  }
}

function formatBalance(amount: number) {
  return amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
}

function formatHistoryDate(value: string) {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function App() {
  const [tab, setTab] = useState(() => {
    try {
      return window.localStorage.getItem('budzen-active-tab') || 'Главная'
    } catch {
      return 'Главная'
    }
  })
  const [telegramIdentity] = useState(loadTelegramIdentity)
  const isAdmin = telegramIdentity.id === ADMIN_TELEGRAM_ID
  const [profile, setProfile] = useState<PublicProfile | null>(null)

  // --- Состояние админ-панели (только для админа) ---
  const [adminGiveUsername, setAdminGiveUsername] = useState('')
  const [adminGiveCurrency, setAdminGiveCurrency] = useState<'BC' | 'A' | 'B'>('BC')
  const [adminGiveAmount, setAdminGiveAmount] = useState('100')
  const [adminGiveMsg, setAdminGiveMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [adminBanUsername, setAdminBanUsername] = useState('')
  const [adminBanReason, setAdminBanReason] = useState('')
  const [adminBanMsg, setAdminBanMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [adminWithdrawals, setAdminWithdrawals] = useState<AdminWithdrawalItem[]>([])
  const [adminWithdrawalsLoading, setAdminWithdrawalsLoading] = useState(false)
  const [adminWithdrawalsMsg, setAdminWithdrawalsMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [rates, setRates] = useState<RateState>({ rates: { A: 1, B: 1 }, history: { A: [], B: [] } })
  const [achievementsData, setAchievementsData] = useState<{ title: string; description: string; progress: number; target: number }[]>([])
  const [profileAvatar, setProfileAvatar] = useState(loadProfileAvatar)
  const [profileAvatarError, setProfileAvatarError] = useState('')
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false)
  const [today, setToday] = useState(initialTodayDate)
  const [selectedTicker, setSelectedTicker] = useState<RateTicker>('A')
  const [selectedChance, setSelectedChance] = useState(50)
  const [chanceEntry, setChanceEntry] = useState('50')
  // Пока профиль не загружен: показываем последний известный баланс (кэш),
  // иначе 0 — чтобы не мелькало ложное «1000» до прихода реальных данных.
  const cachedBalance = useMemo(loadLastBalance, [])
  const demoBalance = profile ? profile.balanceBc : cachedBalance ?? 0
  const [currencyBalances, setCurrencyBalances] = useState(loadCurrencyBalances)
  const [exchangeFrom, setExchangeFrom] = useState<ExchangeTicker>('BC')
  const [exchangeTo, setExchangeTo] = useState<ExchangeTicker>('A')
  const [exchangeAmount, setExchangeAmount] = useState('100')
  const [exchangeFeedback, setExchangeFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [exchangeBusy, setExchangeBusy] = useState(false)
  const [transferRecipient, setTransferRecipient] = useState('')
  const [transferAmount, setTransferAmount] = useState('100')
  const [transferFeedback, setTransferFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [dailyBonus, setDailyBonus] = useState(loadDailyBonus)
  const [questState, setQuestState] = useState(() => {
    const state = loadQuestState()
    return incomingReferralVisit ? { ...state, inviteCompleted: true } : state
  })
  const [referralVisits] = useState(loadReferralVisits)
  const [referralFeedback, setReferralFeedback] = useState('')
  const [purchaseBcAmount, setPurchaseBcAmount] = useState('1000')
  const [purchaseFeedback, setPurchaseFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [topUpCode, setTopUpCode] = useState('')
  const [topUpMessage, setTopUpMessage] = useState('')
  const [withdrawalAmount, setWithdrawalAmount] = useState('100')
  const [withdrawalCurrency, setWithdrawalCurrency] = useState<'A' | 'B'>('A')
  const [withdrawalRequests, setWithdrawalRequests] = useState<WithdrawalRequest[] | null>(null)
  const [withdrawalFeedback, setWithdrawalFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [generatedWithdrawalCode, setGeneratedWithdrawalCode] = useState<string | null>(null)
  const [withdrawalSubmitting, setWithdrawalSubmitting] = useState(false)
  const [upgradeStake, setUpgradeStake] = useState(() => String(Math.min(100, demoBalance)))
  const [fastSpinEnabled, setFastSpinEnabled] = useState(false)
    const [upgradeSpinning, setUpgradeSpinning] = useState(false)
  const [upgradeSpinAngle, setUpgradeSpinAngle] = useState(0)
  const [upgradeResult, setUpgradeResult] = useState<{ won: boolean; payout: number; stake: number } | null>(null)
  const [upgradeError, setUpgradeError] = useState('')
  const [crashStake, setCrashStake] = useState(() => String(Math.min(100, demoBalance)))
  const [crashPhase, setCrashPhase] = useState<CrashPhase>('ready')
  const [crashMultiplier, setCrashMultiplier] = useState(1)
  const [crashElapsed, setCrashElapsed] = useState(0)
  const [crashPoint, setCrashPoint] = useState(2)
  const [crashBet, setCrashBet] = useState(0)
  const [crashPayout, setCrashPayout] = useState(0)
  const [crashError, setCrashError] = useState('')
  const [crashHistory, setCrashHistory] = useState<CrashHistoryEntry[]>([])
  const [exchangeHistory, setExchangeHistory] = useState<ExchangeHistoryItem[]>([])
  const [transferHistory, setTransferHistory] = useState<TransferHistoryItem[]>([])
  const [bonusHistory, setBonusHistory] = useState<BonusHistoryItem[]>([])
  const [purchaseHistory, setPurchaseHistory] = useState<PurchaseHistoryItem[]>([])
  const [upgradeHistory, setUpgradeHistory] = useState<GameHistoryItem[]>([])
  const [crashHistoryLog, setCrashHistoryLog] = useState<GameHistoryItem[]>([])
  const [allHistory, setAllHistory] = useState<HistoryEntry[] | null>(null)
  const [historyFilter, setHistoryFilter] = useState<HistoryCategory | 'all'>('all')
  const crashStartedAt = useRef(0)
  const crashLocked = useRef(false)
  // Значение множителя, которое РЕАЛЬНО сейчас на экране (обновляется таймером).
  // Кашинг всегда идёт по нему, а не по пересчёту времени — иначе рассинхрон
  // до 40 мс может «перекинуть» выше точки краша и сервер засчитает проигрыш.
  const crashVisibleMultiplier = useRef(1)
  // Если игрок нажал «Забрать» раньше, чем сервер прислал точку краша (и сохранил
  // заезд), запоминаем экранный множитель и выполним кашинг, как только точка придёт.
  const pendingCashout = useRef<number | null>(null)
  // Синхронная блокировка апгрейдера: state на телефоне не успевает обновиться
  // между быстрыми тапами, из-за чего запускалось несколько раундов разом.
  const upgradeBusyRef = useRef(false)
  // id текущего rAF-цикла вращения стрелки — чтобы отменять предыдущий.
  const upgradeRafRef = useRef<number | null>(null)
  // Актуальный угол в ref — playUpgrade не должен зависеть от устаревшего
  // замыкания state после await. Обновляем в animateUpgradePointer.
  const upgradeSpinAngleRef = useRef(0)
  const selectedCurrency = currencies.find((currency) => currency.ticker === selectedTicker) ?? currencies[0]
  const selectedRates = rates.history[selectedTicker]
  const currentRate = selectedRates.length > 0 ? selectedRates[selectedRates.length - 1].rate : (rates.rates[selectedTicker] ?? 1)
  const previousRate = selectedRates.length > 1 ? selectedRates[selectedRates.length - 2].rate : currentRate
  const rateIncreased = currentRate >= previousRate
  const rateColor = rateIncreased ? '#48d597' : '#ff667a'
  const chartRateColor = selectedTicker === 'A' ? '#e8b94e' : '#4d91ff'
  const exchangeUnitValues: Record<ExchangeTicker, number> = {
    BC: 1,
    A: rates.rates.A,
    B: rates.rates.B,
  }
  const exchangeRate = exchangeUnitValues[exchangeFrom] / exchangeUnitValues[exchangeTo]
  const exchangeReceive = Number(exchangeAmount) * exchangeRate
  const exchangeAvailable = exchangeFrom === 'BC' ? demoBalance : currencyBalances[exchangeFrom]
  const transferValue = Number(transferAmount)
  const transferFee = Number.isFinite(transferValue) && transferValue > 0 ? Number((transferValue * transferFeeRate).toFixed(2)) : 0
  const transferTotal = Number.isFinite(transferValue) && transferValue > 0 ? Number((transferValue + transferFee).toFixed(2)) : 0
  const transferAvailable = demoBalance
  const withdrawalAvailable = currencyBalances[withdrawalCurrency]
  const yesterday = today ? shiftDateKey(today, -1) : ''
  const dailyClaimedToday = dailyBonus.lastClaimDate === today
  const consecutiveStreak = dailyBonus.lastClaimDate === yesterday ? dailyBonus.streak : 0
  const nextStreak = dailyClaimedToday ? dailyBonus.streak : consecutiveStreak + 1
  const nextDailyReward = nextStreak % 7 === 0 ? streakBonusAmount : dailyBonusAmount
  const displayedStreak = dailyClaimedToday ? dailyBonus.streak : consecutiveStreak
  const streakDay = displayedStreak > 0 ? ((displayedStreak - 1) % 7) + 1 : 0
  const referralLink = `${window.location.origin}${window.location.pathname}?ref=${referralCode}`
  const achievements = achievementsData.length > 0 ? achievementsData : [
    { title: 'Первый бонус', description: 'Получи ежедневный бонус', progress: dailyBonus.streak > 0 ? 1 : 0, target: 1 },
    { title: 'Неделя активности', description: 'Забирай бонус 7 дней подряд', progress: dailyBonus.streak >= 7 ? 7 : displayedStreak, target: 7 },
    { title: 'Первый обмен', description: 'Обменивай BUDDA COINS на валюту', progress: questState.exchangeBcProgress > 0 ? 1 : 0, target: 1 },
    { title: 'Крупный обмен', description: 'Обмени 1 000 BC', progress: Math.min(1000, questState.exchangeBcProgress), target: 1000 },
    { title: 'Первый апгрейд', description: 'Заверши раунд в Апгрейдере', progress: questState.upgraderCompleted ? 1 : 0, target: 1 },
    { title: 'Друг в игре', description: 'Подтверди приглашение друга', progress: questState.inviteCompleted ? 1 : 0, target: 1 },
  ]
  const unlockedAchievements = achievements.filter((achievement) => achievement.progress >= achievement.target).length
  const filteredHistory = (allHistory ?? []).filter((item) => historyFilter === 'all' || item.category === historyFilter)

  // -------------------------------------------------------------------------
  // Первичная загрузка данных с сервера (Supabase).
  // -------------------------------------------------------------------------
  async function bootstrap() {
    try {
      api.initTelegram()
      const [authResult, ratesResult] = await Promise.all([api.auth(), api.rates()])
      setProfile(authResult.profile)
      setCurrencyBalances({ A: authResult.profile.balanceA, B: authResult.profile.balanceB })
      setRates({
        rates: { A: ratesResult.rates.A?.rate ?? 1, B: ratesResult.rates.B?.rate ?? 1 },
        history: buildHistory(ratesResult.history, ratesResult.rates),
      })
      // Не блокируем первичную отрисовку ожиданием достижений: грузим их в фоне.
      api.achievements(authResult.profile.id)
        .then((ach) => {
          setAchievementsData(ach.achievements.map((item) => ({
            title: item.title, description: item.description, progress: item.progress, target: item.target,
          })))
        })
        .catch(() => {})
    } catch (error) {
      console.error('Ошибка загрузки данных с сервера:', error)
    }
  }

  useEffect(() => { void bootstrap() }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(currencyBalanceStorageKey, JSON.stringify(currencyBalances))
    } catch {
      // Keep demo currency balances for the current session when storage is unavailable.
    }
  }, [currencyBalances])

  useEffect(() => {
    try {
      window.localStorage.setItem(dailyBonusStorageKey, JSON.stringify(dailyBonus))
    } catch {
      // Keep the daily streak for this session if storage is unavailable.
    }
  }, [dailyBonus])

  useEffect(() => {
    try {
      window.localStorage.setItem(questStorageKey, JSON.stringify(questState))
    } catch {
      // Keep quest progress for this session if storage is unavailable.
    }
  }, [questState])

  // Запоминаем активную вкладку, чтобы после обновления страницы остаться на ней.
  useEffect(() => {
    try {
      window.localStorage.setItem('budzen-active-tab', tab)
    } catch {
      // Ignore storage errors.
    }
  }, [tab])

  useEffect(() => {
    try {
      window.localStorage.setItem(referralVisitsStorageKey, String(referralVisits))
      if (incomingReferralVisit) {
        window.localStorage.setItem(referralVisitSeenStorageKey, '1')
        const currentUrl = new URL(window.location.href)
        currentUrl.searchParams.delete('ref')
        window.history.replaceState(null, '', currentUrl)
      }
    } catch {
      // Keep the referral visit count for this session if storage is unavailable.
    }
  }, [referralVisits])

  useEffect(() => {
    if (tab !== 'Вывод BC') return

    let active = true
    api.listWithdrawals(telegramIdentity.id)
      .then((result) => { if (active) setWithdrawalRequests(result.withdrawals) })
      .catch((error: unknown) => {
        if (!active) return
        setWithdrawalFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'API вывода недоступно.' })
        setWithdrawalRequests([])
      })

    return () => { active = false }
  }, [tab, telegramIdentity.id])

  // Загрузка истории по разделам при открытии соответствующей вкладки.
  useEffect(() => {
    if (!profile) return
    const id = profile.id
    if (tab === 'Обмен') {
      api.historyExchanges(id).then((r) => setExchangeHistory(r.items)).catch(() => setExchangeHistory([]))
    } else if (tab === 'Перевод') {
      api.historyTransfers(id).then((r) => setTransferHistory(r.items)).catch(() => setTransferHistory([]))
    } else if (tab === 'Ежедневный бонус') {
      api.historyBonuses(id).then((r) => setBonusHistory(r.items)).catch(() => setBonusHistory([]))
    } else if (tab === 'Покупка BC') {
      api.historyPurchases(id).then((r) => setPurchaseHistory(r.items)).catch(() => setPurchaseHistory([]))
    } else if (tab === 'Апгрейдер') {
      api.historyGames(id, 'upgrade').then((r) => setUpgradeHistory(r.items)).catch(() => setUpgradeHistory([]))
    } else if (tab === 'Краш') {
      api.historyGames(id, 'crash').then((r) => setCrashHistoryLog(r.items)).catch(() => setCrashHistoryLog([]))
    } else if (tab === 'История') {
      setAllHistory(null)
      api.historyAll(id).then((r) => setAllHistory(r.items)).catch(() => setAllHistory([]))
    }
  }, [tab, profile])

  useEffect(() => {
    try {
      if (profileAvatar) window.localStorage.setItem(profileAvatarStorageKey, profileAvatar)
      else window.localStorage.removeItem(profileAvatarStorageKey)
    } catch {
      // Keep the selected avatar for the current session if storage is full.
    }
  }, [profileAvatar])

  useEffect(() => {
    const now = new Date()
    const nextDay = new Date(now)
    nextDay.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(() => {
      setToday(dateKey(new Date()))
    }, nextDay.getTime() - now.getTime() + 50)

    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (crashPhase !== 'running') return

    const timer = window.setInterval(() => {
      // Если кашинг/краш уже зафиксирован синхронно через ref — замираем мгновенно,
      // не дожидаясь, пока React применит setState. Иначе множитель успевает вырасти
      // ещё на несколько тиков после нажатия «Забрать».
      if (crashLocked.current) return

      const elapsedSeconds = (performance.now() - crashStartedAt.current) / 1000
      const nextMultiplier = Math.exp(elapsedSeconds * 0.18)
      // Запоминаем ровно то, что сейчас отрисуем — по нему будем кашить.
      crashVisibleMultiplier.current = nextMultiplier
      setCrashElapsed(elapsedSeconds)

      if (nextMultiplier >= crashPoint) {
        crashLocked.current = true
        crashVisibleMultiplier.current = crashPoint
        setCrashElapsed(Math.log(crashPoint) / 0.18)
        setCrashMultiplier(crashPoint)
        setCrashHistory((history) => [{ multiplier: crashPoint, outcome: 'crashed' as const }, ...history].slice(0, 8))
        setCrashPhase('crashed')
        return
      }

      setCrashMultiplier(nextMultiplier)
    }, 40)

    return () => window.clearInterval(timer)
  }, [crashPhase, crashPoint])

  // Отложенный кашинг: игрок нажал «Забрать», пока сервер ещё не вернул точку краша.
  // Как только точка пришла (а сервер уже сохранил заезд) — фиксируем выплату
  // по тому множителю, что был на экране в момент нажатия.
  useEffect(() => {
    if (pendingCashout.current === null) return
    if (!Number.isFinite(crashPoint)) return
    const target = pendingCashout.current
    pendingCashout.current = null
    void settleCashout(target)
    // settleCashout намеренно не в зависимостях — он не мемоизирован; эффект
    // должен срабатывать только при появлении реального crashPoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crashPoint])

  const crashWorldX = 240 + crashElapsed * 18
  const cameraX = Math.max(0, crashWorldX - 420)
  const cyclistX = crashWorldX - cameraX
  const cyclistY = crashRoadYAt(crashWorldX)

    async function playUpgrade() {
    const spinDuration = fastSpinEnabled ? quickSpinDuration : longSpinDuration
    const wager = Number(upgradeStake)
    const chance = Number(chanceEntry)
    if (upgradeBusyRef.current || upgradeSpinning) return
    if (!Number.isFinite(wager) || wager <= 0) {
      setUpgradeError('Введите ставку больше нуля.')
      return
    }
    if (!chanceEntry.trim() || !Number.isFinite(chance) || chance < 1 || chance > maxUpgradeChance) {
      setUpgradeError(`Введите шанс от 1 до ${maxUpgradeChance}%.`)
      return
    }
    if (wager > demoBalance) {
      setUpgradeError('Недостаточно BC для этой ставки.')
      return
    }

    upgradeBusyRef.current = true
    setUpgradeSpinning(true)
    setUpgradeError('')
    setUpgradeResult(null)

    // 1. СРАЗУ запускаем прокрутку, не дожидаясь ответа сервера — убираем «пинг».
    //    Крутим несколько полных оборотов с ease-out к произвольной промежуточной
    //    цели. Запрос к серверу летит параллельно.
    const startAngle = upgradeSpinAngleRef.current
    const idleTurns = 4 + Math.floor(Math.random() * 2)   // 4–5 оборотов «вхолостую»
    const idleTarget = startAngle + idleTurns * 360
    const spinPromise = animateUpgradePointer(startAngle, idleTarget, spinDuration)

        let result: Awaited<ReturnType<typeof api.upgrade>> | null = null
    let requestError: unknown = null
    let answered = false
    const requestPromise = api.upgrade(wager, chance)
      .then((r) => { result = r; answered = true })
      .catch((e) => { requestError = e; answered = true })

    // 2. Дожидаемся конца «холостой» прокрутки. Если сервер ещё не ответил
    //    (холодный старт) — продолжаем крутить ещё оборот, чтобы стрелка
    //    не замирала. Так пользователь не видит простоя.
    await spinPromise
    while (!answered) {
      const cur = upgradeSpinAngleRef.current
      await animateUpgradePointer(cur, cur + 360, 900)
    }
    await requestPromise

    try {
      if (requestError || !result) throw requestError instanceof Error ? requestError : new Error('Не удалось сделать ставку.')
      const res = result

      setProfile(res.profile)
      setQuestState((state) => ({ ...state, upgraderCompleted: true }))

      // 3. Короткий довод из текущего положения в зону результата (~650 мс).
      const current = upgradeSpinAngleRef.current
      const base = computeUpgradeRotation(res.won, chance, 0)
      const prevMod = ((current % 360) + 360) % 360
      const baseMod = ((base % 360) + 360) % 360
      let delta = baseMod - prevMod
      if (delta < 0) delta += 360
      const finalAngle = current + 360 + delta   // ещё оборот + точная зона
      await animateUpgradePointer(current, finalAngle, 650)

      setUpgradeResult({ won: res.won, payout: res.payout, stake: wager })
    } catch (error) {
      setUpgradeError(error instanceof Error ? error.message : 'Не удалось сделать ставку.')
    } finally {
      upgradeBusyRef.current = false
      setUpgradeSpinning(false)
    }
  }

  // Плавно крутит стрелку от from к to за duration мс через requestAnimationFrame.
  // Возвращает промис, который резолвится по завершении. Угол храним в state —
  // рисуем через SVG-атрибут transform="rotate(angle 160 160)", без CSS origin.
    function animateUpgradePointer(from: number, to: number, duration: number) {
    if (upgradeRafRef.current !== null) {
      cancelAnimationFrame(upgradeRafRef.current)
      upgradeRafRef.current = null
    }
    return new Promise<void>((resolve) => {
      const startedAt = performance.now()
      const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
      const step = () => {
        const elapsed = performance.now() - startedAt
        const progress = Math.min(1, elapsed / duration)
        const eased = easeOut(progress)
        const angle = from + (to - from) * eased
        upgradeSpinAngleRef.current = angle
        setUpgradeSpinAngle(angle)
        if (progress < 1) {
          upgradeRafRef.current = requestAnimationFrame(step)
        } else {
          upgradeSpinAngleRef.current = to
          setUpgradeSpinAngle(to)
          upgradeRafRef.current = null
          resolve()
        }
      }
      upgradeRafRef.current = requestAnimationFrame(step)
    })
  }

  function refillDemoBalance() {
    setUpgradeStake('100')
    setCrashStake('100')
    setUpgradeError('')
    setUpgradeResult(null)
    void bootstrap()
  }

  async function executeExchange() {
    const amount = Number(exchangeAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setExchangeFeedback({ kind: 'error', text: 'Укажите сумму больше нуля.' })
      return
    }
    if (exchangeFrom === exchangeTo) {
      setExchangeFeedback({ kind: 'error', text: 'Выберите разные валюты.' })
      return
    }
    if (amount > exchangeAvailable) {
      setExchangeFeedback({ kind: 'error', text: `Недостаточно ${exchangeFrom} для обмена.` })
      return
    }

    try {
      setExchangeBusy(true)
      // Оптимистичное обновление: мгновенно меняем баланс локально, чтобы кнопка «не думала».
      // Сервер подтвердит результат (или откатим при ошибке).
      const optimisticRate = exchangeUnitValues[exchangeFrom] / exchangeUnitValues[exchangeTo]
      const optimisticReceived = Number((amount * optimisticRate).toFixed(4))
      setProfile((prev) => {
        if (!prev) return prev
        const next = { ...prev }
        if (exchangeFrom === 'BC') next.balanceBc = Number((prev.balanceBc - amount).toFixed(2))
        if (exchangeFrom === 'A') next.balanceA = Number((prev.balanceA - amount).toFixed(4))
        if (exchangeFrom === 'B') next.balanceB = Number((prev.balanceB - amount).toFixed(4))
        if (exchangeTo === 'BC') next.balanceBc = Number((next.balanceBc + optimisticReceived).toFixed(2))
        if (exchangeTo === 'A') next.balanceA = Number((next.balanceA + optimisticReceived).toFixed(4))
        if (exchangeTo === 'B') next.balanceB = Number((next.balanceB + optimisticReceived).toFixed(4))
        return next
      })
      const result = await api.exchange(exchangeFrom, exchangeTo, amount)
      setProfile(result.profile)
      setCurrencyBalances({ A: result.profile.balanceA, B: result.profile.balanceB })
      if (exchangeFrom === 'BC') {
        setQuestState((state) => ({ ...state, exchangeBcProgress: Number((state.exchangeBcProgress + amount).toFixed(2)) }))
      }
      setExchangeFeedback({ kind: 'success', text: `Обмен выполнен: ${formatBalance(result.received)} ${exchangeTo}.` })
    } catch (error) {
      setExchangeFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось выполнить обмен.' })
      // Откат оптимистичного изменения при ошибке.
      void bootstrap()
    } finally {
      setExchangeBusy(false)
    }
  }

  async function submitTransfer() {
    const recipient = transferRecipient.trim()
    if (!recipient) {
      setTransferFeedback({ kind: 'error', text: 'Укажите @username или ID получателя.' })
      return
    }
    if (!Number.isFinite(transferValue) || transferValue <= 0) {
      setTransferFeedback({ kind: 'error', text: 'Укажите сумму больше нуля.' })
      return
    }
    if (transferTotal > transferAvailable) {
      setTransferFeedback({ kind: 'error', text: `Недостаточно BC. Нужно ${formatBalance(transferTotal)} BC с учётом комиссии.` })
      return
    }

    try {
      const result = await api.transfer(recipient, transferValue)
      setProfile(result.profile)
      setTransferAmount('')
      setTransferFeedback({ kind: 'success', text: `Переведено ${formatBalance(transferValue)} BC получателю ${recipient}. Комиссия ${formatBalance(result.fee)} BC (2%).` })
    } catch (error) {
      setTransferFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось выполнить перевод.' })
    }
  }

  async function claimDailyBonus() {
    const claimDate = dateKey(new Date())
    if (dailyBonus.lastClaimDate === claimDate) return

    try {
      const result = await api.dailyBonus()
      setProfile(result.profile)
      const consecutive = dailyBonus.lastClaimDate === shiftDateKey(claimDate, -1)
      const streak = consecutive ? dailyBonus.streak + 1 : 1
      setDailyBonus({ lastClaimDate: claimDate, streak })
    } catch (error) {
      console.error(error)
    }
  }

  function claimQuest(quest: QuestId) {
    if (questState.claimed[quest]) return

    const completed = quest === 'exchange'
      ? questState.exchangeBcProgress >= 1000
      : quest === 'invite' ? questState.inviteCompleted : questState.upgraderCompleted
    if (!completed) return

    setQuestState((state) => ({ ...state, claimed: { ...state.claimed, [quest]: true } }))
    void api.purchase(Math.max(1, Math.round(questRewardAmount / 10))).then((result) => setProfile(result.profile)).catch(() => {})
  }

  // --- Админ-действия ---
  async function adminGive() {
    const username = adminGiveUsername.trim().replace(/^@/, '')
    const amount = Number(adminGiveAmount)
    if (!username) { setAdminGiveMsg({ kind: 'error', text: 'Введите username игрока.' }); return }
    if (!Number.isFinite(amount) || amount === 0) { setAdminGiveMsg({ kind: 'error', text: 'Введите ненулевую сумму.' }); return }
    try {
      await api.adminGiveBalance(username, adminGiveCurrency, amount)
      setAdminGiveMsg({ kind: 'success', text: `Готово: ${amount > 0 ? 'начислено' : 'списано'} ${Math.abs(amount)} ${adminGiveCurrency} игроку @${username}.` })
      setAdminGiveUsername('')
    } catch (error) {
      setAdminGiveMsg({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось начислить баланс.' })
    }
  }

  async function adminBan() {
    const username = adminBanUsername.trim().replace(/^@/, '')
    if (!username) { setAdminBanMsg({ kind: 'error', text: 'Введите username игрока.' }); return }
    try {
      await api.adminBan(username, adminBanReason.trim())
      setAdminBanMsg({ kind: 'success', text: `Игрок @${username} забанен.` })
      setAdminBanUsername('')
      setAdminBanReason('')
    } catch (error) {
      setAdminBanMsg({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось забанить.' })
    }
  }

  async function adminUnban() {
    const username = adminBanUsername.trim().replace(/^@/, '')
    if (!username) { setAdminBanMsg({ kind: 'error', text: 'Введите username игрока.' }); return }
    try {
      await api.adminUnban(username)
      setAdminBanMsg({ kind: 'success', text: `Игрок @${username} разбанен.` })
      setAdminBanUsername('')
      setAdminBanReason('')
    } catch (error) {
      setAdminBanMsg({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось разбанить.' })
    }
  }

  async function adminLoadWithdrawals() {
    setAdminWithdrawalsLoading(true)
    setAdminWithdrawalsMsg(null)
    try {
      const result = await api.adminWithdrawals()
      setAdminWithdrawals(result.withdrawals)
    } catch (error) {
      setAdminWithdrawalsMsg({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось загрузить заявки.' })
    } finally {
      setAdminWithdrawalsLoading(false)
    }
  }

  async function adminResolveWithdrawal(code: string, status: 'approved' | 'rejected') {
    try {
      await api.adminSetWithdrawal(code, status)
      setAdminWithdrawals((list) => list.filter((item) => item.code !== code))
      setAdminWithdrawalsMsg({ kind: 'success', text: `Заявка ${code}: ${status === 'approved' ? 'одобрена' : 'отклонена'}.` })
    } catch (error) {
      setAdminWithdrawalsMsg({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось обновить заявку.' })
    }
  }

  async function copyReferralLink() {
    try {
      await navigator.clipboard.writeText(referralLink)
      setReferralFeedback('Ссылка скопирована. Переход засчитается, когда её откроют.')
    } catch {
      setReferralFeedback('Не удалось скопировать автоматически. Скопируй ссылку из поля выше.')
    }
  }

  async function shareReferralLink() {
    if (!navigator.share) {
      await copyReferralLink()
      return
    }

    try {
      await navigator.share({ title: 'Приглашение в BUDZEN', text: 'Заходи в BUDZEN!', url: referralLink })
      setReferralFeedback('Приглашение отправлено. Переход засчитается после открытия ссылки.')
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      setReferralFeedback('Не удалось открыть меню отправки. Скопируй ссылку вручную.')
    }
  }

    async function buyBcStars() {
    // Реальная оплата через Telegram Stars: получаем invoice-ссылку и открываем платёжное окно.
    const tg = (window as Window & {
      Telegram?: { WebApp?: { openInvoice?: (url: string, cb?: (status: string) => void) => void; initDataUnsafe?: { user?: TelegramUser } } }
    }).Telegram?.WebApp
    if (!tg?.openInvoice) {
      setPurchaseFeedback({ kind: 'error', text: 'Оплата Stars доступна только внутри Telegram. Откройте приложение в Telegram.' })
      return
    }
    const amountBc = Number(purchaseBcAmount)
    if (!Number.isFinite(amountBc) || amountBc <= 0) {
      setPurchaseFeedback({ kind: 'error', text: 'Укажите сумму BC больше нуля.' })
      return
    }
    setPurchaseFeedback(null)
    try {
      const { invoiceLink, bc } = await api.buyStars(amountBc)
      tg.openInvoice(invoiceLink, (status) => {
        if (status === 'paid') {
          // Начисление делает бот (successful_payment). Подтягиваем актуальный профиль.
          setPurchaseFeedback({ kind: 'success', text: `Оплата прошла! Начислено ${formatBalance(bc)} BC.` })
          void api.auth().then((r) => setProfile(r.profile)).catch(() => {})
        } else if (status === 'failed') {
          setPurchaseFeedback({ kind: 'error', text: 'Оплата не прошла. Попробуйте ещё раз.' })
        }
        // 'cancelled' — пользователь закрыл окно, молчим.
      })
    } catch (error) {
      setPurchaseFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Не удалось создать счёт.' })
    }
  }

  function submitTopUp() {
    // Код пока не связан с реальными партнёрами — показываем заглушку.
    setTopUpMessage('Партнёры скоро появятся. Следите за обновлениями!')
  }

  async function submitWithdrawal() {
    const amount = Number(withdrawalAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawalFeedback({ kind: 'error', text: 'Укажи сумму больше нуля.' })
      return
    }
    if (amount > withdrawalAvailable) {
      setWithdrawalFeedback({ kind: 'error', text: `Сумма больше доступного баланса ${withdrawalCurrency}.` })
      return
    }

    setWithdrawalSubmitting(true)
    setWithdrawalFeedback(null)
    try {
      const result = await api.createWithdrawal(amount, withdrawalCurrency)
      if (result.profile) {
        setProfile(result.profile)
        setCurrencyBalances({ A: result.profile.balanceA, B: result.profile.balanceB })
      }
      setWithdrawalRequests((requests) => [result.withdrawal, ...(requests ?? [])].slice(0, 50))
      setGeneratedWithdrawalCode(result.withdrawal.code)
      setWithdrawalAmount('')
      setWithdrawalFeedback({ kind: 'success', text: `Ваш код: ${result.withdrawal.code}. Вставьте его в бота получателя.` })
    } catch (error) {
      setGeneratedWithdrawalCode(null)
      setWithdrawalFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'API вывода недоступно.' })
    } finally {
      setWithdrawalSubmitting(false)
    }
  }

  async function copyGeneratedWithdrawalCode() {
    if (!generatedWithdrawalCode) return

    try {
      await navigator.clipboard.writeText(generatedWithdrawalCode)
      setWithdrawalFeedback({ kind: 'success', text: `Код ${generatedWithdrawalCode} скопирован.` })
    } catch {
      setWithdrawalFeedback({ kind: 'error', text: 'Не удалось скопировать код автоматически.' })
    }
  }

  function handleProfileAvatarChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setProfileAvatarError('Выберите файл изображения.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileAvatarError('Размер аватара не должен превышать 2 МБ.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setProfileAvatar(reader.result)
        setProfileAvatarError('')
      }
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  async function startCrash() {
    const wager = Number(crashStake)
    if (crashPhase === 'running') return
    if (!Number.isFinite(wager) || wager <= 0) {
      setCrashError('Введите ставку больше нуля.')
      return
    }
    if (wager > demoBalance) {
      setCrashError('Недостаточно BC для этой ставки.')
      return
    }

    // Оптимистичный старт: запускаем анимацию СРАЗУ, не дожидаясь ответа сервера.
    // Ставка на момент отображения рассчитывается локально, а реальную точку краша
    // подставим, как только сервер ответит.
    setCrashError('')
    setCrashPayout(0)
    setCrashBet(wager)
    setCrashMultiplier(1)
    setCrashElapsed(0)
    setCrashPoint(Number.POSITIVE_INFINITY)
    crashLocked.current = false
    crashVisibleMultiplier.current = 1
    pendingCashout.current = null
    crashStartedAt.current = performance.now()
    setCrashPhase('running')

    try {
      const result = await api.crashStart(wager)
      setProfile(result.profile)
      // Применяем настоящую точку краша. Если за это время уже «уехали» дальше неё —
      // цикл анимации тут же зафиксирует краш.
      setCrashPoint(result.crashPoint)
    } catch (error) {
      // Сервер отклонил старт — откатываем раунд и возвращаем блокировку.
      setCrashPhase('ready')
      setCrashElapsed(0)
      setCrashMultiplier(1)
      setCrashError(error instanceof Error ? error.message : 'Не удалось начать заезд.')
    }
  }

  async function cashOutCrash() {
    if (crashPhase !== 'running') return
    // Если сервер ещё не прислал точку краша (редко, при медленной сети) — он ещё
    // НЕ сохранил заезд, поэтому запрос кашинга сейчас вернёт ошибку. Вместо этого
    // замораживаем анимацию на видимом значении и запоминаем намерение: кашинг
    // выполнится сразу, как только придёт crashPoint (эффект ниже).
    if (!Number.isFinite(crashPoint)) {
      const pending = crashVisibleMultiplier.current
      crashLocked.current = true
      pendingCashout.current = pending
      setCrashElapsed(Math.log(pending) / 0.18)
      setCrashMultiplier(pending)
      return
    }

    // Берём ровно то значение, что видно на экране прямо сейчас.
    // Не пересчитываем по времени — иначе рассинхрон до 40 мс может дать
    // множитель выше экранного и сервер засчитает краш (проигрыш).
    await settleCashout(crashVisibleMultiplier.current)
  }

  // Фиксирует выплату по конкретному (экранному) множителю и синхронизируется с сервером.
  async function settleCashout(visibleMultiplier: number) {
    setCrashError('')

    if (visibleMultiplier >= crashPoint) {
      crashLocked.current = true
      crashVisibleMultiplier.current = crashPoint
      setCrashElapsed(Math.log(crashPoint) / 0.18)
      setCrashMultiplier(crashPoint)
      setCrashHistory((history) => [{ multiplier: crashPoint, outcome: 'crashed' as const }, ...history].slice(0, 8))
      setCrashPhase('crashed')
      return
    }

    // СИНХРОННО замораживаем анимацию на видимом значении.
    crashLocked.current = true
    setCrashElapsed(Math.log(visibleMultiplier) / 0.18)
    setCrashMultiplier(visibleMultiplier)

    // Оптимистично фиксируем результат на экране сразу, не дожидаясь ответа сервера.
    const estimatedPayout = Number((crashBet * visibleMultiplier).toFixed(2))
    setCrashPayout(estimatedPayout)
    setCrashHistory((history) => [{ multiplier: visibleMultiplier, outcome: 'cashed' as const }, ...history].slice(0, 8))
    setCrashPhase('cashed')

    try {
      const result = await api.crashCashout(visibleMultiplier)
      setProfile(result.profile)
      setCrashPayout(result.payout)
      // Сервер мог зафиксировать краш (если успели ровно на границе) — обновим экран.
      if (result.crashed) {
        setCrashPhase('crashed')
        setCrashPayout(0)
      }
    } catch (error) {
      // Если сервер отклонил выплату — возвращаемся в готовность и показываем ошибку.
      crashLocked.current = true
      setCrashPhase('ready')
      setCrashPayout(0)
      setCrashError(error instanceof Error ? error.message : 'Не удалось забрать выигрыш.')
    }
  }

  // Если пользователь забанен — показываем заглушку и блокируем всё приложение.
  if (profile?.isBanned) {
    return (
      <main className="app">
        <section className="ban-screen">
          <div className="ban-emblem" aria-hidden="true">⛔</div>
          <h1>Вы забанены</h1>
          <p>{profile.banReason ? `Причина: ${profile.banReason}` : 'Доступ к приложению ограничен администратором.'}</p>
          <span className="ban-note">Если вы считаете это ошибкой — свяжитесь с поддержкой.</span>
        </section>
      </main>
    )
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">B</div>
          <div>
            <div className="brand-name">BUDZEN</div>
            <div className="brand-caption">GAME CURRENCY EXCHANGE</div>
          </div>
        </div>
        <div className="topbar-right">
          {isAdmin && (
            <button
              className="admin-gear-button"
              onClick={() => setTab('Админ')}
              aria-label="Админ-панель"
              title="Админ-панель"
            >
              ⚙
            </button>
          )}
          <div className="header-balance">
            <img src="/logo.svg" alt="" />
            <div className="header-balance-copy">
              <strong>{formatBalance(demoBalance)} BC</strong>
              <small>BUDDA COINS (BC)</small>
            </div>
            <button className="header-buy-button" onClick={() => setTab('Покупка BC')} aria-label="Купить BC" title="Купить BC">+</button>
          </div>
        </div>
      </header>

      {tab === 'Главная' && (
        <>
          <section className="welcome">
            <div className="eyebrow"><span className="live-dot" /> YOUR DIGITAL ECONOMY</div>
            <h1>Твоя игровая<br /><span>империя.</span></h1>
            <p>Все игровые валюты в одном месте.<br />Обменивай. Собирай. Развивайся.</p>
            <div className="welcome-glow" />
          </section>

          <section className="balance-card">
            <div className="balance-top">
              <span>ОБЩИЙ БАЛАНС</span>
              <span className="coin-label">✦ BUDDA COINS</span>
            </div>
            <div className="balance-value">{formatBalance(demoBalance)} <span>BC</span></div>
            <div className="balance-bottom">
              <span className="balance-note"><span className="live-dot" /> Демо-баланс</span>
              <button className="outline-button" onClick={() => setTab('Портфель')}>Мой портфель ↗</button>
            </div>
          </section>

          <div className="section-heading">
            <div><h2>Быстрые действия</h2><p>Что будем делать сегодня?</p></div>
          </div>
          <section className="actions">
            <button className="action-card primary-action" onClick={() => setTab('Обмен')}>
              <span className="action-icon">⇄</span><span className="action-title">Обменять</span><span className="action-subtitle">Обмен валют</span><span className="action-arrow">↗</span>
            </button>
            <button className="action-card" onClick={() => setTab('Курсы')}>
              <span className="action-icon">⌁</span><span className="action-title">Курсы</span><span className="action-subtitle">Динамика валют</span><span className="action-arrow">↗</span>
            </button>
            <button className="action-card" onClick={() => { setTransferFeedback(null); setTab('Перевод') }}>
              <span className="action-icon">↗</span><span className="action-title">Перевод</span><span className="action-subtitle">Другу по username/ID</span><span className="action-arrow">↗</span>
            </button>
            <button className="action-card" onClick={() => { setWithdrawalFeedback(null); setTab('Вывод BC') }}>
              <span className="action-icon">↗</span><span className="action-title">Вывод</span><span className="action-subtitle">Заявка на вывод A/B</span><span className="action-arrow">↗</span>
            </button>
            <button className="action-card" onClick={() => { setTopUpMessage(''); setTab('Пополнить') }}>
              <span className="action-icon">＋</span><span className="action-title">Пополнить</span><span className="action-subtitle">По коду партнёра</span><span className="action-arrow">↗</span>
            </button>
          </section>

          <div className="section-heading currencies-heading">
            <div><h2>Популярные валюты</h2><p>Валюта разных игровых ботов</p></div>
            <button className="text-button" onClick={() => setTab('Портфель')}>Все валюты ↗</button>
          </div>

          <section className="currency-list">
            {currencies.map((currency) => (
              <button className="currency-row" key={currency.ticker} onClick={() => { setSelectedTicker(currency.ticker); setTab('Курсы') }}>
                <span className="currency-icon" style={{ '--coin-color': currency.color } as React.CSSProperties}>{currency.icon}</span>
                <span className="currency-info"><strong>{currency.name}</strong><small>{currency.ticker}</small></span>
                <span className="currency-amount">{formatBalance(currencyBalances[currency.ticker])}<small>в демо-портфеле</small></span>
                <span className="row-arrow">›</span>
              </button>
            ))}
          </section>
        </>
      )}

      {tab === 'Обмен' && (
        <section className="section-view exchange-view">
          <div className="section-heading"><div><h2>Обмен</h2><p>Конвертация по текущему демо-курсу</p></div></div>
          <section className="exchange-panel">
            <div className="exchange-side">
              <div className="exchange-label-row">
                <label htmlFor="exchange-from-amount">Отдаёшь</label>
                <span>Баланс: {formatBalance(exchangeAvailable)} {exchangeFrom}</span>
              </div>
              <div className="exchange-input-row">
                <input id="exchange-from-amount" type="number" min="0" max={exchangeAvailable} value={exchangeAmount} onChange={(event) => { setExchangeAmount(event.target.value); setExchangeFeedback(null) }} />
                <select value={exchangeFrom} onChange={(event) => { setExchangeFrom(event.target.value as ExchangeTicker); setExchangeFeedback(null) }} aria-label="Валюта для обмена">
                  {exchangeAssets.map((asset) => <option value={asset.ticker} key={asset.ticker}>{asset.ticker}</option>)}
                </select>
                <button className="exchange-max-button" onClick={() => { setExchangeAmount(String(exchangeAvailable)); setExchangeFeedback(null) }}>MAX</button>
              </div>
              <small className="exchange-asset-name">{exchangeAssets.find((asset) => asset.ticker === exchangeFrom)?.name}</small>
            </div>

            <button className="exchange-swap" onClick={() => { setExchangeFrom(exchangeTo); setExchangeTo(exchangeFrom); setExchangeFeedback(null) }} aria-label="Поменять валюты местами">⇅</button>

            <div className="exchange-side receive-side">
              <div className="exchange-label-row"><label htmlFor="exchange-to-amount">Получаешь</label><span>Предварительный расчёт</span></div>
              <div className="exchange-input-row receive-row">
                <input id="exchange-to-amount" type="text" value={Number.isFinite(exchangeReceive) ? formatBalance(exchangeReceive) : '0'} readOnly />
                <select value={exchangeTo} onChange={(event) => { setExchangeTo(event.target.value as ExchangeTicker); setExchangeFeedback(null) }} aria-label="Получаемая валюта">
                  {exchangeAssets.map((asset) => <option value={asset.ticker} key={asset.ticker}>{asset.ticker}</option>)}
                </select>
              </div>
              <small className="exchange-asset-name">{exchangeAssets.find((asset) => asset.ticker === exchangeTo)?.name}</small>
            </div>

            <div className="exchange-rate-line"><span>Курс</span><strong>1 {exchangeFrom} = {formatBalance(exchangeRate)} {exchangeTo}</strong></div>
            {exchangeFeedback && <p className={`exchange-feedback ${exchangeFeedback.kind}`} role={exchangeFeedback.kind === 'error' ? 'alert' : 'status'}>{exchangeFeedback.text}</p>}
            <button className="game-action-button exchange-submit" onClick={executeExchange} disabled={exchangeBusy || exchangeFrom === exchangeTo || !Number.isFinite(exchangeReceive) || exchangeReceive <= 0}>{exchangeBusy ? 'Обмен…' : 'Обменять'}</button>
          </section>

          <div className="section-heading history-heading"><div><h2>История обменов</h2><p>Последние операции</p></div></div>
          {exchangeHistory.length > 0
            ? <div className="history-list">{exchangeHistory.map((item, index) => (
              <article className="history-row" key={`${item.createdAt}-${index}`}>
                <div className="history-main">
                  <strong>{formatBalance(item.amount)} {item.from} → {formatBalance(item.received)} {item.to}</strong>
                  <small>{formatHistoryDate(item.createdAt)} · курс {formatBalance(item.rate)}</small>
                </div>
              </article>
            ))}</div>
            : <p className="history-empty">Обменов пока нет.</p>}
        </section>
      )}

      {tab === 'Перевод' && (
        <section className="section-view exchange-view">
          <div className="section-heading"><div><h2>Перевод</h2><p>Отправка BC другому пользователю</p></div></div>
          <section className="economy-card transfer-card">
            <div className="withdrawal-available"><span>Доступно</span><strong>{formatBalance(transferAvailable)} BC</strong></div>
            <label className="game-field-label" htmlFor="transfer-recipient">Получатель</label>
            <div className="exchange-input-row">
              <input id="transfer-recipient" type="text" placeholder="@username или ID" value={transferRecipient} onChange={(event) => { setTransferRecipient(event.target.value); setTransferFeedback(null) }} />
            </div>
            <label className="game-field-label" htmlFor="transfer-amount">Сумма перевода</label>
            <div className="withdrawal-input-row">
              <input id="transfer-amount" type="number" min="0.01" step="0.01" value={transferAmount} onChange={(event) => { setTransferAmount(event.target.value); setTransferFeedback(null) }} />
              <button className="stake-max-button" onClick={() => setTransferAmount(String(Math.max(0, Number((transferAvailable / (1 + transferFeeRate)).toFixed(2)))))} disabled={transferAvailable <= 0}>MAX</button>
              <span>BC</span>
            </div>
            <div className="exchange-rate-line"><span>Комиссия (2%)</span><strong>{formatBalance(transferFee)} BC</strong></div>
            <div className="exchange-rate-line"><span>Спишется всего</span><strong>{formatBalance(transferTotal)} BC</strong></div>
            {transferFeedback && <p className={`exchange-feedback ${transferFeedback.kind}`} role={transferFeedback.kind === 'error' ? 'alert' : 'status'}>{transferFeedback.text}</p>}
            <button className="game-action-button" onClick={submitTransfer} disabled={transferAvailable <= 0 || !Number.isFinite(transferValue) || transferValue <= 0}>Перевести</button>
            <p className="economy-note">Перевод выполняется в демо-режиме. Комиссия — 2% от суммы перевода.</p>
          </section>

          <div className="section-heading history-heading"><div><h2>История переводов</h2><p>Отправленные и полученные</p></div></div>
          {transferHistory.length > 0
            ? <div className="history-list">{transferHistory.map((item, index) => (
              <article className="history-row" key={`${item.createdAt}-${index}`}>
                <span className={item.direction === 'in' ? 'history-badge in' : 'history-badge out'}>{item.direction === 'in' ? '↓' : '↑'}</span>
                <div className="history-main">
                  <strong>{item.direction === 'in' ? '+' : '−'}{formatBalance(item.amount)} BC · {item.direction === 'in' ? 'от' : 'для'} {item.counterpartyId}</strong>
                  <small>{formatHistoryDate(item.createdAt)}{item.direction === 'out' ? ` · комиссия ${formatBalance(item.fee)} BC` : ''}</small>
                </div>
              </article>
            ))}</div>
            : <p className="history-empty">Переводов пока нет.</p>}
        </section>
      )}

      {tab === 'Вывод BC' && (
        <section className="section-view economy-view">
          <div className="section-heading"><div><h2>Вывод</h2><p>Создание заявки на вывод A или B</p></div></div>
          <section className="economy-card withdrawal-card">
            <label className="game-field-label" htmlFor="withdrawal-currency">Валюта</label>
            <div className="rate-switcher" role="group" aria-label="Валюта для вывода">
              {currencies.map((currency) => (
                <button
                  className={withdrawalCurrency === currency.ticker ? 'rate-option active' : 'rate-option'}
                  key={currency.ticker}
                  onClick={() => { setWithdrawalCurrency(currency.ticker); setWithdrawalFeedback(null) }}
                  aria-pressed={withdrawalCurrency === currency.ticker}
                >
                  {currency.name} <small>({currency.ticker})</small>
                </button>
              ))}
            </div>
            <div className="withdrawal-available"><span>Доступно</span><strong>{formatBalance(withdrawalAvailable)} {withdrawalCurrency}</strong></div>
            <label className="game-field-label" htmlFor="withdrawal-amount">Сумма вывода</label>
            <div className="withdrawal-input-row">
              <input id="withdrawal-amount" type="number" min="0.01" max={withdrawalAvailable} step="0.01" value={withdrawalAmount} onChange={(event) => { setWithdrawalAmount(event.target.value); setWithdrawalFeedback(null) }} />
              <button className="stake-max-button" onClick={() => setWithdrawalAmount(String(withdrawalAvailable))} disabled={withdrawalAvailable <= 0}>MAX</button>
              <span>{withdrawalCurrency}</span>
            </div>

            {generatedWithdrawalCode ? (
              <div className="withdrawal-code-panel">
                <span className="withdrawal-code-label">Ваш код</span>
                <div className="withdrawal-code-box">{generatedWithdrawalCode}</div>
                <p className="withdrawal-code-instruction">Введите этот код в боте получателя, чтобы получить валюту</p>
                <button className="game-action-button" onClick={copyGeneratedWithdrawalCode}>Скопировать</button>
              </div>
            ) : (
              <>
                <p className="withdrawal-disclaimer">Заявка сохраняется в локальной базе со статусом «Ожидает». Автоматический перевод не подключён.</p>
                {withdrawalFeedback && <p className={`withdrawal-feedback ${withdrawalFeedback.kind}`} role={withdrawalFeedback.kind === 'error' ? 'alert' : 'status'}>{withdrawalFeedback.text}</p>}
                <button className="game-action-button" onClick={submitWithdrawal} disabled={withdrawalSubmitting || withdrawalAvailable <= 0}>
                  {withdrawalSubmitting ? 'Создаём заявку…' : 'Создать заявку'}
                </button>
              </>
            )}
          </section>
          <div className="section-heading withdrawal-history-heading"><div><h2>История заявок</h2></div></div>
          {withdrawalRequests === null
            ? <p className="withdrawal-empty">Загружаем заявки…</p>
            : withdrawalRequests.length > 0
              ? <div className="withdrawal-list">{withdrawalRequests.map((request) => {
                const createdDate = typeof request.createdAt === 'string'
                  ? new Date(request.createdAt.includes('T') ? request.createdAt : `${request.createdAt.replace(' ', 'T')}Z`)
                  : new Date()

                return (
                  <article className="withdrawal-row" key={request.code}>
                    <div><strong>{request.code}</strong><small>{Number.isNaN(createdDate.getTime()) ? '—' : createdDate.toLocaleString('ru-RU')}</small></div>
                    <div><strong>{formatBalance(request.amount)} {request.currency}</strong><small className={`withdrawal-status ${request.status}`}>{request.status === 'pending' ? 'В ожидании' : request.status === 'approved' || request.status === 'paid' ? 'Выведено' : 'Отклонено'}</small></div>
                  </article>
                )
              })}</div>
              : <p className="withdrawal-empty">Заявок пока нет.</p>}
        </section>
      )}

      {tab === 'Игры' && (
        <section className="section-view">
          <div className="section-heading"><div><h2>Игры</h2><p>Выбери игровой режим</p></div></div>
          <div className="section-links">
            {games.map((game) => {
              const unavailable = game === 'Батл'
              return (
                <button className={unavailable ? 'section-link unavailable' : 'section-link'} key={game} onClick={() => setTab(game)} disabled={unavailable}>
                  <span className="game-link-copy"><strong>{game}</strong>{unavailable && <small>В разработке</small>}</span>
                  {!unavailable && <span>↗</span>}
                </button>
              )
            })}
          </div>
        </section>
      )}

      {games.includes(tab) && (
        <section className="section-view game-screen">
          <button className="back-link" onClick={() => setTab('Игры')}>‹ Все игры</button>
          <div className="section-heading game-heading"><div><h2>{tab}</h2></div></div>

          {tab === 'Апгрейдер' && (
            <section className="game-panel">
              <div className="upgrade-game-details">
                {demoBalance < 1 && <button className="demo-refill-button" onClick={refillDemoBalance}>Пополнить демо-баланс до 1 000 BC</button>}
                <div className="upgrade-multiplier"><span>Выплата при успехе</span><strong>{(100 / selectedChance).toFixed(2)}×</strong></div>
                <label className="game-field-label" htmlFor="upgrader-stake">Ставка</label>
                <div className="game-stake-field"><input id="upgrader-stake" type="number" min="1" max={demoBalance} value={upgradeStake} onChange={(event) => setUpgradeStake(event.target.value)} disabled={upgradeSpinning} /><button className="stake-max-button" onClick={() => setUpgradeStake(String(demoBalance))} disabled={demoBalance < 1 || upgradeSpinning}>MAX</button><span>BC</span></div>
                <div className="chance-heading">
                  <label className="game-field-label" htmlFor="upgrader-chance">Шанс успеха</label>
                  <div className="chance-entry">
                    <input
                      id="upgrader-chance"
                      type="text"
                      inputMode="numeric"
                      maxLength={2}
                      pattern="[0-9]{0,2}"
                      value={chanceEntry}
                      onChange={(event) => {
                        const value = event.target.value.replace(/\D/g, '').slice(0, 2)
                        const chance = Number(value)
                        setChanceEntry(value)
                        if (value && chance >= 1) {
                          const boundedChance = Math.min(maxUpgradeChance, chance)
                          setChanceEntry(String(boundedChance))
                          setSelectedChance(boundedChance)
                        }
                      }}
                      disabled={upgradeSpinning}
                      aria-label={`Свой шанс успеха от 1 до ${maxUpgradeChance} процентов`}
                    />
                    <span>%</span>
                  </div>
                </div>
                <div className="chance-options" role="group" aria-label="Шанс успеха">
                  {upgradeChances.map((chance) => (
                    <button className={selectedChance === chance ? 'chance-option active' : 'chance-option'} key={chance} onClick={() => { setSelectedChance(chance); setChanceEntry(String(chance)) }} aria-pressed={selectedChance === chance} disabled={upgradeSpinning}>
                      {chance}%
                    </button>
                  ))}
                </div>

                <div className="upgrade-wheel-wrap">
                  <button
                    className={fastSpinEnabled ? 'spin-mode-toggle active' : 'spin-mode-toggle'}
                    onClick={() => setFastSpinEnabled((enabled) => !enabled)}
                    disabled={upgradeSpinning}
                    aria-pressed={fastSpinEnabled}
                    aria-label={fastSpinEnabled ? 'Выключить быстрый режим, 1,5 секунды' : 'Включить быстрый режим, 1,5 секунды'}
                    title={fastSpinEnabled ? 'Быстро: 1,5 сек' : 'Долго: 6 сек'}
                  >
                    <span aria-hidden="true">⚡</span>
                    <small>{fastSpinEnabled ? '1,5 с' : '6 с'}</small>
                  </button>
                  <div className="upgrade-wheel" aria-label={`Шанс апгрейда ${selectedChance}%`}>
                    <svg viewBox="0 0 320 320" role="img" aria-hidden="true">
                      <defs>
                        <linearGradient id="upgrade-ring-gradient" x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor="#bd8aff" />
                          <stop offset="100%" stopColor="#e8b94e" />
                        </linearGradient>
                      </defs>
                      <g className="upgrade-wheel-motion">
                        <circle cx="160" cy="160" r="137" className="upgrade-wheel-ticks" />
                                                <circle cx="160" cy="160" r="116" className="upgrade-wheel-track" />
                        <path
                          d={upgradeArcPath(selectedChance)}
                          className="upgrade-wheel-chance"
                          fill="none"
                          stroke="url(#upgrade-ring-gradient)"
                        />
                        <circle cx="160" cy="160" r="92" className="upgrade-wheel-center" />
                        <path d="M119 149 160 119l41 30v15l-41-30-41 30z" className="upgrade-chevron bright" />
                        <path d="M126 177 160 152l34 25v14l-34-25-34 25z" className="upgrade-chevron dim" />
                        <text x="160" y="223" className="upgrade-wheel-chance-label" textAnchor="middle">{selectedChance}%</text>
                      </g>
                                                                  <g transform={`rotate(${upgradeSpinAngle} 160 160)`}>
                        <path
                          d="m160 277-9 20 9-5 9 5z"
                          className="upgrade-wheel-pointer"
                        />
                      </g>
                    </svg>
                  </div>
                </div>

                <button className="game-action-button" onClick={playUpgrade} disabled={upgradeSpinning}>
                  {upgradeSpinning ? 'Прокрутка...' : 'Крутить'}
                </button>

                {upgradeError && <p className="upgrade-message error" role="alert">{upgradeError}</p>}
                {upgradeResult && (
                  <div className={upgradeResult.won ? 'upgrade-message success' : 'upgrade-message failure'} role="status">
                    <strong>{upgradeResult.won ? 'Успех!' : 'Не повезло'}</strong>
                    <span>{upgradeResult.won ? `Выплата ${formatBalance(upgradeResult.payout)} BC` : `Ставка ${formatBalance(upgradeResult.stake)} BC потеряна`}</span>
                  </div>
                )}
              </div>
              <div className="section-heading history-heading"><div><h2>История раундов</h2><p>Последние ставки</p></div></div>
              {upgradeHistory.length > 0
                ? <div className="history-list">{upgradeHistory.map((item, index) => (
                  <article className="history-row" key={`${item.createdAt}-${index}`}>
                    <div className="history-main">
                      <strong>{formatBalance(item.stake)} BC · шанс {item.detail.chance ?? '—'}%</strong>
                      <small>{formatHistoryDate(item.createdAt)}</small>
                    </div>
                    <span className={item.payout > 0 ? 'withdrawal-status paid' : 'withdrawal-status rejected'}>{item.payout > 0 ? `+${formatBalance(item.payout)} BC` : `−${formatBalance(item.stake)} BC`}</span>
                  </article>
                ))}</div>
                : <p className="history-empty">Раундов пока нет.</p>}
            </section>
          )}

          {tab === 'Краш' && (
            <section className="game-panel">
              <div className={`crash-scene ${crashPhase === 'running' ? 'is-running' : ''}`}>
                <div className="crash-scene-meta"><span>ГОРНЫЙ СПУСК</span><span>{(crashElapsed * 0.12).toFixed(2)} КМ</span></div>
                <div className={`crash-scene-multiplier ${crashPhase}`}>
                  {crashMultiplier.toFixed(2)}<small>×</small>
                </div>
                <svg viewBox={`${cameraX} 0 700 280`} preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="crash-sky" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#21182b" />
                      <stop offset="100%" stopColor="#111019" />
                    </linearGradient>
                    <linearGradient id="crash-ridge" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#382a46" />
                      <stop offset="100%" stopColor="#18141f" />
                    </linearGradient>
                  </defs>
                  <rect x="-200" width="3680" height="280" fill="url(#crash-sky)" />
                  <path className="crash-mountain-far" d="M0 190 64 112l36 35 73-91 88 102 63-67 91 75 86-113 104 112 55-52 80 91v76H0z" />
                  <path className="crash-mountain-far" d="M0 190 64 112l36 35 73-91 88 102 63-67 91 75 86-113 104 112 55-52 80 91v76H0z" transform="translate(700 0)" />
                  <path className="crash-mountain-near" d="m0 222 88-91 66 58 76-84 98 103 88-89 71 60 77-93 136 120v74H0z" fill="url(#crash-ridge)" />
                  <path className="crash-mountain-near" d="m0 222 88-91 66 58 76-84 98 103 88-89 71 60 77-93 136 120v74H0z" fill="url(#crash-ridge)" transform="translate(700 0)" />
                  <path className="crash-road-base" d={crashRoadPath} />
                  <path className="crash-road-dashes" d={crashRoadPath} />
                  <g className="crash-cyclist" transform={`translate(${cyclistX} ${cyclistY})`}>
                    <g transform="translate(-19 0)">
                      <g className="crash-bike-wheel">
                        <circle className="crash-wheel-tire" r="10" />
                        <path className="crash-wheel-spokes" d="M-8 0H8M0-8V8M-6-6 6 6M6-6-6 6" />
                      </g>
                    </g>
                    <g transform="translate(20 0)">
                      <g className="crash-bike-wheel">
                        <circle className="crash-wheel-tire" r="10" />
                        <path className="crash-wheel-spokes" d="M-8 0H8M0-8V8M-6-6 6 6M6-6-6 6" />
                      </g>
                    </g>
                    <path className="crash-bike-frame" d="m-19 0 11-16 9 16h19L8-17-8-16l28 16M-8-16l-4-7m17 6 7-1" />
                    <g className="crash-pedals">
                      <circle cx="0" cy="0" r="3" />
                      <path d="m0 0-8 7m16-14 5 2m-18 14-5-2" />
                    </g>
                    <g className="crash-rider">
                      <circle className="crash-rider-head" cx="1" cy="-37" r="6" />
                      <path className="crash-rider-helmet" d="M-5-39q6-10 13-1L7-36-5-37z" />
                      <path className="crash-rider-body" d="m0-30-10 13 8 8m3-21 10 8 7-10m-20 14-4 13m11-5 10 13" />
                    </g>
                  </g>
                </svg>
                <div className={`crash-scene-status ${crashPhase}`}>
                  {crashPhase === 'running' && 'Едь и забери выигрыш вовремя'}
                  {crashPhase === 'crashed' && `Краш на ${crashPoint.toFixed(2)}×`}
                  {crashPhase === 'cashed' && `Выплата ${formatBalance(crashPayout)} BC`}
                  {crashPhase === 'ready' && 'Набирай скорость по горной трассе'}
                </div>
              </div>
              <label className="game-field-label" htmlFor="crash-stake">Ставка</label>
              <div className="game-stake-field">
                <input id="crash-stake" type="number" min="1" max={demoBalance} value={crashStake} onChange={(event) => setCrashStake(event.target.value)} disabled={crashPhase === 'running'} />
                <button className="stake-max-button" onClick={() => setCrashStake(String(demoBalance))} disabled={demoBalance < 1 || crashPhase === 'running'}>MAX</button>
                <span>BC</span>
              </div>
              {crashError && <p className="upgrade-message error" role="alert">{crashError}</p>}
              <button className={crashPhase === 'running' ? 'game-action-button crash-cashout' : 'game-action-button'} onClick={crashPhase === 'running' ? cashOutCrash : demoBalance < 1 ? refillDemoBalance : startCrash}>
                {crashPhase === 'running'
                  ? `Забрать ${formatBalance(crashBet * crashMultiplier)} BC`
                  : demoBalance < 1 ? 'Восстановить демо-баланс' : crashPhase === 'ready' ? 'Начать заезд' : 'Новый заезд'}
              </button>
              <section className="crash-history" aria-label="История заездов">
                <div className="crash-history-heading"><strong>История заездов</strong><span>последние 8</span></div>
                {crashHistory.length > 0
                  ? <div className="crash-history-list">{crashHistory.map((round, index) => <span className={round.outcome === 'cashed' ? 'crash-history-item cashed' : 'crash-history-item crashed'} key={`${round.multiplier}-${index}`}>{round.multiplier.toFixed(2)}×</span>)}</div>
                  : <p className="crash-history-empty">Здесь появятся результаты заездов</p>}
              </section>

              <div className="section-heading history-heading"><div><h2>История ставок</h2><p>Последние заезды</p></div></div>
              {crashHistoryLog.length > 0
                ? <div className="history-list">{crashHistoryLog.map((item, index) => (
                  <article className="history-row" key={`${item.createdAt}-${index}`}>
                    <div className="history-main">
                      <strong>{formatBalance(item.stake)} BC · {item.detail.cashed ? `${formatBalance(item.detail.multiplier ?? 0)}×` : 'краш'}</strong>
                      <small>{formatHistoryDate(item.createdAt)}</small>
                    </div>
                    <span className={item.payout > 0 ? 'withdrawal-status paid' : 'withdrawal-status rejected'}>{item.payout > 0 ? `+${formatBalance(item.payout)} BC` : `−${formatBalance(item.stake)} BC`}</span>
                  </article>
                ))}</div>
                : <p className="history-empty">Заездов пока нет.</p>}
            </section>
          )}

          {tab === 'Батл' && (
            <section className="game-panel">
              <label className="game-field-label" htmlFor="battle-stake">Ставка</label>
              <div className="game-stake-field"><input id="battle-stake" type="number" min="1" placeholder="Введите сумму" /><span>BC</span></div>
              <button className="game-action-button">Найти соперника</button>
            </section>
          )}
        </section>
      )}

      {tab === 'Админ' && isAdmin && (
        <section className="section-view admin-view">
          <div className="section-heading"><div><h2>Админ-панель</h2><p>Управление игроками и заявками</p></div></div>

          {/* Форма 1: выдать баланс */}
          <section className="economy-card admin-card">
            <h3>Выдать баланс</h3>
            <label className="game-field-label" htmlFor="admin-give-id">Username (тег)</label>
            <div className="exchange-input-row">
              <input id="admin-give-id" type="text" autoCapitalize="none" autoCorrect="off" placeholder="budda677 (без @)" value={adminGiveUsername} onChange={(event) => { setAdminGiveUsername(event.target.value); setAdminGiveMsg(null) }} />
            </div>
            <label className="game-field-label" htmlFor="admin-give-currency">Валюта</label>
            <select id="admin-give-currency" className="admin-select" value={adminGiveCurrency} onChange={(event) => setAdminGiveCurrency(event.target.value as 'BC' | 'A' | 'B')}>
              <option value="BC">BC</option>
              <option value="A">A (ALPHA)</option>
              <option value="B">B (BETA)</option>
            </select>
            <label className="game-field-label" htmlFor="admin-give-amount">Сумма</label>
            <div className="exchange-input-row">
              <input id="admin-give-amount" type="number" value={adminGiveAmount} onChange={(event) => { setAdminGiveAmount(event.target.value); setAdminGiveMsg(null) }} />
            </div>
            {adminGiveMsg && <p className={`exchange-feedback ${adminGiveMsg.kind}`} role={adminGiveMsg.kind === 'error' ? 'alert' : 'status'}>{adminGiveMsg.text}</p>}
            <button className="game-action-button" onClick={adminGive}>Начислить</button>
          </section>

          {/* Форма 2: забанить / разбанить */}
          <section className="economy-card admin-card">
            <h3>Забанить / Разбанить</h3>
            <label className="game-field-label" htmlFor="admin-ban-id">Username (тег)</label>
            <div className="exchange-input-row">
              <input id="admin-ban-id" type="text" autoCapitalize="none" autoCorrect="off" placeholder="budda677 (без @)" value={adminBanUsername} onChange={(event) => { setAdminBanUsername(event.target.value); setAdminBanMsg(null) }} />
            </div>
            <label className="game-field-label" htmlFor="admin-ban-reason">Причина</label>
            <div className="exchange-input-row">
              <input id="admin-ban-reason" type="text" placeholder="Причина бана" value={adminBanReason} onChange={(event) => { setAdminBanReason(event.target.value); setAdminBanMsg(null) }} />
            </div>
            {adminBanMsg && <p className={`exchange-feedback ${adminBanMsg.kind}`} role={adminBanMsg.kind === 'error' ? 'alert' : 'status'}>{adminBanMsg.text}</p>}
            <div className="admin-ban-actions">
              <button className="game-action-button admin-ban-btn" onClick={adminBan}>Забанить</button>
              <button className="game-action-button admin-unban-btn" onClick={adminUnban}>Разбанить</button>
            </div>
          </section>

          {/* Форма 3: заявки на вывод */}
          <section className="economy-card admin-card">
            <div className="admin-withdrawals-head">
              <h3>Заявки на вывод</h3>
              <button className="text-button" onClick={adminLoadWithdrawals} disabled={adminWithdrawalsLoading}>{adminWithdrawalsLoading ? 'Загрузка…' : 'Обновить'}</button>
            </div>
            {adminWithdrawalsMsg && <p className={`exchange-feedback ${adminWithdrawalsMsg.kind}`} role={adminWithdrawalsMsg.kind === 'error' ? 'alert' : 'status'}>{adminWithdrawalsMsg.text}</p>}
            {adminWithdrawals.length > 0 ? (
              <div className="admin-withdrawals-list">
                {adminWithdrawals.map((item) => (
                  <article className="admin-withdrawal-row" key={item.code}>
                    <div className="admin-withdrawal-info">
                      <strong>{item.code}</strong>
                      <small>ID {item.userId} · {formatBalance(item.amount)} {item.currency}</small>
                    </div>
                    <div className="admin-withdrawal-actions">
                      <button className="admin-approve-btn" onClick={() => adminResolveWithdrawal(item.code, 'approved')}>Одобрить</button>
                      <button className="admin-reject-btn" onClick={() => adminResolveWithdrawal(item.code, 'rejected')}>Отклонить</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="history-empty">{adminWithdrawalsLoading ? 'Загружаем…' : 'Нажмите «Обновить», чтобы загрузить pending-заявки.'}</p>
            )}
          </section>
        </section>
      )}

      {tab === 'Активность' && (
        <section className="section-view activity-view">
          <div className="section-heading"><div><h2>Активность</h2><p>Награды, задания и события</p></div></div>
          <div className="section-links">
            {activitySections.map((item) => (
              <button className="section-link activity-link" key={item} onClick={() => setTab(item)}>
                <span className="activity-link-copy"><strong>{item}</strong>{item === 'История' && <small>Все операции</small>}{item === 'Рефералы' && <small>Приглашай друзей</small>}{item === 'Партнёры' && <small>В разработке</small>}</span>
                <span>↗</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {tab === 'Достижения' && (
        <section className="section-view activity-view achievements-view">
          <div className="section-heading">
            <div><h2>Достижения</h2><p>Открыто {unlockedAchievements} из {achievements.length}</p></div>
          </div>
          <div className="achievement-list">
            {achievements.map((achievement) => {
              const unlocked = achievement.progress >= achievement.target
              const progress = Math.min(100, achievement.progress / achievement.target * 100)
              return (
                <article className={unlocked ? 'achievement-card unlocked' : 'achievement-card'} key={achievement.title}>
                  <span className="achievement-emblem" aria-hidden="true">✦</span>
                  <div className="achievement-copy">
                    <div className="achievement-title-row"><h3>{achievement.title}</h3><span>{unlocked ? 'Открыто' : `${formatBalance(achievement.progress)} / ${formatBalance(achievement.target)}`}</span></div>
                    <p>{achievement.description}</p>
                    <div className="achievement-progress"><span style={{ width: `${progress}%` }} /></div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {tab === 'Рефералы' && (
        <section className="section-view economy-view referral-view">
          <div className="section-heading"><div><h2>Приглашай друзей</h2><p>Поделись ссылкой на BUDZEN</p></div></div>
          <section className="economy-card referral-card">
            <div className="referral-summary">
              <span className="referral-icon" aria-hidden="true">↗</span>
              <div><strong>{referralVisits}</strong><small>переходов по ссылке</small></div>
            </div>
            <div className="referral-code-row"><span>Твой код</span><strong>{referralCode}</strong></div>
            <label className="game-field-label" htmlFor="referral-link">Персональная ссылка</label>
            <div className="referral-link-field">
              <input id="referral-link" value={referralLink} readOnly onFocus={(event) => event.currentTarget.select()} />
              <button className="stake-max-button" onClick={copyReferralLink}>Копировать</button>
            </div>
            <button className="game-action-button" onClick={shareReferralLink}>Пригласить друга</button>
            {referralFeedback && <p className="referral-feedback" role="status">{referralFeedback}</p>}
            <p className="economy-note">Счётчик и отметка квеста работают в демо-режиме в браузере, где открыли ссылку. Общий счётчик переходов между устройствами требует сервера.</p>
          </section>
        </section>
      )}

      {tab === 'Партнёры' && (
        <section className="notice-panel">
          <div className="notice-symbol">✦</div>
          <div><strong>Партнёры</strong><p>Партнёрская программа пока в разработке.</p></div>
          <button onClick={() => setTab('Активность')}>К активности</button>
        </section>
      )}

      {tab === 'Профиль' && (
        <section className="section-view profile-view">
          <div className="section-heading"><div><h2>Профиль</h2><p>Данные аккаунта и статистика</p></div></div>
          <section className="profile-card">
            <div className="profile-identity-row">
              <label className="profile-avatar-picker" htmlFor="profile-avatar-file" title="Поставить свою аватарку">
                <span className="profile-avatar">
                  {profileAvatar ? <img src={profileAvatar} alt="Аватар профиля" /> : telegramIdentity.name.slice(0, 1).toUpperCase()}
                </span>
                <input
                  id="profile-avatar-file"
                  type="file"
                  accept="image/*"
                  onChange={handleProfileAvatarChange}
                  aria-label="Выбрать свою аватарку"
                />
                <small>Изменить фото</small>
              </label>
              <div className="profile-identity-copy">
                <h3>{telegramIdentity.name}</h3>
                <span>{telegramIdentity.username}</span>
              </div>
              <button
                className="profile-settings-button"
                onClick={() => setProfileSettingsOpen((open) => !open)}
                aria-label="Настройки профиля"
                aria-expanded={profileSettingsOpen}
                title="Настройки"
              >
                ⚙
              </button>
            </div>

            {profileAvatarError && <p className="profile-avatar-error" role="alert">{profileAvatarError}</p>}
            {profileSettingsOpen && (
              <div className="profile-settings-panel">
                <strong>Настройки профиля</strong>
                <span>Имя и username загружаются из Telegram, если приложение открыто через Telegram.</span>
                <label htmlFor="profile-avatar-file">Выбрать другую аватарку</label>
              </div>
            )}

            <div className="profile-id-row"><span>ID</span><strong>{telegramIdentity.id}</strong></div>
            <div className="profile-level-panel">
              <div className="profile-level-heading"><strong>LVL 1</strong><span>24 / 250 XP</span></div>
              <div className="profile-xp-track"><span /></div>
            </div>
          </section>

          <div className="profile-stats" aria-label="Статистика профиля">
              <article className="profile-stat-card"><span>Баланс</span><strong>{formatBalance(demoBalance)} <small>BC</small></strong></article>
              <article className="profile-stat-card"><span>Выведено</span><strong>{formatBalance(profile?.totalSent ?? 0)} <small>BC</small></strong></article>
              <article className="profile-stat-card"><span>Пополнено</span><strong>{formatBalance(profile?.totalDeposited ?? 0)} <small>BC</small></strong></article>
          </div>
        </section>
      )}

      {tab === 'История' && (
        <section className="section-view history-view">
          <div className="section-heading"><div><h2>История</h2><p>Все операции в одном месте</p></div></div>
          <div className="history-filters" role="group" aria-label="Фильтр истории">
            {historyFilters.map((filter) => (
              <button
                className={historyFilter === filter.id ? 'history-filter active' : 'history-filter'}
                key={filter.id}
                onClick={() => setHistoryFilter(filter.id)}
                aria-pressed={historyFilter === filter.id}
              >
                <span aria-hidden="true">{filter.icon}</span>{filter.label}
              </button>
            ))}
          </div>

          {allHistory === null ? (
            <p className="history-empty">Загружаем историю…</p>
          ) : filteredHistory.length > 0 ? (
            <div className="history-list">
              {filteredHistory.map((item, index) => (
                <article className="history-row history-entry" key={`${item.createdAt}-${index}`}>
                  <span className={`history-entry-icon ${item.direction}`}>
                    {item.direction === 'in' ? '↓' : item.direction === 'out' ? '↑' : '⇄'}
                  </span>
                  <div className="history-main">
                    <strong>{item.title}</strong>
                    <small>{formatHistoryDate(item.createdAt)}{item.subtitle ? ` · ${item.subtitle}` : ''}</small>
                  </div>
                  <span className={`history-entry-amount ${item.direction}`}>
                    {item.direction === 'in' ? '+' : item.direction === 'out' ? '−' : ''}
                    {formatBalance(item.amount)} {item.currency}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <p className="history-empty">По этому фильтру операций пока нет.</p>
          )}
        </section>
      )}

      {tab === 'Ежедневный бонус' && (
        <section className="section-view economy-view">
          <div className="section-heading"><div><h2>Ежедневный бонус</h2><p>Отмечайся каждый день и сохраняй серию</p></div></div>
          <section className="economy-card daily-bonus-card">
            <div className="daily-reward-amount">{dailyClaimedToday ? 'Получено' : `+${nextDailyReward}`}<span>{dailyClaimedToday ? '' : ' BC'}</span></div>
            <div className="daily-reward-caption">{dailyClaimedToday ? 'Бонус за сегодня уже получен' : nextDailyReward === streakBonusAmount ? 'Награда за 7 дней подряд' : 'Ежедневный бонус'}</div>
            <div className="daily-streak-heading"><span>Серия входов</span><strong>{displayedStreak} / 7 дней</strong></div>
            <div className="daily-streak-days">
              {Array.from({ length: 7 }, (_, index) => (
                <span className={index < streakDay ? 'daily-streak-day complete' : 'daily-streak-day'} key={index}>{index + 1}</span>
              ))}
            </div>
            <p className="economy-note">10 BC за обычный вход · 50 BC за седьмой день серии. Получить можно один раз в день.</p>
            <button className="game-action-button" onClick={claimDailyBonus} disabled={!today || dailyClaimedToday}>
              {dailyClaimedToday ? 'Получено сегодня' : `Забрать ${nextDailyReward} BC`}
            </button>
          </section>

          <div className="section-heading history-heading"><div><h2>История бонусов</h2><p>Полученные награды</p></div></div>
          {bonusHistory.length > 0
            ? <div className="history-list">{bonusHistory.map((item, index) => (
              <article className="history-row" key={`${item.createdAt}-${index}`}>
                <div className="history-main">
                  <strong>+{formatBalance(item.amount)} BC</strong>
                  <small>{formatHistoryDate(item.createdAt)} · день серии {item.streakDay}</small>
                </div>
              </article>
            ))}</div>
            : <p className="history-empty">Бонусов пока нет.</p>}
        </section>
      )}

      {tab === 'Квесты' && (
        <section className="section-view economy-view">
          <div className="section-heading"><div><h2>Квесты</h2><p>Награда за каждый квест — 5 BC</p></div></div>
          <div className="quest-list">
            <article className="economy-card quest-card">
              <div className="quest-card-heading"><div><h3>Обменяй 1 000 BC</h3><p>Обменивай BC на любую игровую валюту</p></div><strong>+5 BC</strong></div>
              <div className="quest-progress-track"><span style={{ width: `${Math.min(100, questState.exchangeBcProgress / 10)}%` }} /></div>
              <div className="quest-card-footer">
                <small>{formatBalance(Math.min(1000, questState.exchangeBcProgress))} / 1 000 BC</small>
                <button className="quest-claim-button" onClick={() => claimQuest('exchange')} disabled={questState.exchangeBcProgress < 1000 || questState.claimed.exchange}>
                  {questState.claimed.exchange ? 'Получено' : questState.exchangeBcProgress >= 1000 ? 'Забрать 5 BC' : 'В процессе'}
                </button>
              </div>
            </article>

            <article className="economy-card quest-card">
              <div className="quest-card-heading"><div><h3>Пригласи друга</h3><p>Дождись перехода друга по ссылке</p></div><strong>+5 BC</strong></div>
              <div className="quest-card-footer">
                <small>{questState.inviteCompleted ? 'Квест выполнен' : 'Ожидает выполнения'}</small>
                <button
                  className="quest-claim-button"
                  onClick={() => questState.inviteCompleted ? claimQuest('invite') : setTab('Рефералы')}
                  disabled={questState.claimed.invite}
                >
                  {questState.claimed.invite ? 'Получено' : questState.inviteCompleted ? 'Забрать 5 BC' : 'Открыть рефералы'}
                </button>
              </div>
            </article>

            <article className="economy-card quest-card">
              <div className="quest-card-heading"><div><h3>Сыграй в Апгрейдер</h3><p>Заверши один раунд</p></div><strong>+5 BC</strong></div>
              <div className="quest-card-footer">
                <small>{questState.upgraderCompleted ? 'Квест выполнен' : 'Ожидает завершения раунда'}</small>
                <button className="quest-claim-button" onClick={() => claimQuest('upgrader')} disabled={!questState.upgraderCompleted || questState.claimed.upgrader}>
                  {questState.claimed.upgrader ? 'Получено' : questState.upgraderCompleted ? 'Забрать 5 BC' : 'В процессе'}
                </button>
              </div>
            </article>
          </div>
        </section>
      )}

      {tab === 'Покупка BC' && (
        <section className="section-view economy-view">
          <div className="section-heading"><div><h2>Покупка BC</h2><p>Пополнение демо-баланса</p></div></div>
          <section className="economy-card purchase-card">
            <div className="purchase-rate"><span>Курс обмена</span><strong>10 BC = 1 ⭐</strong></div>
            <label className="game-field-label" htmlFor="purchase-bc">Сумма пополнения (BC)</label>
            <div className="purchase-input-row">
              <input id="purchase-bc" type="number" min="10" step="10" value={purchaseBcAmount} onChange={(event) => { setPurchaseBcAmount(event.target.value); setPurchaseFeedback(null) }} />
              <span>BC</span>
            </div>
            <div className="purchase-preview"><span>К оплате</span><strong>{formatBalance(Math.max(0, Math.ceil(Number(purchaseBcAmount) / 10) || 0))} ⭐</strong></div>
            {purchaseFeedback && <p className={`purchase-feedback ${purchaseFeedback.kind}`} role={purchaseFeedback.kind === 'error' ? 'alert' : 'status'}>{purchaseFeedback.text}</p>}
            <button className="game-action-button" onClick={buyBcStars}>Пополнить за Stars</button>
            <p className="economy-note">Оплата Telegram Stars. 10 BC = 1 ⭐ (округление вверх). Начисление приходит сразу после оплаты.</p>
          </section>

          <div className="section-heading history-heading"><div><h2>История пополнений</h2><p>Покупки за звёзды</p></div></div>
          {purchaseHistory.length > 0
            ? <div className="history-list">{purchaseHistory.map((item, index) => (
              <article className="history-row" key={`${item.createdAt}-${index}`}>
                <div className="history-main">
                  <strong>+{formatBalance(item.amountBc)} BC за {formatBalance(item.stars)} ⭐</strong>
                  <small>{formatHistoryDate(item.createdAt)}</small>
                </div>
                <span className={`withdrawal-status ${item.status}`}>{item.status === 'paid' ? 'Выполнено' : item.status === 'pending' ? 'В ожидании' : 'Отклонено'}</span>
              </article>
            ))}</div>
            : <p className="history-empty">Пополнений пока нет.</p>}
        </section>
      )}

      {tab === 'Пополнить' && (
        <section className="section-view economy-view">
          <div className="section-heading"><div><h2>Пополнить</h2><p>Пополнение баланса по коду партнёра</p></div></div>
          <section className="economy-card topup-card">
            <label className="game-field-label" htmlFor="topup-code">Введите код</label>
            <div className="purchase-input-row">
              <input
                id="topup-code"
                type="text"
                placeholder="Например, PARTNER-XXXX"
                value={topUpCode}
                onChange={(event) => { setTopUpCode(event.target.value); setTopUpMessage('') }}
              />
            </div>
            {topUpMessage && <p className="purchase-feedback success" role="status">{topUpMessage}</p>}
            <button className="game-action-button" onClick={submitTopUp}>Пополнить</button>
            <p className="economy-note">Коды партнёров скоро появятся. Следите за обновлениями!</p>
          </section>
        </section>
      )}

      {tab === 'Курсы' && (
        <section className="section-view rates-view">
          <div className="section-heading"><div><h2>Курсы</h2><p>Изменение курса за последние 7 дней</p></div></div>
          <div className="rate-switcher" role="group" aria-label="Выбор валюты">
            {currencies.map((currency) => (
              <button
                className={selectedTicker === currency.ticker ? 'rate-option active' : 'rate-option'}
                key={currency.ticker}
                onClick={() => setSelectedTicker(currency.ticker)}
                aria-pressed={selectedTicker === currency.ticker}
              >
                {currency.name} <small>({currency.ticker})</small>
              </button>
            ))}
          </div>
          <div className="rate-chart-panel">
            <div className="rate-chart-heading">
              <span>{selectedCurrency.name} / BC</span>
              <span className={rateColor === '#48d597' ? 'rate-trend up' : 'rate-trend down'}>
                {rateIncreased ? '↗ Рост' : '↘ Снижение'}
              </span>
            </div>
            <div className="rate-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={selectedRates} margin={{ top: 22, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="#33283d" vertical={false} />
                  <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#8f849b', fontSize: 10 }} />
                  <YAxis
                    domain={['dataMin - 0.02', 'dataMax + 0.02']}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#8f849b', fontSize: 10 }}
                    tickFormatter={(value: number) => value.toFixed(2)}
                    width={42}
                  />
                  <Tooltip
                    contentStyle={{ background: '#171020', border: '1px solid #50316c', borderRadius: 8 }}
                    labelStyle={{ color: '#c6b7d1' }}
                    itemStyle={{ color: chartRateColor }}
                    formatter={(value) => [`${Number(value).toFixed(2)} BC`, 'Курс']}
                  />
                  <Line type="monotone" dataKey="rate" stroke={chartRateColor} strokeWidth={2.5} dot={{ r: 3, fill: chartRateColor, strokeWidth: 0 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rate-current">
            <span>Текущий курс</span>
            <strong>1 {selectedCurrency.ticker} = {currentRate.toFixed(2)} BC</strong>
          </div>
        </section>
      )}

      {tab === 'Портфель' && (
        <section className="section-view">
          <div className="section-heading"><div><h2>Портфель</h2><p>Твои игровые активы</p></div></div>
          <section className="balance-card portfolio-balance">
            <div className="balance-top"><span>БАЛАНС</span><span className="coin-label">✦ BUDZEN (BC)</span></div>
            <div className="balance-value">{formatBalance(demoBalance)} <span>BC</span></div>
          </section>
          <div className="section-heading portfolio-currencies-heading"><div><h2>Список валют</h2></div></div>
          <section className="currency-list">
            {currencies.map((currency) => (
              <div className="currency-row" key={currency.ticker}>
                <span className="currency-icon" style={{ '--coin-color': currency.color } as React.CSSProperties}>{currency.icon}</span>
                <span className="currency-info"><strong>{currency.name}</strong><small>{currency.ticker}</small></span>
                <span className="currency-amount">{formatBalance(currencyBalances[currency.ticker])}<small>в портфеле</small></span>
              </div>
            ))}
          </section>
        </section>
      )}

      {!['Главная', 'Обмен', 'Перевод', 'Игры', 'Активность', 'Профиль', 'Портфель', 'Курсы', 'Вывод BC', 'История', 'Ежедневный бонус', 'Квесты', 'Достижения', 'Рефералы', 'Партнёры', 'Покупка BC', 'Пополнить', 'Админ', ...games].includes(tab) && (
        <section className="notice-panel">
          <div className="notice-symbol">✦</div>
          <div><strong>{tab}</strong><p>Этот раздел пока в разработке. Скоро здесь появятся настоящие функции!</p></div>
          <button onClick={() => setTab('Главная')}>На главную</button>
        </section>
      )}

      <nav className="bottom-nav">
        {[['⌂', 'Главная'], ['⇄', 'Обмен'], ['⌁', 'Игры'], ['✦', 'Активность'], ['☻', 'Профиль']].map(([icon, label]) => (
          <button key={label} className={tab === label ? 'nav-item active' : 'nav-item'} onClick={() => setTab(label)}>
            <span>{icon}</span><small>{label}</small>
          </button>
        ))}
      </nav>
      <footer>BUILT FOR THE BUDZEN UNIVERSE <span>✦</span></footer>
    </main>
  )
}

export default App