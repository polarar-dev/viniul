-- Cole e execute isso inteiro no Supabase: Painel → SQL Editor → New query → Run

-- Perfis (nome de usuário público, ligado à conta de autenticação)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  username text not null,
  created_at timestamptz default now()
);

-- Canais (texto ou voz)
create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('text','voice')),
  created_at timestamptz default now()
);

-- Mensagens
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references channels on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  username text not null,
  content text not null,
  created_at timestamptz default now()
);

-- Segurança: qualquer pessoa logada pode ler tudo e escrever suas próprias mensagens
alter table profiles enable row level security;
alter table channels enable row level security;
alter table messages enable row level security;

create policy "Perfis são visíveis para logados" on profiles for select using (auth.role() = 'authenticated');
create policy "Usuário edita o próprio perfil" on profiles for insert with check (auth.uid() = id);
create policy "Usuário atualiza o próprio perfil" on profiles for update using (auth.uid() = id);

create policy "Canais visíveis para logados" on channels for select using (auth.role() = 'authenticated');

create policy "Mensagens visíveis para logados" on messages for select using (auth.role() = 'authenticated');
create policy "Usuário envia mensagem como si mesmo" on messages for insert with check (auth.uid() = user_id);

-- Tempo real: liga o chat ao vivo
alter publication supabase_realtime add table messages;

-- Canais iniciais (pode editar/adicionar pelo Table Editor depois)
insert into channels (name, type) values
  ('geral', 'text'),
  ('avisos', 'text'),
  ('sala-de-voz', 'voice');
