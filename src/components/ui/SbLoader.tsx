import sbMonoNavy from '@/assets/sb-mono-navy.png'
import sbMonoSky from '@/assets/sb-mono-sky.png'
import { useDarkMode } from '@/hooks/useDarkMode'

interface SbLoaderProps {
  sky?: boolean
  size?: number
}

export function SbLoader({ sky, size }: SbLoaderProps) {
  // Navy-on-dark-background is hard to see — default to the sky variant in
  // dark mode automatically (every existing call site gets this for free,
  // no need to pass sky={true} everywhere) while still honoring an explicit
  // sky prop as a force-override for a caller that wants it regardless of
  // theme (e.g. already sitting on a navy surface in light mode).
  const { dark } = useDarkMode()
  const useSky = sky ?? dark
  return (
    <span
      className={`sb-loader${useSky ? ' sb-loader--sky' : ''}`}
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
      <img className="sb-loader__mark" src={useSky ? sbMonoSky : sbMonoNavy} alt="" />
    </span>
  )
}
