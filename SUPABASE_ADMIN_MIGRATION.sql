-- Миграция: поля блокировки пользователя (для админ-панели).
-- Выполните в Supabase → SQL Editor.

alter table public.users
  add column if not exists is_banned  boolean not null default false,
  add column if not exists ban_reason text;

-- Индекс для быстрого поиска забаненных (опционально).
create index if not exists users_is_banned_idx on public.users (is_banned) where is_banned = true;
