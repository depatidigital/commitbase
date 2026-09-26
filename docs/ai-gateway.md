# AI gateway (Larika side)

Workspaces get an OpenAI-compatible API at **ai.larika.id**. The engine is its
own service — **larika-ai-gateway**, a separate repo built like
larika-wa-gateway; its README holds the engine's design and the concerns.

Status: **built, not deployed.** Wallet, billing loop, spend caps, the workspace
AI API page, the superadmin page (settings, balances, credit by hand). **Not
built:** paid top-up (QRIS, PPN) — until then a superadmin credits wallets by hand.

```
workspace app ──Bearer lk_…──► larika-ai-gateway ──► providers
                                    ▲  meters buy cost, enforces spend caps
Larika ─────────────────────────────┘  /admin/*: accounts, keys, caps, request feed
```

**The split.** The gateway knows buy prices only: it meters what each call cost
to buy and refuses calls past a cap. Everything about money is here —
selling prices and markup, the exchange rate, the wallet, minimum top-up,
payment fees, payments.

## Data

`AiAccount` (workspace → gateway account, and `billedSpent`), `Wallet`
(`balance`, micro-IDR) and `WalletEntry` (append-only, `ref` unique) in
`backend/prisma/schema.prisma`, migration `20260928000000_ai_gateway`.

Plus in `IntegrationConfig`: the gateway's base URL and admin key (`secretBox`),
the feed cursor (last billed request id), the **rate** (IDR per USD, market)
and the **markup** factor.

## Selling price

One factor over the buy price, for every model:

```
charge (IDR) = buy cost (USD, from the gateway) × rate × markup
```

No price table here — the gateway's buy prices × rate × markup are the price
list (Pricing page, the workspace's model list). The rate is the market rate,
set by the superadmin (fetched later); the markup carries QRIS, paying
providers in USD, the rupiah buffer and the margin — e.g. 1.044 ≈ Rp 19,000 per
dollar at 18,200.

## Billing loop

`billAiUsage()` in `backend/src/services/aiGatewayService.ts`, cron job
`ai-billing`, every minute (`CRON_AI_BILLING`):

1. `GET /admin/requests?after=<cursor>` — pages until empty.
2. Charge each request `cost × rate × markup`, added to its entry for the WIB
   day and model (`ref` upsert) — one transaction per page, which also moves
   the cursor and each account's `billedSpent`. The transaction takes an
   advisory lock and re-checks the cursor, so two runs never bill a page twice;
   a crash re-reads the page.
3. For each account it touched, and after every top-up:
   `spendCap = billedSpent + balance ÷ (rate × markup)`
   → `PATCH /admin/accounts/:id {spendCap}`. Balance ≤ 0 → cap = `billedSpent`.

With one factor the cap is exact: the balance converted back to buy dollars.
The only overshoot is the last minute of traffic plus one reserve — the
gateway reserves each request's worst case against the cap before forwarding.
Changing the rate or markup recomputes every cap.

## Top-up

- **Minimum Rp 50,000**, presets 50k / 100k / 250k / 500k / 1 jt. Enough to
  try every model for a while; below it the payment's fixed costs and support
  per top-up outweigh it.
- **The customer pays PPN 11% and the payment fee on top**; the wallet gets the
  whole amount chosen:

  ```
  credit         Rp 100.000   → wallet
  PPN 11%        Rp  11.000
  QRIS fee 0.7%  Rp     782   (on the gross: 111.000 / 0.993 − 111.000)
  pay            Rp 111.782
  ```

  The fee is on what is charged, so it is grossed up; the rates (PPN, fee per
  method) are config, not constants in code.
- **PPN on the top-up, not on usage** — the advance payment is when it is due.
  Needs Larika to be PKP and a tax invoice per top-up; being PKP is also what
  lets the PPN on the providers' bills be credited (gateway concern 1).
  **Confirm with the tax consultant** before launch.
- **To build:** QRIS through a payment gateway; its paid webhook writes a `TOPUP` entry (via
  `addWalletEntry`) with
  `ref` = the payment id (a repeated webhook credits once) and raises the cap.
  The payment row — credit, PPN, fee, total — stays here for the books.

## Screens

- **AI API** (`/ai`, sidebar Services; owners/admins): balance, endpoint and a
  curl example, turn on (creates the gateway account), keys (create — shown
  once — and revoke), usage (wallet entries of the month), models with rupiah
  prices. Routes: `backend/src/routes/ai.ts`.
- **Integrations → AI Gateway** (`/integrations/ai-gateway`, superadmin): URL,
  admin key/path, rate, markup (a change re-syncs every cap); workspace
  balances, credit by hand (`ADJUST`, a note required), suspend/resume.
  Routes: `backend/src/routes/aiGateway.ts`.
- **Pricing page**: an AI section — the gateway's models × rate × markup.

A workspace reaches only its own account — the mapping is checked here, the
gateway trusts the admin key. `yarn check:ai-money` covers the charge and cap math.

## Open questions

- Markup value: 1.044 (≈ Rp 19,000 at 18,200) is the default until set.
- Tax consultant: PPN on top-up vs usage; PKP; crediting the providers' PPN.
- The wallet is general (not AI-only) — WhatsApp and hosting can charge it later.
