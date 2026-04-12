export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error'
  db_writable: boolean
  schema_version: number
  table_count: number
  page_count: number
}

export async function checkHealth(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return await res.json() as HealthResponse
  } catch {
    return null
  }
}

export async function pollHealth(
  port: number,
  timeoutMs = 60_000,
  intervalMs = 2_000
): Promise<HealthResponse | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const health = await checkHealth(port)
    if (health?.status === 'ok') return health
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return null
}
