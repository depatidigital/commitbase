/**
 * Price parsing check for the domain search flow.
 * RDASH returns prices as numbers or as formatted strings depending on the
 * account, and Indonesian formatting uses "." for thousands — the exact case
 * a naive parseFloat gets wrong ("Rp 150.000" is 150000, not 150).
 *
 * Run: npx tsx src/services/rdashService.check.ts
 */
import assert from 'node:assert';
import { parsePrice as num } from './rdashService';


const cases: [unknown, number | null][] = [
  [150000, 150000],
  ['150000', 150000],
  ['Rp 150.000', 150000],       // IDR thousands separator, not a decimal point
  ['1.234.567', 1234567],
  ['150000.00', 150000],        // trailing decimals survive
  ['1,234.56', 1234.56],        // US formatting
  ['IDR 249.000/thn', 249000],
  ['', null],
  ['free', null],
  [null, null],
  [undefined, null],
];

for (const [input, expected] of cases) {
  assert.strictEqual(num(input), expected, `num(${JSON.stringify(input)}) => ${num(input)}, want ${expected}`);
}

console.log(`ok - ${cases.length} price parse cases`);
