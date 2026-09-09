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

/* --- period maps: `GET /account/prices` quotes whole periods, mixing types --- */

const periodMap = (value: unknown): Record<number, number> => {
  const periods: Record<number, number> = {};
  if (!value || typeof value !== 'object') return periods;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const years = Number.parseInt(key, 10);
    const price = num(raw);
    if (Number.isFinite(years) && years > 0 && price !== null) periods[years] = price;
  }
  return periods;
};

// shape taken verbatim from a live /account/prices row (.co.id)
assert.deepStrictEqual(periodMap({ '1': 270000, '2': 540000, '5': 1350000 }), {
  1: 270000,
  2: 540000,
  5: 1350000,
});
// renewal values arrive as strings for some extensions
assert.deepStrictEqual(periodMap({ '1': '275000', '2': '550000.00' }), { 1: 275000, 2: 550000 });
assert.deepStrictEqual(periodMap({ '0': 100, bad: 5, '3': null }), {});
assert.deepStrictEqual(periodMap(null), {});

console.log('ok - 4 period map cases');
