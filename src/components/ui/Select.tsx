import React from 'react'

interface SelectOption {
  value: string
  label: string
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: SelectOption[]
  placeholder?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, className = '', ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label className="text-xs font-mono text-gray-400 uppercase tracking-wide">
            {label}
          </label>
        )}
        <select
          ref={ref}
          className={[
            'w-full bg-[#0f1117] border rounded px-3 py-2 text-sm font-mono text-white',
            'focus:outline-none focus:ring-1 transition-all duration-150 appearance-none',
            error
              ? 'border-red-500 focus:ring-red-500/50'
              : 'border-[#2a2d3e] focus:border-[#00e5ff] focus:ring-[#00e5ff]/30',
            className,
          ].join(' ')}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
      </div>
    )
  }
)

Select.displayName = 'Select'
