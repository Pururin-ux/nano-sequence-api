# Nano sequence API

A public, pay-per-call exact finite-difference checker for integer sequences.
The endpoint finds the lowest tested polynomial degree whose difference row is
constant with at least `2*degree+3` supplied terms. It returns exact integer
coefficients and candidate next terms. A finite fit **does not prove** the
unseen sequence follows that pattern.

## Use

`GET /v1/analyze?terms=0,1,4,9,16,25,36&predict=2` returns HTTP 402 with
the Nano mainnet receiving address and price. Send exactly 0.001 XNO (or a
multiple up to 1 XNO) to the displayed address and retry with:

`X-Nano-Payment: <confirmed send block hash>`

The service independently asks Pursekeeper's public `/v1/verify` endpoint to
confirm the send, its recipient and amount. One 0.001-XNO unit buys one call.
Credit is consumed atomically in Cloudflare D1. A payment hash is a bearer
credential: anyone who obtains it may spend unused calls. The service refuses
payments above 1 XNO, non-multiples of 0.001 XNO, unconfirmed sends, and
payments to other addresses. It holds no wallet key and cannot move funds.

`GET /` and `GET /v1/price` provide public discovery. Invalid input is
rejected before any credit is consumed. Valid terms are 3–64 integers of
magnitude at most 10^18; `max_degree` defaults to 6 (up to 12), and `predict`
defaults to 3 (up to 10). All returned integers are decimal strings to avoid
JavaScript rounding.

## Deployment

Run `npm install`, `npm test`, then create a Cloudflare D1 database named
`nano-sequence-credits`. Replace the placeholder `database_id` in
`wrangler.jsonc` with the returned UUID; run `wrangler d1 execute
nano-sequence-credits --remote --file=./schema.sql` and `wrangler deploy`.
Only the Workers Free plan is intended; no billing method or paid tier is
needed. The D1 schema and payment verifier are included in this repository.

The initial receiving address has five documented pre-launch receipts, none
of which is within the supported payment interval and exact unit rule. A
future version should use a dedicated wallet address to guarantee rejection
of **all** pre-launch sends. Do not claim that this version enforces a strict
payment timestamp: Pursekeeper's public verifier does not return one.
