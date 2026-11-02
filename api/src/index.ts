import type { Context } from 'hono'
import { Hono } from 'hono'
import { splitAmongMembers } from './split'

const app = new Hono<{ Bindings: Env }>()

type MemberRow = { id: string; name: string }
type BillRow = { id: string; title: string; total_cents: number }
type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}
type BillShareRow = ShareRow & { bill_id: string }

// ---------- small helpers ----------

type Body = Record<string, unknown>

async function readBody(c: Context): Promise<Body | null> {
  const body: unknown = await c.req.json().catch(() => null)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  return body as Body
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isPositiveWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function homeExists(db: D1Database, homeId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  return row !== null
}

// ---------- routes ----------

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Part 1: homes and members

app.post('/api/homes', async (c) => {
  const name = nonBlankString((await readBody(c))?.name)
  if (!name) return c.json({ error: 'name must be a non-empty string' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return c.json({ error: 'home not found' }, 404)

  const name = nonBlankString((await readBody(c))?.name)
  if (!name) return c.json({ error: 'name must be a non-empty string' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()
  return c.json({ id, homeId, name }, 201)
})

// Part 2: bills

app.post('/api/homes/:homeId/bills', async (c) => {
  const db = c.env.DB
  const homeId = c.req.param('homeId')
  if (!(await homeExists(db, homeId))) return c.json({ error: 'home not found' }, 404)

  const body = await readBody(c)
  const title = nonBlankString(body?.title)
  if (!title) return c.json({ error: 'title must be a non-empty string' }, 422)
  const totalCents = body?.totalCents
  if (!isPositiveWholeNumber(totalCents)) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const { results: members } = await db
    .prepare('SELECT id, name FROM members WHERE home_id = ? ORDER BY rowid')
    .bind(homeId)
    .all<MemberRow>()
  if (members.length === 0) return c.json({ error: 'home has no members' }, 422)

  const billId = crypto.randomUUID()
  const shares = splitAmongMembers(totalCents, members).map((allocation) => ({
    id: crypto.randomUUID(),
    memberId: allocation.memberId,
    amountCents: allocation.amountCents,
    paidAt: null,
  }))

  // batch() runs in one transaction: the bill and all its shares exist together or not at all.
  await db.batch([
    db
      .prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind(billId, homeId, title, totalCents),
    ...shares.map((share) =>
      db
        .prepare('INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)')
        .bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ])

  return c.json({ id: billId, homeId, title, totalCents, shares }, 201)
})

// Read side used by the web page: bills of a home (newest first) with their shares.
app.get('/api/homes/:homeId/bills', async (c) => {
  const db = c.env.DB
  const homeId = c.req.param('homeId')
  if (!(await homeExists(db, homeId))) return c.json({ error: 'home not found' }, 404)

  const { results: bills } = await db
    .prepare('SELECT id, title, total_cents FROM bills WHERE home_id = ? ORDER BY rowid DESC')
    .bind(homeId)
    .all<BillRow>()
  const { results: shareRows } = await db
    .prepare(
      `SELECT s.id, s.bill_id, s.member_id, s.amount_cents, s.paid_at, s.idempotency_key
       FROM shares s JOIN bills b ON b.id = s.bill_id
       WHERE b.home_id = ? ORDER BY s.rowid`,
    )
    .bind(homeId)
    .all<BillShareRow>()

  const sharesByBill = new Map<
    string,
    Array<{ id: string; memberId: string; amountCents: number; paidAt: string | null }>
  >()
  for (const row of shareRows) {
    const list = sharesByBill.get(row.bill_id) ?? []
    list.push({
      id: row.id,
      memberId: row.member_id,
      amountCents: row.amount_cents,
      paidAt: row.paid_at,
    })
    sharesByBill.set(row.bill_id, list)
  }

  return c.json({
    bills: bills.map((bill) => ({
      id: bill.id,
      homeId,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: sharesByBill.get(bill.id) ?? [],
    })),
  })
})

// Pay a share. Safe to retry (same key) and safe under concurrency (single atomic UPDATE).
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400)

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const db = c.env.DB

  // Only one request can flip paid_at from NULL; SQLite serialises writes, so the loser changes 0 rows.
  await db
    .prepare(
      'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
    )
    .bind(new Date().toISOString(), key, shareId, billId)
    .run()

  const share = await db
    .prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
    )
    .bind(shareId, billId)
    .first<ShareRow>()
  if (!share) return c.json({ error: 'bill or share not found' }, 404)

  // Paid with *our* key: either we just paid it, or this is a replay. Same answer both times.
  if (share.idempotency_key === key) {
    return c.json({
      id: share.id,
      memberId: share.member_id,
      amountCents: share.amount_cents,
      paidAt: share.paid_at,
    })
  }
  return c.json({ error: 'share already paid with a different Idempotency-Key' }, 409)
})

// Balances: unpaid total per member, members in the order they were added.
app.get('/api/homes/:homeId/balances', async (c) => {
  const db = c.env.DB
  const homeId = c.req.param('homeId')
  if (!(await homeExists(db, homeId))) return c.json({ error: 'home not found' }, 404)

  const { results } = await db
    .prepare(
      `SELECT m.id AS memberId, m.name AS name, COALESCE(SUM(s.amount_cents), 0) AS outstandingCents
       FROM members m
       LEFT JOIN shares s ON s.member_id = m.id AND s.paid_at IS NULL
       WHERE m.home_id = ?
       GROUP BY m.id
       ORDER BY m.rowid`,
    )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: results })
})

// ---------- errors: always JSON { error } ----------

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
