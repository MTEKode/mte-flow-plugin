import { readFileSync } from 'node:fs'

/** Version from this package's package.json (src/ sits one level below it). */
export function readPackageVersion(): string {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    )
    const record: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
    return typeof record.version === 'string' ? record.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
