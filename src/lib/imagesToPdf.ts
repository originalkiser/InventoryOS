// Minimal, dependency-free PDF writer for image-only documents.
//
// Each entry becomes one page (US Letter, portrait) with the JPEG scaled to
// fit inside a margin and centred. Used by the Menu Board "Download PDF"
// button: html2canvas snapshots each board page to a JPEG, this stitches
// them into a real .pdf the browser can download. Kept tiny on purpose —
// we only ever embed pre-rasterised JPEGs (DCTDecode), so there's no font
// or vector handling to get wrong.

interface PdfImage {
  /** `data:image/jpeg;base64,...` — must be JPEG, not PNG. */
  jpegDataUrl: string
}

const PAGE_W = 612 // 8.5in @ 72pt
const PAGE_H = 792 // 11in  @ 72pt

function base64ToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Read pixel dimensions straight out of the JPEG's SOF marker. */
function jpegDimensions(bytes: Uint8Array): { w: number; h: number } {
  let i = 2
  while (i < bytes.length - 8) {
    if (bytes[i] !== 0xff) { i++; continue }
    const marker = bytes[i + 1]
    // SOF0..SOF15 carry the frame size; skip DHT/DAC/RST/SOI/EOI.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6]
      const w = (bytes[i + 7] << 8) | bytes[i + 8]
      return { w, h }
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3])
  }
  return { w: PAGE_W, h: PAGE_H }
}

export function imagesToPdf(images: PdfImage[], opts?: { marginPt?: number }): Blob {
  const margin = opts?.marginPt ?? 18
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  let length = 0
  const push = (s: string | Uint8Array) => {
    const b = typeof s === 'string' ? enc.encode(s) : s
    parts.push(b)
    length += b.length
  }

  const n = images.length
  // Object layout: 1 = Catalog, 2 = Pages, then per image k (0-based):
  //   page      = 3 + 3k
  //   contents  = 4 + 3k
  //   image     = 5 + 3k
  const totalObjs = 2 + 3 * n
  const offsets: number[] = new Array(totalObjs + 1).fill(0)

  push('%PDF-1.3\n')

  const startObj = (num: number) => { offsets[num] = length; push(`${num} 0 obj\n`) }
  const endObj = () => push('endobj\n')

  startObj(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\n')
  endObj()

  const kids = images.map((_, k) => `${3 + 3 * k} 0 R`).join(' ')
  startObj(2)
  push(`<< /Type /Pages /Kids [ ${kids} ] /Count ${n} >>\n`)
  endObj()

  images.forEach((img, k) => {
    const bytes = base64ToBytes(img.jpegDataUrl)
    const { w: iw, h: ih } = jpegDimensions(bytes)
    const availW = PAGE_W - margin * 2
    const availH = PAGE_H - margin * 2
    const s = Math.min(availW / iw, availH / ih)
    const dw = iw * s
    const dh = ih * s
    const dx = (PAGE_W - dw) / 2
    const dy = (PAGE_H - dh) / 2

    const pageNum = 3 + 3 * k
    const contentNum = 4 + 3 * k
    const imgNum = 5 + 3 * k

    startObj(pageNum)
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\n`,
    )
    endObj()

    const stream = `q\n${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm\n/Im0 Do\nQ\n`
    startObj(contentNum)
    push(`<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}endstream\n`)
    endObj()

    startObj(imgNum)
    push(
      `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
    )
    push(bytes)
    push('\nendstream\n')
    endObj()
  })

  const xrefStart = length
  push(`xref\n0 ${totalObjs + 1}\n`)
  push('0000000000 65535 f \n')
  for (let i = 1; i <= totalObjs; i++) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`)

  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}
