// Shared delivery-time logic for the order, sticker, and subscribe pages.
//
// High school deliveries follow the bell schedule stored in store_config under
// 'delivery_schedule': a list of times for each weekday plus a per-slot cap.
// Full slots are left out of the lists below. The server checks again before
// anyone is charged, so these lists only need to be helpful, not airtight.
// See supabase/migrations/20260911_delivery_slots_and_capacity.sql.
//
// Pickups and Mathews keep using the older flat 'delivery_times' list.
//
// Loaded as a plain script; everything below is a global, matching the rest
// of the site.

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The schedule, or null if the migration has not been run yet. */
async function loadDeliverySchedule(sb) {
  const { data } = await sb.from('store_config').select('value').eq('key', 'delivery_schedule').maybeSingle();
  return data?.value?.days ? data.value : null;
}

function isoDate(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

/** Keeps the scheduled times the server says have room. If the lookup fails,
 *  every scheduled time is offered and the server has the final say. */
function keepTimesWithRoom(scheduled, data, error) {
  if (error || !Array.isArray(data)) {
    if (error) console.warn('Delivery slot availability lookup failed', error);
    return scheduled;
  }
  const open = new Set(data.filter(r => r.has_room).map(r => r.slot_time));
  return scheduled.filter(t => open.has(t));
}

/** Times with room on one date, for a one-time order. */
async function openDeliveryTimesForDate(sb, schedule, date) {
  const scheduled = schedule?.days?.[WEEKDAY_NAMES[date.getDay()]] || [];
  if (!scheduled.length) return [];
  const { data, error } = await sb.rpc('delivery_slots_for_date', { p_date: isoDate(date) });
  return keepTimesWithRoom(scheduled, data, error);
}

/** Times with room every week on this weekday, for a subscription. */
async function openDeliveryTimesForWeekday(sb, schedule, dayName) {
  const scheduled = schedule?.days?.[dayName] || [];
  if (!scheduled.length) return [];
  const { data, error } = await sb.rpc('delivery_slots_for_weekday', { p_day: dayName });
  return keepTimesWithRoom(scheduled, data, error);
}
