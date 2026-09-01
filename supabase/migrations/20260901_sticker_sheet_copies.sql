-- Let customers order several copies of one sheet design instead of rebuilding
-- the same layout over and over.
--
-- Pricing with copies (enforced in the process-payment edge function):
--   copies x $2.00 + $0.25 per unique image beyond the first, counted ONCE.
-- The image surcharge is a one-time design fee: the tenth copy of a design
-- costs no more to print than the first, so it isn't charged again.

alter table public.sticker_sheets
  add column if not exists copies int not null default 1;

do $copies$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sticker_sheets_copies_check'
  ) then
    alter table public.sticker_sheets
      add constraint sticker_sheets_copies_check
      check (copies between 1 and 50);
  end if;
end
$copies$;
