import { useMemo, useState } from 'react'
import { Card, CardBody, Button, Combobox, Select } from '@/components/ui'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { type ParseResult } from '@/lib/fileParser'
import toast from 'react-hot-toast'

interface Props {
  map: Record<string, string>
  onChange: (m: Record<string, string>) => void
  unmatched: string[]        // raw tank product names not yet resolved
  allTankProducts: string[]  // every distinct tank product name seen
  ourOptions: string[]       // our_part_number values to map to
}

const norm = (s: string) => s.toLowerCase().trim()

export function TankProductMapping({ map, onChange, unmatched, allTankProducts, ourOptions }: Props) {
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [tankCol, setTankCol] = useState('')
  const [ourCol, setOurCol] = useState('')

  const ourOpts = useMemo(() => ourOptions.map((v) => ({ value: v, label: v })), [ourOptions])
  const rawByKey = useMemo(() => { const m = new Map<string, string>(); for (const p of allTankProducts) m.set(norm(p), p); return m }, [allTankProducts])
  const entries = useMemo(() => Object.entries(map).sort((a, b) => (rawByKey.get(a[0]) ?? a[0]).localeCompare(rawByKey.get(b[0]) ?? b[0], undefined, { numeric: true })), [map, rawByKey])

  const setOne = (tankProduct: string, our: string) => {
    const key = norm(tankProduct)
    const next = { ...map }
    if (our) next[key] = our; else delete next[key]
    onChange(next)
  }

  function importFile() {
    if (!parsed || !tankCol || !ourCol) return
    const next = { ...map }
    let n = 0
    for (const row of parsed.rows) {
      const tp = (row[tankCol] ?? '').trim(); const our = (row[ourCol] ?? '').trim()
      if (tp && our) { next[norm(tp)] = our; n++ }
    }
    onChange(next)
    setParsed(null); setTankCol(''); setOurCol('')
    toast.success(`Mapped ${n.toLocaleString()} product${n !== 1 ? 's' : ''}`)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-mono text-inky/60">
        Map tank monitor product names to your product IDs. Manual mappings here take priority over the automatic Vendor Parts (description) match, and feed the “Product ID (Internal)” column and the monitor emails.
      </p>

      {/* Unmatched products — quick per-row matching */}
      <Card>
        <CardBody className="flex flex-col gap-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Unmatched Products ({unmatched.length})</div>
          {unmatched.length === 0 ? (
            <p className="text-xs font-mono text-inky/50">Every tank product resolves to one of your product IDs. 🎉</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {unmatched.map((p) => (
                <div key={p} className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-navy w-56 truncate" title={p}>{p}</span>
                  <span className="text-inky/40">→</span>
                  <div className="w-64">
                    <Combobox options={ourOpts} value={map[norm(p)] ?? ''} onChange={(v) => setOne(p, v)} placeholder="Match to your product…"
                      allowCreate onCreateOption={async (v) => ({ value: v, label: v })} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* File upload — bulk map */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Bulk Upload</div>
          {!parsed ? (
            <FileUploadZone onParsed={(r) => { setParsed(r); setTankCol(r.headers[0] ?? ''); setOurCol(r.headers[1] ?? '') }} label="Drop a CSV / Excel with a tank-product column and a your-product column" />
          ) : (
            <div className="flex flex-col gap-3 border border-navy/30 rounded-lg p-4 bg-cream">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-inky uppercase tracking-wide w-28">Tank product</span>
                <div className="w-56"><Select options={parsed.headers.map((h) => ({ value: h, label: h }))} value={tankCol} onChange={(e) => setTankCol(e.target.value)} /></div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-inky uppercase tracking-wide w-28">Your product</span>
                <div className="w-56"><Select options={parsed.headers.map((h) => ({ value: h, label: h }))} value={ourCol} onChange={(e) => setOurCol(e.target.value)} /></div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={importFile} disabled={!tankCol || !ourCol || tankCol === ourCol}>Import mappings</Button>
                <Button size="sm" variant="secondary" onClick={() => setParsed(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Existing mappings */}
      {entries.length > 0 && (
        <Card>
          <CardBody className="flex flex-col gap-2">
            <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Current Mappings ({entries.length})</div>
            <div className="overflow-auto rounded border border-navy/20 max-h-96">
              <table className="text-xs font-mono w-full">
                <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20 sticky top-0">
                  <th className="text-left px-3 py-2">Tank Product</th><th className="text-left px-3 py-2">Your Product</th><th className="px-3 py-2 w-10"></th>
                </tr></thead>
                <tbody>
                  {entries.map(([k, v]) => (
                    <tr key={k} className="border-b border-navy/10">
                      <td className="px-3 py-1.5 text-navy">{rawByKey.get(k) ?? k}</td>
                      <td className="px-3 py-1.5">
                        <div className="w-56"><Combobox options={ourOpts} value={v} onChange={(nv) => setOne(rawByKey.get(k) ?? k, nv)} allowCreate onCreateOption={async (nv) => ({ value: nv, label: nv })} /></div>
                      </td>
                      <td className="px-3 py-1.5 text-right"><button onClick={() => setOne(rawByKey.get(k) ?? k, '')} className="text-inky/40 hover:text-[#C0392B]" title="Remove mapping">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
