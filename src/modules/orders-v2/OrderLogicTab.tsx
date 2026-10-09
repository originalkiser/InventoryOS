import type { ReactNode } from 'react'
import { Card, CardBody } from '@/components/ui'
import { TAG_DEFS, type TagKey } from './lineFlags'
import { RECENT_ORDER_DAYS } from './engine'
import type { OrderSettings } from './types'

/**
 * "Order Logic" — a read-only, plain-language walkthrough of how an order generates itself, in the order the engine
 * (engine.ts) actually does it. Numbers shown are the live Shared Order Settings, so this page can't drift from the
 * rules in effect; anything not configurable here is a fixed rule of the engine.
 */

const Setting = ({ children }: { children: ReactNode }) => (
  <span className="inline-block rounded border border-sky/60 bg-sky/20 px-1.5 py-px text-[11px] font-mono font-bold text-navy">{children}</span>
)

function FlagChip({ k }: { k: TagKey }) {
  const d = TAG_DEFS[k]
  return (
    <span title={d.description} className="inline-flex items-center gap-1 rounded-full border border-navy/20 bg-cream px-2 py-px text-[10px] font-mono text-navy">
      <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />{d.label}
    </span>
  )
}

function Rule({ step, title, summary, children, flags }: { step?: string; title: string; summary: string; children: ReactNode; flags?: TagKey[] }) {
  return (
    <Card><CardBody className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        {step && <span className="flex-shrink-0 w-7 h-7 rounded-full bg-navy text-cream text-xs font-heading font-bold grid place-items-center">{step}</span>}
        <div className="min-w-0">
          <h4 className="text-sm font-heading font-bold text-navy">{title}</h4>
          <p className="text-xs font-body text-navy/80">{summary}</p>
        </div>
      </div>
      <ul className="list-disc pl-5 text-xs font-body text-navy/90 flex flex-col gap-1 marker:text-inky">{children}</ul>
      {flags && flags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-navy/10">
          <span className="text-[10px] font-mono uppercase tracking-wide text-inky">Flags you'll see</span>
          {flags.map((k) => <FlagChip key={k} k={k} />)}
        </div>
      )}
    </CardBody></Card>
  )
}

function Phase({ n, title, blurb }: { n: string; title: string; blurb: string }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky">{n}</span>
      <div>
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">{title}</h3>
        <p className="text-[11px] font-mono text-inky">{blurb}</p>
      </div>
      <div className="flex-1 border-t border-navy/15" />
    </div>
  )
}

