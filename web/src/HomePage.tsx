import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Balance,
  type Bill,
  getBalances,
  getBills,
  messageOf,
  payShare,
  type Share,
} from './api'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const formatCents = (cents: number) => money.format(cents / 100)

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; bills: Bill[]; balances: Balance[] }

type Props = { homeId: string | undefined; onSelectHome: (id: string) => void }

export function HomePage({ homeId, onSelectHome }: Props) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [paying, setPaying] = useState<ReadonlySet<string>>(new Set())
  const [payErrors, setPayErrors] = useState<Record<string, string | undefined>>({})
  // One key per share, reused on retries, so a retry after a timeout can never pay twice.
  const keys = useRef(new Map<string, string>())
  const latestLoad = useRef(0)

  const load = useCallback(async (id: string, silent: boolean) => {
    const ticket = ++latestLoad.current
    if (!silent) setState({ status: 'loading' })
    try {
      const [bills, balances] = await Promise.all([getBills(id), getBalances(id)])
      if (ticket === latestLoad.current) setState({ status: 'ready', bills, balances })
    } catch (error) {
      if (!silent && ticket === latestLoad.current) {
        setState({ status: 'error', message: messageOf(error) })
      }
    }
  }, [])

  useEffect(() => {
    if (homeId) void load(homeId, false)
    else setState({ status: 'idle' })
  }, [homeId, load])

  async function pay(bill: Bill, share: Share) {
    if (paying.has(share.id) || !homeId) return
    const key = keys.current.get(share.id) ?? crypto.randomUUID()
    keys.current.set(share.id, key)
    setPaying((previous) => new Set(previous).add(share.id))
    setPayErrors((previous) => ({ ...previous, [share.id]: undefined }))
    try {
      const paid = await payShare(bill.id, share.id, key)
      keys.current.delete(share.id)
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              bills: current.bills.map((b) =>
                b.id === bill.id
                  ? { ...b, shares: b.shares.map((s) => (s.id === paid.id ? paid : s)) }
                  : b,
              ),
            }
          : current,
      )
      void load(homeId, true) // refresh the balances quietly
    } catch (error) {
      // The share stays unpaid in the UI; the person can retry.
      setPayErrors((previous) => ({ ...previous, [share.id]: messageOf(error) }))
    } finally {
      setPaying((previous) => {
        const next = new Set(previous)
        next.delete(share.id)
        return next
      })
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <h1>Shared Bill Splitter</h1>
        <p>See who owes what in your home and settle up.</p>
        <HomePicker key={homeId ?? ''} initial={homeId ?? ''} onSubmit={onSelectHome} />
      </header>

      {state.status === 'idle' && (
        <Notice title="Choose a home" text="Enter a home ID above to see its bills." />
      )}

      {state.status === 'loading' && <Skeleton />}

      {state.status === 'error' && (
        <Notice
          tone="error"
          title="Couldn’t load this home"
          text={state.message}
          action={
            homeId ? { label: 'Try again', onClick: () => void load(homeId, false) } : undefined
          }
        />
      )}

      {state.status === 'ready' && (
        <>
          <Balances balances={state.balances} />
          {state.bills.length === 0 ? (
            <Notice title="No bills yet" text="Bills added to this home will show up here." />
          ) : (
            state.bills.map((bill) => (
              <BillCard
                key={bill.id}
                bill={bill}
                names={new Map(state.balances.map((b) => [b.memberId, b.name]))}
                paying={paying}
                errors={payErrors}
                onPay={(share) => void pay(bill, share)}
              />
            ))
          )}
        </>
      )}
    </main>
  )
}

function HomePicker({ initial, onSubmit }: { initial: string; onSubmit: (id: string) => void }) {
  const [draft, setDraft] = useState(initial)
  return (
    <form
      className="picker"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.trim()) onSubmit(draft.trim())
      }}
    >
      <input
        aria-label="Home ID"
        placeholder="Home ID"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" disabled={!draft.trim()}>
        Open home
      </button>
    </form>
  )
}

function Balances({ balances }: { balances: Balance[] }) {
  if (balances.length === 0) return null
  return (
    <section aria-label="Outstanding balances" className="balances">
      {balances.map((balance) => (
        <div key={balance.memberId} className="balance">
          <span>{balance.name}</span>
          <strong className={balance.outstandingCents === 0 ? 'settled' : ''}>
            {balance.outstandingCents === 0 ? 'Settled' : formatCents(balance.outstandingCents)}
          </strong>
        </div>
      ))}
    </section>
  )
}

type BillCardProps = {
  bill: Bill
  names: Map<string, string>
  paying: ReadonlySet<string>
  errors: Record<string, string | undefined>
  onPay: (share: Share) => void
}

function BillCard({ bill, names, paying, errors, onPay }: BillCardProps) {
  const paidCount = bill.shares.filter((share) => share.paidAt !== null).length
  return (
    <article className="card">
      <div className="card-head">
        <h2>{bill.title}</h2>
        <div className="total">{formatCents(bill.totalCents)}</div>
      </div>
      <p className="muted">
        {paidCount} of {bill.shares.length} paid
      </p>
      <ul className="shares">
        {bill.shares.map((share) => (
          <li key={share.id}>
            <div className="share-row">
              <span className="who">{names.get(share.memberId) ?? 'Unknown member'}</span>
              <span className="amount">{formatCents(share.amountCents)}</span>
              {share.paidAt ? (
                <span className="badge paid">Paid</span>
              ) : (
                <button type="button" disabled={paying.has(share.id)} onClick={() => onPay(share)}>
                  {paying.has(share.id) ? 'Paying…' : 'Pay'}
                </button>
              )}
            </div>
            {errors[share.id] && (
              <p role="alert" className="inline-error">
                Payment failed: {errors[share.id]}
              </p>
            )}
          </li>
        ))}
      </ul>
    </article>
  )
}

type NoticeProps = {
  title: string
  text: string
  tone?: 'error'
  action?: { label: string; onClick: () => void } | undefined
}

function Notice({ title, text, tone, action }: NoticeProps) {
  return (
    <div className={`notice ${tone ?? ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

function Skeleton() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading bills…</p>
      <div className="skeleton" />
      <div className="skeleton tall" />
    </div>
  )
}
