CREATE TABLE IF NOT EXISTS credits (
  hash TEXT PRIMARY KEY,
  remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= 1000),
  amount_raw TEXT NOT NULL
);
