-- Trade prices are per kilo unless a piece says it's priced per piece.
-- Products came in as 'piece' by default; they become 'kg' except where the
-- title says per piece. New products start as 'kg'.
update public.trade_products set unit = 'kg'
 where unit = 'piece'
   and title !~* '(per\s*(pc|pcs|piece)\b|/\s*(pc|pcs|piece)\b|\(\s*(pc|pcs|piece)\s*\))';
alter table public.trade_products alter column unit set default 'kg';
