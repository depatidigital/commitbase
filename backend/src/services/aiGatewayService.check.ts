// yarn check:ai-money — selling the AI gateway's buy prices: the charge and the cap.
import assert from 'node:assert/strict';
import { buyableWith, capFactorOf, chargeFor, chargeRouted, factorOf, optimaFactorOf, sellPerMillion } from './aiGatewayService';

const p = { rate: 18_200, markup: 1.044, optimaMarkup: 1.15 };
const f = factorOf(p);
assert.equal(f, 190_008_000n, '18,200 × 1.044 = 19,000.8 IDR per USD, ×10⁴');

// $1 bought (1,000,000 micro-USD) is charged Rp 19,000.8 (19,000,800,000 micro-IDR)
assert.equal(chargeFor(1_000_000n, f), 19_000_800_000n);
// a sliver of a cent still costs something, rounded up — never zero
assert.equal(chargeFor(1n, f), 19_001n, '1 micro-USD = 19,000.8 micro-IDR, up to 19,001');
assert.equal(chargeFor(0n, f), 0n);

// the cap: a balance buys back exactly what it would be charged, never more
assert.equal(buyableWith(19_000_800_000n, f), 1_000_000n);
assert.equal(buyableWith(19_000_799_999n, f), 999_999n, 'short by one micro-rupiah: one micro-dollar less');
assert.equal(buyableWith(0n, f), 0n);
assert.equal(buyableWith(-5_000_000n, f), 0n, 'a negative balance buys nothing');
// what the cap lets through, charged, never exceeds the balance
for (const balance of [1n, 999n, 19_001n, 123_456_789n, 50_000_000_000n]) {
  assert.ok(chargeFor(buyableWith(balance, f), f) <= balance, `balance ${balance}`);
}

// Rp 50,000 of credit buys ≈ $2.63 at buy price
assert.equal(buyableWith(50_000n * 1_000_000n, f), 2_631_468n);

// price list: deepseek-flash off-peak output $0.60 / 1M → ≈ Rp 11,400 / 1M
assert.equal(Math.round(sellPerMillion(0.6, p)), 11_400);

// larika-optima: its calls at its own markup; caps at the dearer of the two
assert.equal(chargeFor(1_000_000n, optimaFactorOf(p)), 20_930_000_000n, '$1 routed = Rp 20,930 (18,200 × 1.15)');
assert.equal(capFactorOf(p), optimaFactorOf(p));
assert.equal(capFactorOf({ ...p, optimaMarkup: 1.0 }), f, 'a cheaper optima markup: the normal one caps');
// a cap computed at the dearer markup never lets routed calls overdraw the balance
for (const balance of [19_001n, 50_000_000_000n]) assert.ok(chargeFor(buyableWith(balance, capFactorOf(p)), optimaFactorOf(p)) <= balance);

// a routed turn: charged only out of what it saved
const routed = (cost: bigint, routing: bigint, baseline: bigint | null) => chargeRouted(cost, routing, baseline, p);
// saved a lot (flash instead of the top model): model + routing at 1.15
assert.equal(routed(9n, 7n, 315n), chargeFor(16n, optimaFactorOf(p)), 'the full service fee comes out of a big saving');
// stayed on the top model (cost = baseline): the normal price, routing and surcharge waived
assert.equal(routed(315n, 7n, 315n), chargeFor(315n, f), 'saved nothing: pays nothing extra');
// saved a little: never more than the top model at the normal markup
assert.equal(routed(300n, 7n, 315n), chargeFor(315n, f), 'held to the top model price');
// the routed model cost more than the baseline (cache effects): its own normal price, never below
assert.equal(routed(400n, 7n, 315n), chargeFor(400n, f), 'never below the normal price of what ran');
// a tool loop carried on (no baseline): the normal price
assert.equal(routed(200n, 0n, null), chargeFor(200n, f));
// never above the ceiling nor below the floor, whatever the numbers
for (const [c, r, b] of [[1n, 1n, 1n], [5n, 50n, 10n], [1_000_000n, 0n, 2_000_000n], [7n, 7n, 3n]] as const) {
  const v = routed(c, r, b);
  assert.ok(v >= chargeFor(c, f), `floor ${c}/${r}/${b}`);
  assert.ok(v <= (chargeFor(b, f) > chargeFor(c, f) ? chargeFor(b, f) : chargeFor(c, f)), `ceiling ${c}/${r}/${b}`);
}

console.log('ai money: ok');
