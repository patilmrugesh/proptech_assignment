-- Homes, members, bills and shares.
-- Every constraint is named so an error message points at the rule that fired.

CREATE TABLE homes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  CONSTRAINT homes_name_not_blank CHECK (length(trim(name)) > 0)
);

-- Members are listed in insertion order (rowid). That order decides who gets the extra cents.
CREATE TABLE members (
  id      TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  CONSTRAINT members_home_fk       FOREIGN KEY (home_id) REFERENCES homes (id),
  CONSTRAINT members_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  home_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  CONSTRAINT bills_home_fk        FOREIGN KEY (home_id) REFERENCES homes (id),
  CONSTRAINT bills_title_not_blank CHECK (length(trim(title)) > 0),
  -- Money is whole cents and strictly positive: no decimals, zero or negatives.
  CONSTRAINT bills_total_positive_int CHECK (typeof(total_cents) = 'integer' AND total_cents > 0)
);

CREATE TABLE shares (
  id              TEXT PRIMARY KEY,
  bill_id         TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  paid_at         TEXT,
  idempotency_key TEXT,
  CONSTRAINT shares_bill_fk   FOREIGN KEY (bill_id)   REFERENCES bills (id),
  CONSTRAINT shares_member_fk FOREIGN KEY (member_id) REFERENCES members (id),
  -- One share per member per bill.
  CONSTRAINT shares_one_per_member UNIQUE (bill_id, member_id),
  CONSTRAINT shares_amount_nonneg_int CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  -- A share is either unpaid (no time, no key) or paid (time and key). Never half-paid.
  CONSTRAINT shares_paid_state_consistent CHECK ((paid_at IS NULL) = (idempotency_key IS NULL))
);