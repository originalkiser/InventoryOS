import React, { useRef, useState } from 'react'
import { parseFile } from '@/lib/fileParser'
import type { ParseResult } from '@/lib/fileParser'

interface FileUploadZoneProps {
  onParsed: (result: ParseResult, file: File) => void
  accept?: string
  label?: string
}

export function FileUploadZone({
  onParsed,
  accept = '.csv,.xlsx,.xls',
  label = 'Drop a CSV or Excel file here, or click to browse',
}: FileUploadZoneProps) {
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFile, setLastFile] = useState<{ name: string; rows: number; skipped: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setError(null)
    setLoading(true)
    try {
      const result = await parseFile(file)
      setLastFile({ name: file.name, rows: result.totalRowsParsed, skipped: result.skippedRows })
      onParsed(result, file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file')
    } finally {
      setLoading(false)
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      className={[
        'relative flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg cursor-pointer transition-all duration-200 min-h-[140px]',
        dragging
          ? 'border-[#00e5ff] bg-[#00e5ff]/5 shadow-[0_0_20px_rgba(0,229,255,0.15)]'
          : 'border-[#2a2d3e] bg-[#0f1117] hover:border-[#00e5ff]/50 hover:bg-[#00e5ff]/5',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={onInputChange}
      />

      {loading ? (
        <div className="flex flex-col items-center gap-2">
          <svg className="animate-spin w-8 h-8 text-[#00e5ff]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-xs text-gray-400 font-mono">Parsing file...</span>
        </div>
      ) : lastFile ? (
        <div className="flex flex-col items-center gap-1 text-center">
          <svg className="w-8 h-8 text-[#39ff14]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm font-mono text-white">{lastFile.name}</span>
          <span className="text-xs text-gray-400 font-mono">
            {lastFile.rows.toLocaleString()} rows detected
            {lastFile.skipped > 0 && ` · ${lastFile.skipped} header rows skipped`}
          </span>
          <span className="text-xs text-[#00e5ff]/60 font-mono mt-1">Click to replace</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-center pointer-events-none">
          <svg className="w-10 h-10 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <span className="text-sm text-gray-400 font-mono">{label}</span>
          <span className="text-xs text-gray-600 font-mono">CSV, XLSX, XLS</span>
        </div>
      )}

      {error && (
        <div className="mt-3 text-xs text-red-400 font-mono text-center">{error}</div>
      )}
    </div>
  )
}
