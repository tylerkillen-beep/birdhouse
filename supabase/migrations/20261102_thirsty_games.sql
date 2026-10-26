-- The Thirsty Games: a November competition between STAR classes.
--
-- Customers pick their STAR teacher at checkout; the class whose members spend
-- the most online between Nov 2 and Nov 30 wins a free drink for everyone in
-- the class. The standings are public on /customer/thirsty-games.html.
--
-- * star_classes   -- the roster the checkout dropdown reads. Seeded below
--                     from the NHS staff list minus clearly non-teaching roles
--                     (counselors, nurses, office staff, administrators...).
--                     Edit it in the SQL editor: set active = false to drop a
--                     teacher, or insert a row to add one.
-- * profiles.star_class_id -- the customer's remembered pick.
-- * orders.star_class_id   -- stamped by process-payment on each order placed
--                     in the window; this is what the standings add up.
--
-- Sales counted are website orders' total_amount (so the delivery fee counts),
-- cancelled orders excluded, by the day the order was placed in Chicago time.
-- The window dates live in thirsty_games_window() and are mirrored in
-- customer/order.html and process-payment -- change them together.

create table if not exists public.star_classes (
  id           bigint generated always as identity primary key,
  teacher_name text    not null unique,   -- "Last, First"
  subject      text,
  room         text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

alter table public.star_classes enable row level security;

drop policy if exists "star_classes readable by everyone" on public.star_classes;
create policy "star_classes readable by everyone"
  on public.star_classes for select
  using (true);

grant select on public.star_classes to anon, authenticated;
grant all    on public.star_classes to service_role;

alter table public.profiles add column if not exists star_class_id bigint
  references public.star_classes(id) on delete set null;
alter table public.orders   add column if not exists star_class_id bigint
  references public.star_classes(id) on delete set null;

create index if not exists idx_orders_star_class_id
  on public.orders (star_class_id) where star_class_id is not null;

create or replace function public.thirsty_games_window()
returns table (starts_on date, ends_on date)
language sql
immutable
as $$ select date '2026-11-02', date '2026-11-30' $$;

grant execute on function public.thirsty_games_window() to anon, authenticated, service_role;

-- Standings: every active class, ranked by total spent. Classes with no sales
-- yet are included at $0 so customers can see who is on the board.
create or replace function public.thirsty_games_standings()
returns table (
  rank          bigint,
  class_id      bigint,
  teacher_name  text,
  subject       text,
  total_amount  numeric,
  order_count   bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with win as (select starts_on, ends_on from public.thirsty_games_window()),
  sales as (
    select o.star_class_id,
           sum(o.total_amount) as total_amount,
           count(*)            as order_count
      from public.orders o, win
     where o.star_class_id is not null
       and coalesce(o.status, '') <> 'cancelled'
       and (o.created_at at time zone 'America/Chicago')::date between win.starts_on and win.ends_on
     group by o.star_class_id
  )
  select rank() over (order by coalesce(s.total_amount, 0) desc) as rank,
         c.id, c.teacher_name, c.subject,
         coalesce(s.total_amount, 0), coalesce(s.order_count, 0)
    from public.star_classes c
    left join sales s on s.star_class_id = c.id
   where c.active
   order by coalesce(s.total_amount, 0) desc, c.teacher_name;
$$;

grant execute on function public.thirsty_games_standings() to anon, authenticated;

comment on function public.thirsty_games_standings() is
  'Thirsty Games leaderboard: active STAR classes ranked by total website order amount placed in the competition window. Public; returns class and dollar totals only, never customer data.';

insert into public.star_classes (teacher_name, subject, room) values
  ('Adams, Sahara', 'SPED', '278'),
  ('Adriano, Ben', 'SPED', '217'),
  ('Ames, Michell', 'ELL', '273'),
  ('Ashby, Briana', 'Comm. Arts', '320'),
  ('Baker, Samantha', 'Comm. Arts', '321'),
  ('Baldwin, Dustin', 'Government', '314'),
  ('Beck, Kitty', 'Comm. Arts', '250'),
  ('Blansit, Brock', 'PE', 'Gym/184'),
  ('Boyce, Andrew', 'PE', 'Gym/184'),
  ('Boyd, Kacey', 'Science', '265'),
  ('Bradford, Michael', 'Band', 'Band Rm'),
  ('Brantner, Amber', 'Business', '215'),
  ('Brundage, Elizabeth', 'History', '306'),
  ('Burford, Barrett', 'Comm. Arts', '257'),
  ('Burger, Lisa', 'Math', '332'),
  ('Burns, Jordan', 'Business', '214'),
  ('Cecenas, Jose', 'History/Govt.', '305'),
  ('Cochran, Blake', 'Science', '272'),
  ('Corya, Wendee', 'Math', '240'),
  ('Daniels, Lakyn', 'Drama', '199'),
  ('Davis, Sydney', 'Math', '309'),
  ('Dense, Ashley', 'Spanish', '170'),
  ('Donham, Katie', 'Science', '263'),
  ('Durham, Jessica', 'History', '310'),
  ('Edwards, Alexander', 'History', '303'),
  ('Eggleston, Beth', 'Journalism', '221/251'),
  ('Fergus, Kim', 'Spanish', '171'),
  ('Finger, Craig', 'Band', 'A100'),
  ('Fleetwood, Allison', 'Drama', 'A133'),
  ('Foster, Jason', 'Science', '277'),
  ('Garrison, Sarah', 'Math', '325'),
  ('Glenn, Cory', 'Drama', 'A140'),
  ('Goodyear, Kimberly', 'Comm. Arts', '249'),
  ('Gunther, Teri', 'Science', '318'),
  ('Gutierrez, Daniel', 'Music', 'A125'),
  ('Hancock, Chloe', 'Math/Science', '237'),
  ('Hardy, Aubrey', 'SPED', '189'),
  ('Harris, Angie', 'Comm. Arts', '322'),
  ('Heckman, Kristina', 'Math', '233'),
  ('Hefley, Angela', 'Science', '269'),
  ('Herring, Alisha', 'SPED', '213'),
  ('Hodapp, Robert', 'JROTC', '181'),
  ('Horton, Megan', 'Math', '238'),
  ('Houp, Amanda', 'Comm. Arts', '324'),
  ('Howard, Delaney', 'Comm. Arts', '255'),
  ('Hughes, Logan', 'Opport. Plus', '282'),
  ('Humes, Alician', 'SPED', '188'),
  ('Johns, Melissa', 'SPED', '326'),
  ('Johnson, Madison', 'SPED', '222'),
  ('Jordan, Theodor', 'Science', '268'),
  ('Kershaw, Will', 'Comm. Arts', '256'),
  ('Killen, Tyler', 'Business', '216'),
  ('Lechner, Rachel', 'Comm. Arts', '258'),
  ('Livengood, Erin', 'Comm. Arts', '260'),
  ('Lotz, Melissa', 'Math', '330'),
  ('Mann, Elliott', 'Art', '236'),
  ('Marsiglio, Annaliese', 'Math', '242'),
  ('Martin, Dustin', 'Opport. Plus', '212'),
  ('Martin, Hannah', 'Science', '266'),
  ('Mason, Robin', 'SPED', '211'),
  ('McElhinney, Curtis', 'Math', '241'),
  ('McGowan, Rachel', 'SPED', '126'),
  ('Miller, Scott', 'History', '311A'),
  ('Mitchell, David', 'Art', '228'),
  ('Montana, Taylor', 'Comm. Arts', '246'),
  ('Motto, Tania', 'Math', '328'),
  ('Nelson, Holly', 'Math', '239'),
  ('Nelson, Zac', 'Science', '262'),
  ('Newberry, Ashley', 'FACS', '218/223'),
  ('O''Bryant, Erika', 'Band', 'Band Rm'),
  ('Palmer, Evan', 'Government', '304'),
  ('Patterson, Kim', 'Band', 'A128'),
  ('Perry, Ana', 'Spanish', '172'),
  ('Perry, John', 'PE', '1001'),
  ('Posegate, Josh', 'Government', '311B'),
  ('Pycior, Stephanie', 'FACS', '227'),
  ('Rapp, Whitney', 'Science', '317'),
  ('Reichert, Jonah', 'History', '308'),
  ('Richardson, Rob', 'Health', '191'),
  ('Ruffin, Heather', 'SPED', '208'),
  ('Sartin, Kim', 'SPED', '209'),
  ('Shepherd, Christina', 'Science', '281'),
  ('Spayde, Kirby', 'Band', 'Band Rm'),
  ('Spence, Jonathon', 'Comm. Arts', '248'),
  ('Stammers, Jennifer', 'Music', 'A124'),
  ('Stoll, Amanda', 'Comm. Arts', '319'),
  ('Stubblefield, Tammy', 'Music', 'A125'),
  ('Sustaita, Nohemi', 'Spanish', '173'),
  ('Sweet, Veronica', 'ASL', '323'),
  ('Talbert, Jennifer', 'PE/Health', 'Gym/194'),
  ('Teed, Chris', 'History', '307'),
  ('Thompson, Brooke', 'Science', '275'),
  ('Vick, Krista', 'SPED', '206'),
  ('Villanueva, George', 'History', '280'),
  ('Walker, Matt', 'History', '313'),
  ('Walton, Amanda', 'Math', '235'),
  ('Widel, Ryan', 'Art', '234'),
  ('Williamson, Jay', 'Speech/Debate', '169'),
  ('Willis, Jody', 'Science', '315'),
  ('Wood, Marcy', 'FACS', '226'),
  ('Wright, Jaime L.', 'SPED', '225'),
  ('Zimmerman, Annie', 'PE', 'Gym/196')
on conflict (teacher_name) do nothing;
