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
          <label className="text-xs font-heading text-inky uppercase tracking-wide">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={[
            'w-full bg-cream border rounded px-3 py-2 text-sm font-body text-navy placeholder-inky/60',
            'focus:outline-none focus:ring-2 focus:ring-sky transition-all duration-150',
            error
              ? 'border-[#C0392B] focus:ring-[#C0392B]/30'
              : 'border-navy/40 focus:border-sky',
            className,
          ].join(' ')}
          {...props}
        />
        {error && <p className="text-xs text-[#C0392B] font-body">{error}</p>}
        {hint && !error && <p className="text-xs text-inky/70 font-body">{hint}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
