// Nano-paid exact finite-difference analysis. No private keys or wallet access.
const PAY_TO = 'nano_13gz94zfz7747o4tag8t8y1yw7bmzzroi84ez7wg1fqu5iiju4r37ut7abrk';
const PRICE_RAW = 10n ** 27n; // 0.001 XNO
const MAX_CREDIT_RAW = 10n ** 30n; // 1 XNO maximum per payment hash
const VERIFY_URL = 'https://pursekeeper.dev/v1/verify';
const HASH_RE = /^[0-9A-Fa-f]{64}$/;
export function getPaymentConfig() { return { payTo: PAY_TO, priceRaw: PRICE_RAW }; }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function parseQuery(url) {
  const query = new URL(url).searchParams;
  const raw = query.get('terms');
  if (!raw || raw.length > 1250) throw new Error('terms must be 3 to 64 comma-separated integers');
  const parts = raw.split(',');
  if (parts.length < 3 || parts.length > 64 || parts.some(s => !/^-?(0|[1-9]\d*)$/.test(s))) {
    throw new Error('terms must be 3 to 64 comma-separated integers');
  }
  const values = parts.map(s => BigInt(s));
  if (values.some(n => n < -(10n ** 18n) || n > 10n ** 18n)) {
    throw new Error('each term must have magnitude at most 10^18');
  }
  const degreeRaw = query.get('max_degree') ?? '6';
  const predictRaw = query.get('predict') ?? '3';
  if (!/^(0|[1-9]\d*)$/.test(degreeRaw) || !/^(0|[1-9]\d*)$/.test(predictRaw)) {
    throw new Error('max_degree and predict must be nonnegative integers');
  }
  const maxDegree = Number(degreeRaw);
  const predict = Number(predictRaw);
  if (maxDegree > 12 || predict > 10) throw new Error('max_degree <= 12 and predict <= 10');
  return { values, maxDegree, predict };
}

export function analyze({ values, maxDegree, predict }) {
  const rows = [values];
  for (let i = 0; i < Math.min(maxDegree + 1, values.length - 1); i++) {
    const prev = rows.at(-1);
    rows.push(prev.slice(1).map((n, j) => n - prev[j]));
  }
  let degree = null;
  for (let d = 0; d <= Math.min(maxDegree, rows.length - 1); d++) {
    if (values.length >= 2 * d + 3 && rows[d].every(n => n === rows[d][0])) {
      degree = d;
      break;
    }
  }
  if (degree === null) return {
    candidate_degree: null, checked_terms: values.length, next_values: [],
    limit: 'No polynomial of the requested degree passed the minimum-sample and exact-difference checks.',
  };
  const coefficients = rows.slice(0, degree + 1).map(row => row[0]);
  const next = [];
  // Newton forward extrapolation by extending the last entries of each difference row.
  const tails = rows.slice(0, degree + 1).map(row => row.at(-1));
  for (let i = 0; i < predict; i++) {
    for (let d = degree - 1; d >= 0; d--) tails[d] += tails[d + 1];
    next.push(tails[0].toString());
  }
  return {
    candidate_degree: degree,
    newton_coefficients: coefficients.map(n => n.toString()),
    next_values: next,
    checked_terms: values.length,
    limit: 'Exact fit on the supplied finite sample; continuation is a conjecture, not a proof.',
  };
}

function paymentRequired() {
  return json({
    error: 'payment_required', network: 'nano:mainnet', asset: 'XNO',
    pay_to: PAY_TO, price_raw: PRICE_RAW.toString(), price_nano: '0.001',
    pay_header: 'X-Nano-Payment: <confirmed send block hash>',
    credit: 'A confirmed send from 0.001 to 1 XNO, in exact multiples of 0.001 XNO, gives one call per 0.001 XNO. The hash is a bearer token; whoever presents it first can use its credit.',
  }, 402);
}

export async function verifyAndSpend(hash, db, verify = fetch) {
  const existing = await db.prepare('SELECT remaining FROM credits WHERE hash = ?').bind(hash).first();
  if (!existing) {
    const url = new URL(VERIFY_URL);
    url.searchParams.set('hash', hash);
    url.searchParams.set('to', PAY_TO);
    url.searchParams.set('min_raw', PRICE_RAW.toString());
    const response = await verify(url.toString(), { headers: { accept: 'application/json' } });
    if (!response.ok) return { ok: false, reason: 'payment_not_verified' };
    const proof = await response.json();
    if (proof.ok !== true || proof.confirmed !== true || proof.subtype !== 'send' ||
        proof.to !== PAY_TO || !/^\d+$/.test(String(proof.amount_raw ?? ''))) {
      return { ok: false, reason: 'payment_not_verified' };
    }
    const amount = BigInt(proof.amount_raw);
    if (amount < PRICE_RAW || amount > MAX_CREDIT_RAW || amount % PRICE_RAW !== 0n) {
      return { ok: false, reason: 'payment_amount_not_supported' };
    }
    await db.prepare('INSERT OR IGNORE INTO credits(hash, remaining, amount_raw) VALUES (?, ?, ?)')
      .bind(hash, Number(amount / PRICE_RAW), amount.toString()).run();
  }
  // One atomic decrement means concurrent requests cannot spend one credit twice.
  const result = await db.prepare('UPDATE credits SET remaining = remaining - 1 WHERE hash = ? AND remaining > 0 RETURNING remaining')
    .bind(hash).first();
  return result ? { ok: true, remaining: result.remaining } : { ok: false, reason: 'credit_exhausted' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.pathname === '/' || url.pathname === '/v1/price') {
      return json({
        service: 'Exact finite-difference sequence check',
        endpoint: '/v1/analyze?terms=0,1,4,9,16,25,36&predict=2',
        network: 'nano:mainnet', pay_to: PAY_TO, price_raw: PRICE_RAW.toString(),
        price_nano: '0.001', documentation: 'The output is a finite-sample polynomial candidate, never proof of the true next term.',
        source: 'https://github.com/Pururin-ux/nano-sequence-api',
      });
    }
    if (url.pathname !== '/v1/analyze') return json({ error: 'not_found' }, 404);
    let args;
    try { args = parseQuery(request.url); }
    catch (error) { return json({ error: 'invalid_input', detail: error.message }, 400); }
    const hash = request.headers.get('X-Nano-Payment')?.trim().toUpperCase();
    if (!hash) return paymentRequired();
    if (!HASH_RE.test(hash)) return json({ error: 'invalid_payment_hash' }, 400);
    if (!env.DB) return json({ error: 'service_unavailable' }, 503);
    let payment;
    try { payment = await verifyAndSpend(hash, env.DB); }
    catch { return json({ error: 'payment_verification_unavailable' }, 503); }
    if (!payment.ok) return json({ error: payment.reason, pay_to: PAY_TO, price_raw: PRICE_RAW.toString() }, 402);
    return json({ ...analyze(args), payment: { remaining_calls: payment.remaining } });
  },
};
