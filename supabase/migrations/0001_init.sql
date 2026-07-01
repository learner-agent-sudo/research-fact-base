-- Research Fact Base — initial schema (see PLAN.md §9)
-- Apply via the Supabase MCP (apply_migration) or the SQL editor.

create extension if not exists vector;

-- Source documents (from Google Drive or in-chat upload) -------------------
create table if not exists documents (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('gdrive', 'upload')),
  drive_file_id     text,
  title             text not null,
  mime_type         text,
  drive_modified_at timestamptz,           -- change detection for re-sync
  storage_path      text,                  -- cached copy in Supabase Storage
  status            text not null default 'pending'
                    check (status in ('pending', 'ingesting', 'ready', 'error')),
  created_at        timestamptz not null default now()
);

-- Retrievable, embedded chunks --------------------------------------------
create table if not exists chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents(id) on delete cascade,
  chunk_index  int not null,
  content      text not null,
  token_count  int,
  embedding    vector(1024),              -- Voyage embedding dimension
  metadata     jsonb default '{}'::jsonb  -- page, heading, char offsets
);
create index if not exists chunks_document_id_idx on chunks(document_id);
-- HNSW cosine index for similarity search. Tune to corpus size.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- Conversations & messages -------------------------------------------------
create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  title      text,
  tier       text not null default 'free' check (tier in ('free', 'paid')),
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null,
  sources          jsonb default '[]'::jsonb,  -- the [S#] registry used
  verifications    jsonb default '[]'::jsonb,  -- CanLII / CourtListener results
  generator_models jsonb default '[]'::jsonb,
  checker_model    text,
  confidence       numeric,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_id_idx on messages(conversation_id);

-- Per-draft observability --------------------------------------------------
create table if not exists model_runs (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid references messages(id) on delete cascade,
  role       text not null check (role in ('generator', 'checker')),
  model      text not null,
  latency_ms int,
  tokens     int,
  raw_output jsonb,
  created_at timestamptz not null default now()
);

-- Citation-verification cache ---------------------------------------------
create table if not exists verification_cache (
  citation_key text primary key,          -- normalized citation string
  provider     text not null,             -- 'canlii' | 'courtlistener'
  result       jsonb not null,
  fetched_at   timestamptz not null default now()
);

-- Similarity search RPC (Phase 1): top-k chunks for a query embedding ------
create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int default 8
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable as $$
  select c.id, c.document_id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
