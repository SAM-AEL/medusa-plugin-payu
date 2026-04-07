export const PAYU_DEFAULT_TIMEOUT_MS = Number(process.env.PAYU_API_TIMEOUT_MS || 30000)

export function isRetryablePayuStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
}
