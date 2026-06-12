import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// Catches render-time crashes in a subtree and shows the error instead of a
// blank/unresponsive page. Reset by changing the `key` prop (e.g. per route).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surfaced in the console for diagnosis
    console.error('Render error caught by ErrorBoundary:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center py-16 px-6 font-mono">
          <div className="max-w-lg w-full bg-[#161820] border border-red-500/40 rounded-lg p-6 flex flex-col gap-3">
            <div className="text-red-400 text-sm font-semibold uppercase tracking-wide">Something went wrong</div>
            <p className="text-gray-300 text-xs leading-relaxed">
              This screen hit an error and stopped rendering. The details below help diagnose it:
            </p>
            <pre className="text-[11px] text-red-300 bg-[#0f1117] border border-[#2a2d3e] rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
            </pre>
            <div className="flex gap-2">
              <button onClick={() => this.setState({ error: null })}
                className="text-xs font-mono text-[#00e5ff] border border-[#00e5ff]/30 rounded px-3 py-1.5 hover:bg-[#00e5ff]/10">
                Try again
              </button>
              <button onClick={() => window.location.reload()}
                className="text-xs font-mono text-gray-400 border border-[#2a2d3e] rounded px-3 py-1.5 hover:border-gray-500">
                Reload page
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
