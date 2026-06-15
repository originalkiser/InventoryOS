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
          <label className="text-xs font-heading text-inky uppercase tracking-wide">
            {label}
          </label>
        )}
        <select
          ref={ref}
          className={[
            'w-full bg-cream border rounded px-3 py-2 text-sm font-body text-navy',
            'focus:outline-none focus:ring-2 focus:ring-sky transition-all duration-150 appearance-none',
            error
              ? 'border-[#C0392B] focus:ring-[#C0392B]/30'
              : 'border-navy/40 focus:border-sky',
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
        {error && <p className="text-xs text-[#C0392B] font-body">{error}</p>}
      </div>
    )
  }
)

Select.displayName = 'Select'
