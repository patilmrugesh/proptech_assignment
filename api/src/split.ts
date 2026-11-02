export type Allocation = { memberId: string; amountCents: number }

/**
 * Splits `totalCents` between members. Everyone gets the rounded-down share;
 * the leftover cents go one each to the first members, in the order given.
 * 1000 between 3 -> 334, 333, 333. The amounts always add up to `totalCents`.
 */
export function splitAmongMembers(
  totalCents: number,
  members: ReadonlyArray<{ id: string }>,
): Allocation[] {
  const base = Math.floor(totalCents / members.length)
  const remainder = totalCents % members.length
  return members.map((member, index) => ({
    memberId: member.id,
    amountCents: base + (index < remainder ? 1 : 0),
  }))
}