export function OrderLogicTab({ settings: s }: { settings: OrderSettings }) {
  const minTypeNote = 'Each vendor can override the company default minimum on the Shared tab.'
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-navy/20 bg-cream p-3 text-xs font-body text-navy/90">
        This is how every order builds itself, top to bottom. <Setting>Highlighted values</Setting> are your current Shared Order
        Settings — change them there and this page updates. Hover a flag to see what it means.
      </div>

      <div className="rounded border border-navy/15 p-3 grid grid-cols-1 md:grid-cols-4 gap-2 text-center">
        {[
          ['1', 'Know the numbers', 'on hand + usage'],
          ['2', 'Pick what is due', 'trigger → how much'],
          ['3', 'Reach the minimum', 'smoothing + floors'],
          ['4', 'Flag the result', 'review before sending'],
        ].map(([n, t, d]) => (
          <div key={n} className="rounded border border-navy/15 px-2 py-2">
            <div className="text-[10px] font-mono uppercase tracking-widest text-inky">Step {n}</div>
            <div className="text-xs font-heading font-bold text-navy">{t}</div>
            <div className="text-[10px] font-mono text-inky">{d}</div>
          </div>
        ))}
      </div>

      <Phase n="STEP 1" title="Know the numbers" blurb="What the engine believes about each shop × product before it decides anything." />

      <Rule step="1a" title="On hand" summary="Whatever is physically at the shop, combined across equivalent case types."
        flags={['combined_on_hand']}>
        <li>Comes from Droptop's inventory — except <strong>VMI / keep-fill</strong> products, which use the tank monitor's reading (no monitor reading = flagged for review, never guessed).</li>
        <li><strong>Combined on hands:</strong> case types of the same product (same name, different ending letters — e.g. 5W30BB, 5W30D, 5W30C) are one product for stock. Their on hand adds together, hover the On Hand number to see the math.</li>
        <li>A product with no inventory record of its own still picks up its siblings' stock.</li>
      </Rule>

      <Rule step="1b" title="Daily usage" summary="Quarts sold in the last 30 days ÷ 30 — days with no sales count as days.">
        <li>A product that sold 5 qts in 30 days uses 0.17 qts/day, not 5.</li>
        <li>Sibling case types combine their usage too — <strong>even a sibling with nothing on the shelf right now</strong>, because it sold through its stock and the demand moves to the case type you order.</li>
        <li><strong>Days of supply (DOS)</strong> = on hand ÷ daily usage. With no usage there is no DOS.</li>
      </Rule>

      <Phase n="STEP 2" title="Pick what is due" blurb="Pass 1 — each product on its own, before any order minimum is considered." />

      <Rule step="2a" title="Which shops and products are considered" summary="Only products that should be ordered this run.">
        <li>RelaDyne orders only the shops whose <strong>order day</strong> is the selected weekday. An ad hoc order uses exactly the shops you picked instead.</li>
        <li>VMI / keep-fill products are generated for visibility but start <strong>excluded</strong> from the order total — the vendor refills them. A runway check flags tanks that won't last to the delivery after next.</li>
        <li>A configured order limit of 0 means the product is inactive and is never considered.</li>
      </Rule>

      <Rule step="2b" title="When a product is due" summary="Either of two triggers makes a product due. Neither → it isn't ordered."
        flags={['dos_now_low', 'dos_now_below_target', 'critical_minimum']}>
        <li><strong>Low days of supply:</strong> DOS is below the min trigger (<Setting>{s.days_of_supply_min_trigger} days</Setting>).</li>
        <li><strong>Critical minimum:</strong> on hand is at or below the product's critical minimum (e.g. enough for one oil change), set per product in Order Settings → Product Minimums & Order-Alone Exceptions. This works even when usage is tiny or zero.</li>
      </Rule>

      <Rule step="2c" title="How much to order" summary="Enough to reach the target, never past a hard limit."
        flags={['over_dos_max', 'capacity_capped', 'bulk_capacity_limited', 'drum_capped']}>
        <li>Target = fill to <Setting>{s.days_of_supply_target} days</Setting> of supply: (target × usage − on hand) ÷ package size, rounded <strong>up</strong> to a whole unit (down when a cap binds).</li>
        <li><strong>DOS max</strong> (<Setting>{s.days_of_supply_max} days</Setting>) is a <em>soft</em> ceiling — the first pass stops there, but smoothing may go past it and says so with an "Over DOS max" flag.</li>
        <li><strong>Capacity is a hard limit.</strong> On hand + the order never exceeds the shop's configured capacity for the product. For <strong>bulk</strong> this is always true — there is nowhere for extra quarts to go. When capacity is what stops a bulk order short of the DOS target, the line is flagged "Bulk: ordered to capacity" (next to DOS After) with how much was needed in the note.</li>
        <li>The one exception: for <strong>package</strong> product, a vendor can opt in (toggle on the Shared tab) to ordering past capacity to reach the target. Those lines are flagged "Over capacity: DOS target" with the real numbers in the note.</li>
        <li><strong>Drums</strong> are ordered 1 per product, however many the target calls for — the note reads "ordering 1 but N needed for dos target".</li>
        <li>Bulk quantities round to the nearest <Setting>{s.bulk_rounding_increment} gal</Setting>; cases, drums and bay boxes are always whole units.</li>
      </Rule>

      <Rule step="2d" title="Critical minimum & products with no usage" summary="A product with no usage is only ever ordered because it hit its critical minimum — and then only one case."
        flags={['critical_minimum']}>
        <li><strong>Usage is 0 and on hand is at or below the critical minimum → order exactly 1 case.</strong> No more. (Bulk is the exception: a vendor won't ship 1 gallon, so a bulk product at its critical minimum orders the full per-product minimum, e.g. 55 gallons.)</li>
        <li>That line is never topped up by smoothing, the case-type minimum, or any other rule that adds quantity.</li>
        <li><strong>No usage and above the critical minimum → not ordered</strong>, and never pulled onto an order to help reach a minimum.</li>
        <li>A product with usage that is at or below its critical minimum is sized normally (target math above), with at least 1 unit.</li>
      </Rule>

      <Rule step="2e" title="Recently ordered" summary={`A product ordered in the last ${RECENT_ORDER_DAYS} days isn't ordered again unless it's truly needed.`}
        flags={['recently_ordered', 'repeat_ordering']}>
        <li>The earlier order's quantity is counted as on hand, whether or not the shop has updated its inventory since the delivery.</li>
        <li>If on hand + that order still reads under the min trigger (or critical minimum), it's due again. Otherwise it stays on the order at <strong>0</strong> with a note, so you can add a quantity if it should go anyway.</li>
        <li>Separately, if more than <Setting>{s.flag_cumulative_dos_over} days</Setting> of supply were ordered across the last <Setting>{s.flag_cumulative_days} days</Setting> and it still reads low, it's flagged "Repeat ordering" (informational only — usually deliveries not being received or inventory not updated).</li>
      </Rule>

      <Phase n="STEP 3" title="Reach the minimum" blurb="Pass 2 — per shop, package and bulk checked separately." />

      <Rule step="3a" title="Order minimums" summary="Each shop's package order and bulk order must reach its minimum."
        flags={['below_minimum']}>
        <li>Company defaults — package: <Setting>{minLabel(s.package_minimum_type, s.order_minimum_dollars_package, s.package_minimum_qty)}</Setting>, bulk: <Setting>{minLabel(s.bulk_minimum_type, s.order_minimum_dollars_bulk, s.bulk_minimum_qty)}</Setting>. {minTypeNote}</li>
        <li>Types: <strong>dollars per order</strong>, <strong>units per order</strong> (smoothed like dollars), or a <strong>per-product</strong> floor (gallons/units on each line).</li>
        <li>A shop that still can't reach its minimum after everything below is flagged "Under order min", and the row turns red.</li>
      </Rule>

      <Rule step="3b" title="Smoothing" summary="When a shop is under its dollar / units minimum, close the gap in this exact order. Smoothing only ever uses products with usage."
        flags={['smoothing_topped_up', 'added_for_smoothing', 'over_dos_max', 'no_products_to_meet_min']}>
        <li><strong>1 · Top up what's already ordered</strong>, most efficient first (least extra days of supply per dollar added), only up to the DOS max (<Setting>{s.days_of_supply_max} days</Setting>).</li>
        <li><strong>2 · Add other products the shop carries</strong> that have usage and are under <Setting>{s.skip_order_if_dos_over} days</Setting> of supply — a well-stocked product is never dragged on just to hit a minimum.</li>
        <li><strong>3 · Go past the DOS max</strong> on the lines already ordered, still within capacity — flagged "Over DOS max".</li>
        <li>Still short after all three → every line at that shop gets "No products to add" with a note.</li>
        <li><strong>Smoothing needs usage:</strong> a product with no usage is never added as a spare and a no-usage (critical-minimum) line is never topped up. Capacity is never exceeded by smoothing, ever.</li>
      </Rule>

      <Rule step="3c" title="Per-product, case-type and special minimums" summary="Floors that apply to a line (or a case type) rather than the shop's total."
        flags={['rounded_to_bulk_minimum', 'case_minimum_topup', 'alone_default_qty', 'hm0806_solo_min']}>
        <li><strong>Bulk per-product minimum</strong> (a full drum): a line is rounded up to it only if its own demand is at least <Setting>{s.bulk_round_up_threshold_gal} gal</Setting>. Below that it is dropped — unless days of supply is under <Setting>{s.bulk_urgent_dos_threshold} days</Setting>, then it orders the drum early. The note shows the real calculated amount.</li>
        <li><strong>Package per-product minimum</strong> always rounds up to the floor (capacity still wins).</li>
        <li><strong>Case-type minimums</strong> (e.g. N bay boxes per order for Valvoline) top up existing lines that have usage, then pull in spares with usage.</li>
        <li><strong>Ordered alone:</strong> a product set to "ignore minimum when ordered alone" orders its configured alone-quantity instead of being inflated.</li>
        <li><strong>HM0806 solo:</strong> if HM0806 is the only product suggested at a shop, it orders 2 and the order minimum is ignored (no smoothing). It carries its own "HM0806 Solo Min" flag and is never shown as under minimum.</li>
      </Rule>

      <Rule title="Valvoline differences" summary="Valvoline delivers on a per-shop weekly / biweekly schedule, so its orders plan for the delivery date and treat drums specially."
        flags={['drum_alone']}>
        <li><strong>Planned for delivery:</strong> an order placed today can land 2+ weeks out. For Valvoline, due / how much / capacity all use what the shop will have <em>on delivery</em> (on hand run down by usage over the lead time). A product at 15.9 days now but 0.9 days when the truck lands is due.</li>
        <li><strong>DOS Now</strong> is today's actual. <strong>DOS @ Delivery</strong> is the shop's existing stock only, when the truck lands. <strong>DOS After</strong> is that plus what you're ordering, so with nothing ordered DOS After = DOS @ Delivery. The <strong>Delivery Schedule</strong> column writes out each shop's order/delivery schedule.</li>
        <li><strong>Drum alone:</strong> a drum can be ordered by itself — it skips the bay-box minimum, isn't flagged "Under min", and doesn't pull bay boxes onto the order. Bay boxes ordered at the same shop still need to reach their 6-box case-type minimum; the drum is never flagged either way.</li>
        <li><strong>Hold until needed</strong> (optional, Order Settings → Order Timing): a shop is left off today's order when ordering at the next order date (a week later for the Thursday run, a day for a daily cadence) would still reach the same scheduled delivery. Only shops whose delivery would slip to a later date are ordered now. Held shops are listed on Review ("N shops held") with the delivery they'll get and when they're picked up; an ad hoc order is never held, and a shop with no schedule — or one whose calendar can't be read that far ahead — is always ordered.</li>
        <li>RelaDyne and Mighty orders are not affected by any of this.</li>
      </Rule>

      <Phase n="STEP 4" title="Flag the result" blurb="Nothing is sent automatically — every order is reviewed first." />

      <Rule step="4" title="Review" summary="Flags and row colors explain every decision; edit any quantity before sending.">
        <li><strong>Flags – Before</strong> describe the shop/product going in (low DOS, critical min, combined on hands, on an open PO, VMI). <strong>Flags – After</strong> describe what the order did (over capacity, under minimum, smoothing, rounded to a drum…). After-flags update live as you change a quantity.</li>
        <li>A product with an <strong>open PO</strong> outstanding waits for your decision: order anyway, exclude, or count it as on hand and re-target.</li>
        <li>Quantities you change are marked as overrides; Regenerate can keep or discard them.</li>
      </Rule>
    </div>
  )
}

function minLabel(type: OrderSettings['package_minimum_type'], dollars: number, qty: number | null): string {
  if (type === 'dollars') return `$${dollars}`
  if (type === 'units_per_order') return `${qty ?? 0} units / order`
  if (type === 'gallons_per_product') return `${qty ?? 0} gal / product`
  return `${qty ?? 0} units / product`
}
