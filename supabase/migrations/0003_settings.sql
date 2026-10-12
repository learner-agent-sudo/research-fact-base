-- App-wide settings and API keys managed from the website's Settings page.
--
-- app_settings: small key/value rows ('ai' = model choices and answer options,
-- 'library' = the document loader's last run, written by scripts/ingest.mjs).
-- RLS on with no policies: only the service role (the research-api edge
-- function and the ingest job) can read or write it.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.app_settings enable row level security;

-- API keys entered on the Settings page are stored encrypted in Supabase Vault.
-- Only these two names can be touched, and only by the service role.
create or replace function public.app_secret_get(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name not in ('rfb_openrouter_api_key', 'rfb_gemini_api_key') then
    raise exception 'unknown secret %', p_name;
  end if;
  return (select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1);
end;
$$;

create or replace function public.app_secret_set(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_name not in ('rfb_openrouter_api_key', 'rfb_gemini_api_key') then
    raise exception 'unknown secret %', p_name;
  end if;
  select id into v_id from vault.secrets where name = p_name limit 1;
  if p_value is null or p_value = '' then
    if v_id is not null then
      delete from vault.secrets where id = v_id;
    end if;
  elsif v_id is null then
    perform vault.create_secret(p_value, p_name, 'Set from the Research Fact Base settings page');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

revoke all on function public.app_secret_get(text) from public, anon, authenticated;
revoke all on function public.app_secret_set(text, text) from public, anon, authenticated;
grant execute on function public.app_secret_get(text) to service_role;
grant execute on function public.app_secret_set(text, text) to service_role;
