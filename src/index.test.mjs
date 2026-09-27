import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { analyze, parseQuery, verifyAndSpend, getPaymentConfig } from './index.mjs';
const { payTo: PAY_TO, priceRaw: PRICE_RAW } = getPaymentConfig();

test('exact integer sequence candidate with explicit epistemic limit', () => {
  const args = parseQuery('https://example.test/v1/analyze?terms=0,1,4,9,16,25,36&predict=2');
  const result = analyze(args);
  assert.equal(result.candidate_degree, 2);
  assert.deepEqual(result.next_values, ['49', '64']);
  assert.match(result.limit, /not a proof/);
  assert.equal(analyze(parseQuery('https://example.test/v1/analyze?terms=1,2,4,8,16')).candidate_degree, null);
});

test('unpaid valid request returns 402 and bad input is rejected before payment', async () => {
  const unpaid = await worker.fetch(new Request('https://example.test/v1/analyze?terms=0,1,4,9,16,25,36'), {});
  assert.equal(unpaid.status, 402);
  const terms = await unpaid.json();
  assert.equal(terms.pay_to, PAY_TO);
  assert.equal(terms.price_raw, PRICE_RAW.toString());
  const bad = await worker.fetch(new Request('https://example.test/v1/analyze?terms=1,2,wat'), {});
  assert.equal(bad.status, 400);
});

function memoryDb() {
  const credits = new Map();
  return {
    prepare(sql) {
      let args;
      return {
        bind(...value) { args = value; return this; },
        async first() {
          const hash = args[0];
          if (sql.startsWith('SELECT')) {
            const row = credits.get(hash);
            return row ? { remaining: row.remaining } : null;
          }
          if (sql.startsWith('UPDATE')) {
            const row = credits.get(hash);
            if (!row || row.remaining <= 0) return null;
            row.remaining--;
            return { remaining: row.remaining };
          }
          throw Error('unexpected SQL');
        },
        async run() {
          if (!sql.startsWith('INSERT OR IGNORE')) throw Error('unexpected SQL');
          if (!credits.has(args[0])) credits.set(args[0], { remaining: args[1] });
        },
      };
    },
  };
}

test('confirmed exact Nano send buys one call, replay is exhausted', async () => {
  const db = memoryDb();
  const hash = 'A'.repeat(64);
  const verify = async url => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('hash'), hash);
    assert.equal(params.get('to'), PAY_TO);
    return new Response(JSON.stringify({
      ok: true, confirmed: true, subtype: 'send', to: PAY_TO, amount_raw: PRICE_RAW.toString(),
    }), { status: 200 });
  };
  assert.deepEqual(await verifyAndSpend(hash, db, verify), { ok: true, remaining: 0 });
  assert.deepEqual(await verifyAndSpend(hash, db, verify), { ok: false, reason: 'credit_exhausted' });
});

test('reject unconfirmed, wrong recipient, and old large-size payment', async () => {
  for (const proof of [
    { ok: true, confirmed: false, subtype: 'send', to: PAY_TO, amount_raw: PRICE_RAW.toString() },
    { ok: true, confirmed: true, subtype: 'send', to: 'nano_wrong', amount_raw: PRICE_RAW.toString() },
    { ok: true, confirmed: true, subtype: 'send', to: PAY_TO, amount_raw: (PRICE_RAW * 2800n).toString() },
  ]) {
    const result = await verifyAndSpend('B'.repeat(64), memoryDb(),
      async () => new Response(JSON.stringify(proof), { status: 200 }));
    assert.equal(result.ok, false);
  }
});
