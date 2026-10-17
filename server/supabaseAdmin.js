// СЕРВЕРНЫЙ клиент Supabase с ключом service_role.
// ⚠️ Этот файл НИКОГДА не должен попадать во фронтенд-сборку (папка src/).
// service_role обходит RLS и даёт полный доступ к базе — только для сервера.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[supabaseAdmin] SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не заданы.')
}

// Клиент для работы с базой из серверного кода.
// auth.persistSession: false — серверу не нужно хранить сессии.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
