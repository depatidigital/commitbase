// yarn check:ai-money — selling the AI gateway's buy prices: the charge and the cap.
import assert from 'node:assert/strict';
import { buyableWith, chargeFor, factorOf, sellPerMillion } from './aiGatewayService';

const p = { rate: 18_200, markup: 1.044 };
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

console.log('ai money: ok');
