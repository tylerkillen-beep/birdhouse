-- Mathews makes hot chocolate from powder, so its recipes say how many scoops.
--
-- Safe to run more than once.

alter table public.recipes
  add column if not exists hot_chocolate_scoops numeric;
