-- Mathews has no coffee machine, so its recipes say how much coffee to pour
-- (Full / Half / Quarter) instead of picking a machine drink. The coffee flavor
-- additions reuse recipes.coffee_machine_flavor.
--
-- Safe to run more than once.

alter table public.recipes
  add column if not exists coffee_pour text;
