-- Deny-by-default RLS. All app access is server-side via the service-role key,
-- which bypasses RLS; the browser/anon role gets no direct table access. When
-- multi-user auth is added, introduce per-user policies (see PLAN.md §12).
alter table public.documents          enable row level security;
alter table public.chunks             enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.model_runs         enable row level security;
alter table public.verification_cache enable row level security;

-- Enrich the similarity search to also return the document title + Drive id,
-- so retrieval can build source cards without a second round-trip.
drop function if exists match_chunks(vector, int);

create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int default 8
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  similarity float,
  title text,
  drive_file_id text
)
language sql stable as $$
  select c.id, c.document_id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) as similarity,
         d.title, d.drive_file_id
  from chunks c
  join documents d on d.id = c.document_id
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
