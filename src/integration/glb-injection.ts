export const DEFAULT_GLB_INJECTION_URL = 'http://localhost:8002/'

/**
 * The accepted V0.4 injector remains a standalone application. The editor only
 * owns a configurable navigation entry and never copies or mutates that tool.
 */
export function resolveGlbInjectionUrl(configured?: string): string {
  const candidate = configured?.trim()
  if (!candidate) return DEFAULT_GLB_INJECTION_URL
  try {
    return new URL(candidate).toString()
  } catch {
    return DEFAULT_GLB_INJECTION_URL
  }
}

export function glbInjectionUrlWithReturn(configured: string, returnUrl: string): string {
  const target = new URL(resolveGlbInjectionUrl(configured))
  target.searchParams.set('returnUrl', returnUrl)
  return target.toString()
}
