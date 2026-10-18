# BUDZEN — настройка базы данных Supabase

Это техническое задание, чтобы полностью настроить Supabase под Telegram Mini App «BUDZEN».
Архитектура: **фронтенд (React WebApp) → собственный сервер (Express, Node.js) → Supabase (Postgres)**.
Фронтенд НИКОГДА не обращается к Supabase напрямую. Только сервер использует ключ `service_role`.

Всё — НАСТОЯЩЕЕ: реальные балансы, курсы, история операций, платежи. Никаких демо-заглушек.

---------------------------------------------------------------------------

## ЧАСТЬ 1. Что сделать в Supabase (по шагам)

1. Создать проект на https://supabase.com/dashboard (New project).
2. Открыть **SQL Editor** и выполнить целиком SQL из Части 3 (создаст все таблицы).
3. Открыть **Project Settings → API** и скопировать:
   - `Project URL`  → это `SUPABASE_URL`
   - `service_role` (secret) → это `SUPABASE_SERVICE_ROLE_KEY` (никому не показывать! только на сервере).
4. RLS (Часть 4) — включить, но публичных политик не добавлять.
   Тогда браузер не получит доступ к данным, а сервер (service_role) обходит RLS и работает.

---------------------------------------------------------------------------

## ЧАСТЬ 2. Обзор схемы

| Таблица | Назначение |
|---|---|
| `users` | Пользователи: Telegram ID, имя, username, балансы, статистика, уровень/XP, серия бонусов |
| `transfers` | История переводов BC между пользователями (комиссия 2%) |
| `withdrawals` | Заявки на вывод BC |
| `daily_bonus_claims` | История получения ежедневного бонуса |
| `quest_progress` | Прогресс квестов по пользователю |
| `rates` | Текущие курсы валют (реальные, одинаковые для всех) |
| `rate_history` | История курсов по дням (для графика за 7 дней) |
| `achievements` | Справочник достижений (название, описание, цель) |
| `user_achievements` | Прогресс достижений конкретного игрока |
| `transactions` | История всех операций (обмен, перевод, бонус, вывод, покупка) |
| `payments` | История покупок/донатов (реальные Telegram Stars) |
| `partners` | Партнёры (партнёрская программа) |

---------------------------------------------------------------------------

## ЧАСТЬ 3. SQL — создание всех таблиц (выполнить в SQL Editor)

