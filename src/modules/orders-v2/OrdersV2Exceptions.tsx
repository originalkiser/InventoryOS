import { useNavigate } from 'react-router-dom'
import { ProductExceptionsManager } from './ProductExceptionsManager'

/**
 * Standalone Product Exceptions page — the actual add/list/edit UI lives in
 * ProductExceptionsManager, shared with the modal Orders v2 Review opens in
 * place (see that file's own header comment).
 */
export function OrdersV2Exceptions() {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Product Exceptions</h1>
        <p className="text-xs text-inky mt-0.5">
          Shop+product overrides on top of the regular order config. A floor removes on-hand that's there but not
          usable; a ceiling hard-caps how far this one shop/product can be ordered up, overriding its regular
          capacity. Also editable from a shop's own Order Config on Location Lookup — click the Exception cell there.
        </p>
      </div>
      <ProductExceptionsManager />
    </div>
  )
}
