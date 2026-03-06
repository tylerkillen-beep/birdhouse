-- Hide all menu items while Square sync is being tested.
-- Items must be explicitly made available by an admin before customers can order them.
update public.menu_items set available = false;