```sql
-- =====================================================================
-- BUDZEN — структура базы данных
-- =====================================================================

-- 1) Пользователи
create table if not exists public.users (
  id               bigint primary key,                       -- Telegram user id
  username         text,                                     -- username без @ (может быть null)
  first_name       text,
  last_name        text,
  photo_url        text,                                     -- аватар из Telegram (необязательно)
  balance_bc       numeric(18,2) not null default 1000,      -- стартовый баланс BC
  balance_a        numeric(18,2) not null default 1000,      -- ALPHA
  balance_b        numeric(18,2) not null default 500,       -- BETA
  total_sent       numeric(18,2) not null default 0,         -- суммарно отправлено (переводы + вывод)
  total_deposited  numeric(18,2) not null default 0,         -- суммарно пополнено (донат / покупка)
  level            integer       not null default 1,
  xp               integer       not null default 0,
  daily_streak     integer       not null default 0,
  last_bonus_date  date,                                     -- дата последнего бонуса
  referral_code    text unique,                              -- персональный реферальный код
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

-- 2) Переводы BC между пользователями (комиссия 2%)
create table if not exists public.transfers (
  id            bigserial primary key,
  from_user_id  bigint not null references public.users(id),
  to_user_id    bigint not null references public.users(id),
  amount        numeric(18,2) not null check (amount > 0),   -- сумма перевода
  fee           numeric(18,2) not null default 0,            -- комиссия (2%)
  total         numeric(18,2) not null,                      -- списано всего (amount + fee)
  created_at    timestamptz not null default now()
);

-- 3) Заявки на вывод BC
create table if not exists public.withdrawals (
  id          bigserial primary key,
  code        text not null unique,                          -- код заявки (WD-XXXX-XXXX)
  user_id     bigint not null references public.users(id),
  amount      numeric(18,2) not null check (amount > 0),
  currency    text not null default 'A' check (currency in ('A','B')),
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected','paid')),
  created_at  timestamptz not null default now()
);

-- 4) Ежедневные бонусы (1 раз в день на пользователя)
create table if not exists public.daily_bonus_claims (
  id          bigserial primary key,
  user_id     bigint not null references public.users(id),
  amount      numeric(18,2) not null,
  streak_day  integer not null,
  claim_date  date not null default (now() at time zone 'utc')::date,
  claimed_at  timestamptz not null default now(),
  unique (user_id, claim_date)
);

-- 5) Прогресс квестов
create table if not exists public.quest_progress (
  user_id            bigint primary key references public.users(id),
  exchange_bc        numeric(18,2) not null default 0,       -- обменяно BC (цель 1000)
  invite_completed   boolean not null default false,
  upgrader_completed boolean not null default false,
  bonus_claimed      boolean not null default false,
  invite_claimed     boolean not null default false,
  upgrader_claimed   boolean not null default false,
  updated_at         timestamptz not null default now()
);

-- 6) Текущие курсы валют (реальные, одинаковые для всех)
create table if not exists public.rates (
  ticker      text primary key,                              -- 'A' или 'B'
  name        text not null,                                 -- 'ALPHA' / 'BETA'
  rate        numeric(18,6) not null check (rate > 0),       -- курс к BC
  updated_at  timestamptz not null default now()
);

insert into public.rates (ticker, name, rate) values
  ('A', 'ALPHA', 1.24),
  ('B', 'BETA',  0.79)
on conflict (ticker) do nothing;

-- 7) История курсов по дням (график за 7 дней)
create table if not exists public.rate_history (
  id          bigserial primary key,
  ticker      text not null,                                 -- 'A' или 'B'
  rate        numeric(18,6) not null check (rate > 0),
  day         date not null,
  created_at  timestamptz not null default now(),
  unique (ticker, day)
);

-- 8) Справочник достижений
create table if not exists public.achievements (
  code        text primary key,                              -- 'first_bonus', 'week_streak', ...
  title       text not null,
  description text not null,
  target      numeric(18,2) not null default 1,              -- цель прогресса
  reward_bc   numeric(18,2) not null default 0,              -- награда BC
  sort_order  integer not null default 0
);

insert into public.achievements (code, title, description, target, reward_bc, sort_order) values
  ('first_bonus',  'Первый бонус',      'Получи ежедневный бонус',        1,    0, 1),
  ('week_streak',  'Неделя активности', 'Забирай бонус 7 дней подряд',    7,    0, 2),
  ('first_exchange','Первый обмен',     'Обменивай BUDDA COINS на валюту',1,    0, 3),
  ('big_exchange', 'Крупный обмен',     'Обмени 1 000 BC',                1000, 0, 4),
  ('first_upgrade','Первый апгрейд',    'Заверши раунд в Апгрейдере',     1,    0, 5),
  ('friend_joined','Друг в игре',       'Подтверди приглашение друга',    1,    0, 6)
on conflict (code) do nothing;

-- 9) Прогресс достижений конкретного игрока
create table if not exists public.user_achievements (
  id            bigserial primary key,
  user_id       bigint not null references public.users(id),
  achievement   text not null references public.achievements(code),
  progress      numeric(18,2) not null default 0,
  unlocked      boolean not null default false,
  unlocked_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (user_id, achievement)
);

-- 10) История всех операций пользователя
create table if not exists public.transactions (
  id          bigserial primary key,
  user_id     bigint not null references public.users(id),
  type        text not null check (type in ('exchange','transfer_out','transfer_in','withdrawal','bonus','purchase')),
  amount      numeric(18,2) not null,                        -- сумма операции
  currency    text not null default 'BC',                    -- 'BC' / 'A' / 'B'
  meta        jsonb,                                         -- доп. данные (получатель и т.п.)
  created_at  timestamptz not null default now()
);

-- 11) История покупок / донатов (реальные Telegram Stars)
create table if not exists public.payments (
  id                 bigserial primary key,
  user_id            bigint not null references public.users(id),
  stars              integer not null check (stars > 0),     -- сколько звёзд
  amount_bc          numeric(18,2) not null,                 -- сколько BC начислено
  provider           text not null default 'telegram_stars'  -- 'telegram_stars'
                     check (provider in ('telegram_stars')),
  status             text not null default 'paid'
                     check (status in ('pending','paid','failed','refunded')),
  telegram_charge_id text,                                   -- id платежа Telegram
  created_at         timestamptz not null default now()
);

-- 12) Партнёры (партнёрская программа)
create table if not exists public.partners (
  id           bigserial primary key,
  user_id      bigint references public.users(id),           -- кто партнёр
  code         text not null unique,                         -- партнёрский код
  visits       integer not null default 0,                   -- переходы по ссылке
  registered   integer not null default 0,                   -- приглашённые пользователи
  earned_bc    numeric(18,2) not null default 0,             -- заработано BC
  created_at   timestamptz not null default now()
);

-- Индексы
create index if not exists transfers_from_idx    on public.transfers(from_user_id, created_at desc);
create index if not exists transfers_to_idx      on public.transfers(to_user_id, created_at desc);
create index if not exists withdrawals_user_idx  on public.withdrawals(user_id, created_at desc);
create index if not exists transactions_user_idx on public.transactions(user_id, created_at desc);
create index if not exists payments_user_idx     on public.payments(user_id, created_at desc);
create index if not exists user_ach_idx          on public.user_achievements(user_id);
```

