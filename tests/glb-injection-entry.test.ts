import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GLB_INJECTION_URL,
  glbInjectionUrlWithReturn,
  resolveGlbInjectionUrl,
} from '../src/integration/glb-injection'

const injectorIndex = readFileSync(new URL('../V0.4 GLB metadata import/public/index.html', import.meta.url), 'utf8')
const injectorApp = readFileSync(new URL('../V0.4 GLB metadata import/public/app.js', import.meta.url), 'utf8')

describe('GLB metadata injector entry', () => {
  it('uses the accepted V0.4 service on its default port', () => {
    expect(resolveGlbInjectionUrl()).toBe(DEFAULT_GLB_INJECTION_URL)
    expect(DEFAULT_GLB_INJECTION_URL).toBe('http://localhost:8002/')
  })

  it('allows deployment to override the standalone service URL safely', () => {
    expect(resolveGlbInjectionUrl('https://tools.example.com/inject')).toBe(
      'https://tools.example.com/inject',
    )
    expect(resolveGlbInjectionUrl('not a url')).toBe(DEFAULT_GLB_INJECTION_URL)
  })

  it('carries the current Studio address into the standalone injector', () => {
    expect(glbInjectionUrlWithReturn(DEFAULT_GLB_INJECTION_URL, 'http://localhost:5176/project?id=1')).toBe(
      'http://localhost:8002/?returnUrl=http%3A%2F%2Flocalhost%3A5176%2Fproject%3Fid%3D1',
    )
  })

  it('offers a safe return action inside the injector page', () => {
    expect(injectorIndex).toContain('id="returnStudioBtn"')
    expect(injectorIndex).toContain('返回 Space Model Studio')
    expect(injectorApp).toContain('resolveStudioUrl')
    expect(injectorApp).toContain("new URLSearchParams(window.location.search).get('returnUrl')")
  })
})
