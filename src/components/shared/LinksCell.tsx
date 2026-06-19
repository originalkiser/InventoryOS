import { useRef, useState } from 'react'

const KNOWN: Record<string, string> = {
  'github.com': 'GitHub',
  'docs.google.com': 'Google Docs',
  'drive.google.com': 'Google Drive',
  'sheets.google.com': 'Google Sheets',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'notion.so': 'Notion',
  'figma.com': 'Figma',
  'dropbox.com': 'Dropbox',
  'sharepoint.com': 'SharePoint',
  'onedrive.live.com': 'OneDrive',
  'confluence.atlassian.com': 'Confluence',
  'trello.com': 'Trello',
  'slack.com': 'Slack',
  'twitter.com': 'Twitter',
  'x.com': 'X (Twitter)',
  'linkedin.com': 'LinkedIn',
  'wikipedia.org': 'Wikipedia',
  'amazon.com': 'Amazon',
}

export function labelFromUrl(raw: string): string {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    const host = u.hostname.replace(/^www\./, '')
    const known = KNOWN[host]
    if (known) {
      if (host === 'github.com') {
        const parts = u.pathname.split('/').filter(Boolean)
        if (parts.length >= 2) return `GitHub: ${parts[0]}/${parts[1]}`
      }
      return known
    }
    const seg = u.pathname.split('/').filter(Boolean)[0]
    return seg ? `${host}/${seg}` : host
  } catch {
    return raw.length > 42 ? raw.slice(0, 42) + '…' : raw
  }
}

export function LinksCell({ links, onSave }: { links: string[]; onSave: (links: string[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function commitDraft() {
    const trimmed = draft.trim()
    if (!trimmed) { setAdding(false); setDraft(''); return }
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    if (!links.includes(url)) onSave([...links, url])
    setDraft('')
    setAdding(false)
  }

  function removeLink(url: string) {
    onSave(links.filter((l) => l !== url))
  }

  return (
    <div className="px-2 py-1 whitespace-normal min-w-0">
      {links.length > 0 && (
        <ul className="space-y-0.5 mb-1">
          {links.map((url) => (
            <li key={url} className="flex items-start gap-1 group min-w-0">
              <span className="mt-0.5 text-inky/30 flex-shrink-0 text-[9px] leading-none select-none">•</span>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-sky hover:underline break-all flex-1 min-w-0"
                title={url}
              >
                {labelFromUrl(url)}
              </a>
              <button
                onClick={() => removeLink(url)}
                className="opacity-0 group-hover:opacity-100 text-[10px] text-inky/40 hover:text-red-400 flex-shrink-0 leading-none mt-0.5 transition-opacity"
                title="Remove link"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitDraft() }
            if (e.key === 'Escape') { setAdding(false); setDraft('') }
          }}
          placeholder="Paste URL…"
          className="w-full text-xs font-mono rounded border border-[#00e5ff] bg-cream px-1.5 py-0.5 text-navy placeholder-inky/40 focus:outline-none"
        />
      ) : (
        <button
          onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0) }}
          className="text-[10px] font-mono text-inky/40 hover:text-sky transition-colors"
        >
          + link
        </button>
      )}
    </div>
  )
}