---------------------------------------------------------------------------

## ЧАСТЬ 4. RLS (Row Level Security)

Задача: **из браузера доступа нет, весь доступ — через сервер (service_role обходит RLS)**.

```sql
alter table public.users              enable row level security;
alter table public.transfers          enable row level security;
alter table public.withdrawals        enable row level security;
alter table public.daily_bonus_claims enable row level security;
alter table public.quest_progress     enable row level security;
alter table public.rates              enable row level security;
alter table public.rate_history       enable row level security;
alter table public.achievements       enable row level security;
alter table public.user_achievements  enable row level security;
alter table public.transactions       enable row level security;
alter table public.payments           enable row level security;
alter table public.partners           enable row level security;

-- Публичных политик НЕ создаём.
-- anon/authenticated из браузера не увидят ничего.
-- service_role (наш сервер) обходит RLS и работает нормально.
```

---------------------------------------------------------------------------

## ЧАСТЬ 5. Что сервер (Express) делает с базой

| Эндпоинт | Что делает |
|---|---|
| `POST /api/auth` | Вход/регистрация по Telegram `initData`. Если пользователя нет — создаёт с балансами по умолчанию. Возвращает профиль + балансы + прогресс. |
| `POST /api/exchange` | Обмен BC ⇄ A ⇄ B по курсу из таблицы `rates`. Пишет в `transactions`, копит `exchange_bc`. |
| `POST /api/transfer` | Перевод BC по `@username` или ID. Списывает `amount + 2% fee`, зачисляет получателю `amount`. Пишет в `transfers` и `transactions`. |
| `GET  /api/withdrawals?userId=` | История заявок на вывод. |
| `POST /api/withdrawals` | Создать заявку, списать баланс, записать в `withdrawals` и `transactions`. |
| `POST /api/bonus/daily` | Взять ежедневный бонус (1 раз в день). Обновляет `daily_streak`, `last_bonus_date`, пишет в `daily_bonus_claims` и `transactions`. |
| `POST /api/purchase` | Покупка BC за Telegram Stars. Пишет в `payments` и `transactions`. |
| `GET  /api/rates` | Текущие курсы + история за 7 дней (из `rates` и `rate_history`). |
| `GET  /api/achievements` | Список достижений + прогресс игрока (`achievements` + `user_achievements`). |

Все операции с балансом **должны быть атомарными** (транзакция или SQL-функция), чтобы избежать гонок.

---------------------------------------------------------------------------

## ЧАСТЬ 6. Переменные окружения (файл `.env.local` на сервере)

```
SUPABASE_URL=https://ВАШ-ПРОЕКТ.supabase.co
SUPABASE_SERVICE_ROLE_KEY=ВАШ_SERVICE_ROLE_КЛЮЧ
TELEGRAM_BOT_TOKEN=ТОКЕН_БОТА_ОТ_BOTFATHER
API_PORT=3001
```

---------------------------------------------------------------------------

## ЧАСТЬ 7. Вопросы для ИИ (чтобы проверил, что всё ок)

1. Правильна ли схема под Telegram Mini App?
2. Нужны ли SQL-функции (RPC) для атомарных переводов/обменов (чтобы исключить race condition)?
3. Достаточно ли RLS «всё закрыто, доступ только service_role»?
4. Как правильно и безопасно проверять Telegram `initData` (хеш) на сервере?
5. Как правильно принимать реальные оплаты через Telegram Stars (invoice), и как проверить платёж на сервере?
6. Нужны ли триггеры на `updated_at`?
