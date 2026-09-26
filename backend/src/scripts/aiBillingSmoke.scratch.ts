// Scratch integration test (not committed): Larika's AI billing against a running gateway.
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { encrypt } from '../lib/secretBox';
import { setLarikaAiValue } from '../services/integrationConfigService';
import { addWalletEntry, aiGateway, billAiUsage, buyableWith, chargeFor, factorOf, aiPricing, syncAiCap } from '../services/aiGatewayService';

const GW = 'http://localhost:4200';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await setLarikaAiValue('baseUrl', GW);
  await setLarikaAiValue('adminKey', encrypt(process.env.AI_ADMIN_KEY!));
  await setLarikaAiValue('rate', '18200');
  await setLarikaAiValue('markup', '1.044');
  const f = factorOf(await aiPricing());

  const org = await prisma.organization.create({ data: { name: 'AI smoke', slug: `ai-smoke-${Date.now()}` } });
  const account = await aiGateway<{ id: string }>('/admin/accounts', { method: 'POST', body: { name: org.name } });
  await prisma.aiAccount.create({ data: { organizationId: org.id, accountId: account.id } });
  await syncAiCap(org.id);
  let acc = await aiGateway(`/admin/accounts/${account.id}`);
  assert.equal(acc.spendCap, '0', 'no balance: cap 0');

  // Rp 1,000 credited → cap = what Rp 1,000 buys
  assert.equal(await addWalletEntry({ organizationId: org.id, kind: 'ADJUST', amount: 1_000_000_000n, ref: `smoke:${org.id}` }), true);
  assert.equal(await addWalletEntry({ organizationId: org.id, kind: 'ADJUST', amount: 1_000_000_000n, ref: `smoke:${org.id}` }), false, 'same ref twice credits once');
  acc = await aiGateway(`/admin/accounts/${account.id}`);
  assert.equal(BigInt(acc.spendCap), buyableWith(1_000_000_000n, f));
  console.log('cap after Rp 1,000:', acc.spendCap, 'micro-USD');

  const key = await aiGateway<{ key: string }>(`/admin/accounts/${account.id}/keys`, { method: 'POST', body: { name: 'smoke', rpm: 100 } });
  const call = () =>
    fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 't-ok', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
    }).then((r) => r.status);
  for (let i = 0; i < 5; i++) assert.equal(await call(), 200);

  await sleep(6_000); // the feed hands out rows older than 5 s
  console.log('bill 1:', await billAiUsage());
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: org.id } });
  const expected = 1_000_000_000n - 5n * chargeFor(164n, f);
  assert.equal(wallet.balance, expected, 'five calls of 164 micro-USD each charged');
  const entries = await prisma.walletEntry.findMany({ where: { organizationId: org.id, kind: 'AI_USAGE' } });
  assert.equal(entries.length, 1, 'one entry per day and model');
  assert.equal(entries[0].amount, -5n * chargeFor(164n, f));
  const row = await prisma.aiAccount.findUniqueOrThrow({ where: { organizationId: org.id } });
  assert.equal(row.billedSpent, 5n * 164n);
  acc = await aiGateway(`/admin/accounts/${account.id}`);
  assert.equal(BigInt(acc.spendCap), 5n * 164n + buyableWith(expected, f), 'cap = billed + what the balance still buys');
  console.log('balance', wallet.balance, 'cap', acc.spendCap, 'spent', acc.spent);

  console.log('bill 2 (nothing new):', await billAiUsage());
  assert.equal((await prisma.wallet.findUniqueOrThrow({ where: { organizationId: org.id } })).balance, expected, 'billing twice charges once');

  // drain: take the balance down to Rp 0.5 → the next call's reserve no longer fits
  await addWalletEntry({ organizationId: org.id, kind: 'ADJUST', amount: -(expected - 500_000n), ref: `smoke-drain:${org.id}` });
  assert.equal(await call(), 402, 'balance too low: refused');
  console.log('ai billing: ok');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
