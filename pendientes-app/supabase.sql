-- Pega esto tal cual en Supabase → SQL Editor → New query → Run.
-- Crea la tabla donde se guardan tus listas y las reglas de seguridad
-- para que cada usuario solo pueda ver y escribir SUS propios datos.

create table if not exists public.pendientes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.pendientes enable row level security;

drop policy if exists "leer lo propio"      on public.pendientes;
drop policy if exists "insertar lo propio"  on public.pendientes;
drop policy if exists "actualizar lo propio" on public.pendientes;
drop policy if exists "borrar lo propio"    on public.pendientes;

create policy "leer lo propio"
  on public.pendientes for select
  using (auth.uid() = user_id);

create policy "insertar lo propio"
  on public.pendientes for insert
  with check (auth.uid() = user_id);

create policy "actualizar lo propio"
  on public.pendientes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "borrar lo propio"
  on public.pendientes for delete
  using (auth.uid() = user_id);
