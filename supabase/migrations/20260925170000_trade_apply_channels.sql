-- Application details: where the buyer sells, mailing-list consent, and the
-- preferences they set when they first choose a password.
alter table public.trade_buyers
  add column if not exists sells_on         jsonb   not null default '{}'::jsonb,  -- {channels:[...], handles:{instagram:"",...}}
  add column if not exists marketing_opt_in boolean not null default false,
  add column if not exists prefs            jsonb   not null default '{}'::jsonb;  -- {interests:[], contact:"whatsapp", buys:"pieces"}
