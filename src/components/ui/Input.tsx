import React from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className = '', ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label className="text-xs font-mono text-gray-400 uppercase tracking-wide">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={[
            'w-full bg-[#0f1117] border rounded px-3 py-2 text-sm font-mono text-white placeholder-gray-600',
            'focus:outline-none focus:ring-1 transition-all duration-150',
            error
              ? 'border-red-500 focus:ring-red-500/50'
              : 'border-[#2a2d3e] focus:border-[#00e5ff] focus:ring-[#00e5ff]/30',
            className,
          ].join(' ')}
          {...props}
        />
        {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
        {hint && !error && <p className="text-xs text-gray-500 font-mono">{hint}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
