import sbMonoNavy from '@/assets/sb-mono-navy.png'
import sbMonoSky from '@/assets/sb-mono-sky.png'

interface SbLoaderProps {
  sky?: boolean
  size?: number
}

export function SbLoader({ sky, size }: SbLoaderProps) {
  return (
    <span
      className={`sb-loader${sky ? ' sb-loader--sky' : ''}`}
      style={size ? { width: size } : undefined}
      role="status"
      aria-label="Loading"
    >
      <svg viewBox="0 0 100 124" fill="none" aria-hidden="true">
        <path
          className="sb-loader__line"
          d="M50 3 L15.7 41.3 A46 46 0 1 0 84.3 41.3 L50 3 Z"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength="1"
          strokeDasharray="1 1"
        />
      </svg>
      <img className="sb-loader__mark" src={sky ? sbMonoSky : sbMonoNavy} alt="" />
    </span>
  )
}
