'use client'

import { useState } from 'react'
import { AlertTriangle, Copy } from 'lucide-react'

interface GenerateUserModalProps {
  onClose: () => void
  onGenerated: () => void
  isSuperAdmin?: boolean
}

interface GeneratedResult {
  email: string
  temporaryPassword: string
}

export default function GenerateUserModal({ onClose, onGenerated, isSuperAdmin = false }: GenerateUserModalProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'EMPLOYEE' | 'ADMIN'>('EMPLOYEE')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<GeneratedResult | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleGenerate() {
    setError('')
    if (!name.trim()) { setError('Name is required'); return }
    if (!email.trim() || !email.includes('@')) { setError('Valid email is required'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/admin/generate-user', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), role }),
      })
      const json = await res.json() as { data: GeneratedResult | null; error: string | null }
      if (!res.ok || !json.data) { setError(json.error ?? 'Failed to generate user'); return }
      setResult(json.data)
      onGenerated()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy() {
    if (!result) return
    await navigator.clipboard.writeText(`Email: ${result.email}\nPassword: ${result.temporaryPassword}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border-default rounded-card w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-mono text-sm tracking-widest uppercase text-text-primary">Generate New User</h2>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary font-mono text-lg">×</button>
        </div>

        {!result ? (
          <div className="flex flex-col gap-4">
            <div>
              <label className="font-mono text-xs text-text-muted uppercase tracking-widest block mb-1">Full Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" className="w-full h-10 bg-background-tertiary border border-border-default rounded-card px-3 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent" />
            </div>
            <div>
              <label className="font-mono text-xs text-text-muted uppercase tracking-widest block mb-1">Email Address *</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" className="w-full h-10 bg-background-tertiary border border-border-default rounded-card px-3 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent" />
            </div>
            <div>
              <label className="font-mono text-xs text-text-muted uppercase tracking-widest block mb-2">Role *</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="role" value="EMPLOYEE" checked={role === 'EMPLOYEE'} onChange={() => setRole('EMPLOYEE')} className="accent-accent" />
                  <span className="font-mono text-xs text-text-secondary">EMPLOYEE</span>
                </label>
                {/* Only Super Admin can create Admin accounts */}
                {isSuperAdmin && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="role" value="ADMIN" checked={role === 'ADMIN'} onChange={() => setRole('ADMIN')} className="accent-accent" />
                    <span className="font-mono text-xs text-text-secondary">ADMIN</span>
                  </label>
                )}
              </div>
              {!isSuperAdmin && (
                <p className="font-mono text-[10px] text-muted mt-1">Only Super Admin can create Admin accounts.</p>
              )}
            </div>
            {error && <p className="font-mono text-xs text-status-danger">{error}</p>}
            <button type="button" onClick={() => void handleGenerate()} disabled={loading} className="w-full h-10 bg-accent text-white font-mono text-xs rounded-card hover:opacity-90 transition-opacity disabled:opacity-50 mt-2">
              {loading ? 'Generating...' : 'Generate Credentials'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[#3F7A0A] text-lg">✓</span>
              <span className="font-mono text-sm text-text-primary">User Created Successfully!</span>
            </div>
            <div className="border-t border-border-default pt-4">
              <p className="font-mono text-xs text-text-muted mb-3">Share these credentials with the user:</p>
              <div className="bg-background-tertiary border border-border-default rounded-card p-3 font-mono text-xs space-y-1">
                <p><span className="text-text-muted">Email:</span> <span className="text-text-primary">{result.email}</span></p>
                <p><span className="text-text-muted">Password:</span> <span className="text-text-primary font-bold">{result.temporaryPassword}</span></p>
              </div>
              <button type="button" onClick={() => void handleCopy()} className="w-full h-9 mt-3 inline-flex items-center justify-center gap-1.5 bg-background-tertiary border border-border-default rounded-card font-mono text-xs text-text-secondary hover:text-text-primary transition-colors">
                {copied ? '✓ Copied!' : <><Copy className="h-3.5 w-3.5" aria-hidden="true" />Copy All</>}
              </button>
              <p className="flex items-center gap-1.5 font-mono text-[10px] text-status-danger mt-3"><AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />This password will NOT be shown again. Copy it now.</p>
            </div>
            <button type="button" onClick={onClose} className="w-full h-10 bg-accent text-white font-mono text-xs rounded-card hover:opacity-90 mt-2">Done</button>
          </div>
        )}
      </div>
    </div>
  )
}
