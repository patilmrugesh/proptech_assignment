export type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
export type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}
export type Balance = { memberId: string; name: string; outstandingCents: number }

const TIMEOUT_MS = 10_000

/** Turns anything thrown (network down, timeout, API error) into a message a person can read. */
export function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The server took too long to answer. Please try again.'
  }
  if (error instanceof TypeError) return 'Could not reach the server. Check your connection.'
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(path, { ...init, signal: controller.signal })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const apiMessage =
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof data.error === 'string'
          ? data.error
          : null
      throw new Error(apiMessage ?? `Request failed (${response.status})`)
    }
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

export async function getBills(homeId: string): Promise<Bill[]> {
  const data = await request<{ bills: Bill[] }>(`/api/homes/${encodeURIComponent(homeId)}/bills`)
  return data.bills
}

export async function getBalances(homeId: string): Promise<Balance[]> {
  const data = await request<{ balances: Balance[] }>(
    `/api/homes/${encodeURIComponent(homeId)}/balances`,
  )
  return data.balances
}

export function payShare(billId: string, shareId: string, idempotencyKey: string): Promise<Share> {
  return request<Share>(
    `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
  )
}
