-- Demo schema for local development and tests of the powersync-write function. It matches
-- example-client/src/library/powersync/AppSchema.ts. Seeds run only on local `supabase start`
-- and `supabase db reset`; they are never pushed to a hosted project.

create table public.lists (
  id uuid primary key,
  created_at timestamptz not null default now(),
  name text not null,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade
);

create table public.todos (
  id uuid primary key,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  description text not null,
  completed integer not null default 0 check (completed in (0, 1)),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  completed_by uuid references auth.users (id) on delete set null,
  list_id uuid not null references public.lists (id) on delete cascade
);

create index lists_owner_id_idx on public.lists (owner_id);
create index todos_list_id_idx on public.todos (list_id);
create index todos_created_by_idx on public.todos (created_by);
create index todos_completed_by_idx on public.todos (completed_by);

-- Writes run as the authenticated role with the caller's claims, so grants and RLS decide access.
revoke all on public.lists, public.todos from anon;
grant select, insert, update, delete on public.lists, public.todos to authenticated;

alter table public.lists enable row level security;
alter table public.todos enable row level security;

create policy "Owners manage their lists" on public.lists
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "List owners manage its todos" on public.todos
  for all to authenticated
  using (exists (select 1 from public.lists where lists.id = todos.list_id and lists.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.lists where lists.id = todos.list_id and lists.owner_id = (select auth.uid())));
