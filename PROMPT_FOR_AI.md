# ПРОМТ ДЛЯ ИИ-ПОМОЩНИКА

Ниже — текст. Скопируй ВСЁ (весь блок) и вставь своей другой ИИ (DeepSeek).
Потом просто отвечай ей и присылай скрины Supabase.

=======================================================================

Привет! Ты — мой личный помощник по настройке Supabase. Я НЕ программист.

Как со мной работать:
- Объясняй просто, по шагам: «нажми сюда», «перейди туда».
- Я буду присылать СКРИНЫ экрана Supabase — смотри на них и говори, что делать дальше.
- Если я сделал не так — скажи, как исправить.
- После каждого шага проси скрин, чтобы проверить.
- Не заставляй меня писать код, если можно сделать через интерфейс. SQL давать можно — я вставлю.

МОЯ ЗАДАЧА: настроить базу данных в Supabase для Telegram Mini App «BUDZEN».

Что это за проект:
- Telegram Mini App (открывается внутри Telegram).
- Есть отдельный сервер (уже написан), который хранит секретный ключ и общается с Supabase.
- Фронтенд НИКОГДА не лезет в Supabase напрямую (так безопаснее).
- Всё должно быть НАСТОЯЩИМ: реальные балансы, курсы, история, платежи.

ЧТО НУЖНО В ИТОГЕ:
1. Создать новый проект Supabase (я уже удалил старый, начинаю с нуля).
2. Создать в базе все таблицы (SQL ниже).
3. Включить защиту RLS (чтобы из браузера никто не мог менять данные).
4. В конце — сказать мне два значения, которые я вставлю в свой сервер:
   - SUPABASE_URL (Project URL)
   - SUPABASE_SERVICE_ROLE_KEY (секретный ключ service_role)

=======================================================================
ШАГ A. SQL — СОЗДАНИЕ ВСЕХ ТАБЛИЦ
(это я вставлю в SQL Editor Supabase)
=======================================================================

```sql
-- 1) Пользователи
create table if not exists public.users (
  id               bigint primary key,
  username         text,
  first_name       text,
  last_name        text,
  photo_url        text,
  balance_bc       numeric(18,2) not null default 1000,
  balance_a        numeric(18,2) not null default 1000,
  balance_b        numeric(18,2) not null default 500,
  total_sent       numeric(18,2) not null default 0,
  total_deposited  numeric(18,2) not null default 0,
  level            integer       not null default 1,
  xp               integer       not null default 0,
  daily_streak     integer       not null default 0,
  last_bonus_date  date,
  referral_code    text unique,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

-- 2) Переводы BC между пользователями (комиссия 2%)
create table if not exists public.transfers (
  id            bigserial primary key,
  from_user_id  bigint not null references public.users(id),
  to_user_id    bigint not null references public.users(id),
  amount        numeric(18,2) not null check (amount > 0),
  fee           numeric(18,2) not null default 0,
  total         numeric(18,2) not null,
  created_at    timestamptz not null default now()
);

-- 3) Заявки на вывод BC
create table if not exists public.withdrawals (
  id          bigserial primary key,
  code        text not null unique,
  user_id     bigint not null references public.users(id),
  amount      numeric(18,2) not null check (amount > 0),
  currency    text not null default 'BC' check (currency = 'BC'),
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected','paid')),
  created_at  timestamptz not null default now()
);

-- 4) Ежедневные бонусы
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
  exchange_bc        numeric(18,2) not null default 0,
  invite_completed   boolean not null default false,
  upgrader_completed boolean not null default false,
  bonus_claimed      boolean not null default false,
  invite_claimed     boolean not null default false,
  upgrader_claimed   boolean not null default false,
  updated_at         timestamptz not null default now()
);

-- 6) Текущие курсы валют
create table if not exists public.rates (
  ticker      text primary key,
  name        text not null,
  rate        numeric(18,6) not null check (rate > 0),
  updated_at  timestamptz not null default now()
);
insert into public.rates (ticker, name, rate) values
  ('A', 'ALPHA', 1.24),
  ('B', 'BETA',  0.79)
on conflict (ticker) do nothing;

-- 7) История курсов по дням
create table if not exists public.rate_history (
  id          bigserial primary key,
  ticker      text not null,
  rate        numeric(18,6) not null check (rate > 0),
  day         date not null,
  created_at  timestamptz not null default now(),
  unique (ticker, day)
);

-- 8) Справочник достижений
create table if not exists public.achievements (
  code        text primary key,
  title       text not null,
  description text not null,
  target      numeric(18,2) not null default 1,
  reward_bc   numeric(18,2) not null default 0,
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

-- 9) Прогресс достижений игрока
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

-- 10) История операций
create table if not exists public.transactions (
  id          bigserial primary key,
  user_id     bigint not null references public.users(id),
  type        text not null check (type in ('exchange','transfer_out','transfer_in','withdrawal','bonus','purchase')),
  amount      numeric(18,2) not null,
  currency    text not null default 'BC',
  meta        jsonb,
  created_at  timestamptz not null default now()
);

-- 11) Покупки / донаты (Telegram Stars)
create table if not exists public.payments (
  id                 bigserial primary key,
  user_id            bigint not null references public.users(id),
  stars              integer not null check (stars > 0),
  amount_bc          numeric(18,2) not null,
  provider           text not null default 'telegram_stars' check (provider in ('telegram_stars')),
  status             text not null default 'paid' check (status in ('pending','paid','failed','refunded')),
  telegram_charge_id text,
  created_at         timestamptz not null default now()
);

-- 12) Партнёры
create table if not exists public.partners (
  id           bigserial primary key,
  user_id      bigint references public.users(id),
  code         text not null unique,
  visits       integer not null default 0,
  registered   integer not null default 0,
  earned_bc    numeric(18,2) not null default 0,
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

=======================================================================
ШАГ B. SQL — ЗАЩИТА RLS
(вставлю в SQL Editor после Шага A)
=======================================================================

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

-- Публичных политик НЕ создаём: в браузере доступа нет,
-- работает только мой сервер через service_role.
```

=======================================================================
ЧТО ДЕЛАТЬ ПОСЛЕ (это твоя задача как помощника):
=======================================================================

1. Спроси, создал ли я уже новый проект Supabase.
2. Веди меня по шагам: где кнопка «SQL Editor», куда вставлять SQL, как нажать Run.
3. После Шага A и Шага B попроси скрины — проверь, что все 12 таблиц создались (Table Editor слева).
4. Расскажи, где взять Project URL и service_role ключ (Project Settings → API).
5. В конце проверь, что всё готово, и напиши мне 2 строки, которые я вставлю в файл .env.local:
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...

Начни с вопроса: «Создал новый проект Supabase? Покажи скрин» — и дальше веди меня по шагам.
