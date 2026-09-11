-- Receiving deliveries: counts go up by what actually arrived.
--
-- Three fixes to the receipt -> delivery flow:
--
--   1. Unit conversion. A receipt line is in purchased units (one 4-pack of
--      syrup) while inventory is counted in something else (bottles), and
--      confirming arrival used to add the 1 straight onto the bottle count.
--      Each line now carries counted_per_purchase -- how many counted units one
--      purchase adds -- and receiving adds arrived x that.
--   2. Remembering it. The same product listing is the same pack every time,
--      so the confirmed conversion is saved on the listing's inventory_aliases
--      row, next to the confirmed item match, and the next receipt fills in.
--   3. Deliveries that beat the receipt. A manager unpacking a box nobody
--      uploaded a receipt for records it as 'needs_receipt'; the admin attaches
--      the receipt to it later, and it can be received straight away.
--
-- receive_purchase_order() does the receiving in one transaction, so a count
-- can't be left half-updated and two people confirming at once can't both add
-- to the same stale number.
--
-- Supabase's SQL editor flags this as destructive because it drops and re-adds
-- the status CHECK constraint (to allow 'needs_receipt'). No rows change.
--
-- Safe to run more than once.

-- ── Columns ──────────────────────────────────────────────────────────────────
alter table public.purchase_order_items
  add column if not exists counted_per_purchase numeric,
  add column if not exists received_count       numeric;

comment on column public.purchase_order_items.counted_per_purchase is
  'Counted units (inventory.unit) in one purchased unit: a 4-pack of bottles = 4.';
comment on column public.purchase_order_items.received_count is
  'Counted units this line has added to inventory so far.';

alter table public.inventory_aliases
  add column if not exists counted_per_purchase numeric;

comment on column public.inventory_aliases.counted_per_purchase is
  'Last confirmed counted units per purchase for this receipt wording.';

-- When the boxes physically showed up -- set by the first receiving, or by a
-- manager reporting a delivery nobody uploaded a receipt for.
alter table public.purchase_orders
  add column if not exists arrived_at timestamptz;

alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in ('pending', 'partial', 'received', 'needs_receipt'));

-- ── Receiving ────────────────────────────────────────────────────────────────
-- p_lines: [{ item_id, received_quantity, counted_per_purchase, inventory_id? }]
--   received_quantity    purchased units arriving now (added to what came before)
--   counted_per_purchase counted units per purchased unit, as confirmed on screen
--   inventory_id         present = (re)map the line; null = not tracked
-- Returns the order's new status: 'received' once every line has arrived in
-- full, otherwise 'partial', which stays open for the rest.
create or replace function public.receive_purchase_order(
  p_po_id            uuid,
  p_lines            jsonb,
  p_received_by_name text default null
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_line   jsonb;
  v_item   public.purchase_order_items%rowtype;
  v_inv_id uuid;
  v_qty    numeric;
  v_per    numeric;
  v_count  numeric;
  v_prev   numeric;
  v_new    numeric;
  v_name   text;
  v_norm   text;
  v_status text;
begin
  if not public.is_owner_or_staff() then
    raise exception 'Only admins and managers can receive deliveries';
  end if;

  -- Lock the order so two people confirming at once queue up instead of racing.
  perform 1 from public.purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'That purchase order no longer exists';
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into v_item
    from public.purchase_order_items
    where id = (v_line ->> 'item_id')::uuid and purchase_order_id = p_po_id;
    if not found then
      continue;
    end if;

    v_qty := coalesce((v_line ->> 'received_quantity')::numeric, 0);
    v_per := coalesce((v_line ->> 'counted_per_purchase')::numeric, v_item.counted_per_purchase, 1);
    v_inv_id := case when v_line ? 'inventory_id'
                     then nullif(v_line ->> 'inventory_id', '')::uuid
                     else v_item.inventory_id end;
    if v_qty < 0 or v_per <= 0 then
      raise exception 'Arrived amounts must be 0 or more, and "counts as" more than 0';
    end if;
    v_count := v_qty * v_per;

    update public.purchase_order_items
    set received_quantity    = coalesce(received_quantity, 0) + v_qty,
        received_count       = coalesce(received_count, 0) + v_count,
        counted_per_purchase = v_per,
        inventory_id         = v_inv_id
    where id = v_item.id;

    if v_inv_id is not null and v_count > 0 then
      -- Add to the live number rather than one read earlier by the browser.
      update public.inventory
      set quantity         = coalesce(quantity, 0) + v_count,
          expected_arrival = null,
          updated_at       = now()
      where id = v_inv_id
      returning quantity - v_count, quantity, name into v_prev, v_new, v_name;

      if found then
        insert into public.inventory_log
          (inventory_id, item_name, previous_quantity, new_quantity, change_amount,
           change_type, changed_by_id, changed_by_name)
        values
          (v_inv_id, v_name, v_prev, v_new, v_count, 'restock', auth.uid(), p_received_by_name);
      end if;
    end if;

    -- Remember the match and pack size for this wording, the same normalization
    -- the receipt review screen uses, so the next receipt maps itself.
    v_norm := btrim(regexp_replace(lower(v_item.raw_name), '[^a-z0-9]+', ' ', 'g'));
    if v_inv_id is not null and v_norm <> '' then
      insert into public.inventory_aliases (inventory_id, raw_name_norm, counted_per_purchase, created_by)
      values (v_inv_id, v_norm, v_per, auth.uid())
      on conflict (raw_name_norm) do update
        set inventory_id         = excluded.inventory_id,
            counted_per_purchase = excluded.counted_per_purchase;
    end if;
  end loop;

  select case
           when count(*) = 0 then 'received'
           when bool_and(coalesce(received_quantity, 0) >= quantity) then 'received'
           else 'partial'
         end
  into v_status
  from public.purchase_order_items
  where purchase_order_id = p_po_id;

  update public.purchase_orders
  set status      = v_status,
      arrived_at  = coalesce(arrived_at, now()),
      received_at = case when v_status = 'received' then now() else received_at end
  where id = p_po_id;

  return v_status;
end;
$$;

grant execute on function public.receive_purchase_order(uuid, jsonb, text) to authenticated;

-- Check it:
--   select status, count(*) from public.purchase_orders group by status;
