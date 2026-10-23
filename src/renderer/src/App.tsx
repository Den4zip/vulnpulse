function App(): React.JSX.Element {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-slate-950 text-slate-200">
      <h1 className="text-4xl font-bold text-emerald-400">VulnPulse Desktop</h1>
      <p className="text-lg text-slate-400">SecOps / AppSec Vulnerability Hub</p>
      <p className="text-sm text-slate-500">{window.electronAPI.ping()}</p>
    </div>
  )
}

export default App
