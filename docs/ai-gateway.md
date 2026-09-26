# AI gateway (Larika side)

Workspaces get an OpenAI-compatible API at **ai.larika.id**. The engine is its
own service — **larika-ai-gateway**, a separate repo built like
larika-wa-gateway; its README holds the engine's design and the concerns.

Status: **planned**.

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

```prisma
/// A workspace's account on the AI gateway. Keys and metered usage live there (accountId).
model AiAccount {
  organizationId String   @id
  accountId      String   @unique
  /// gateway `spent` covered by what was billed so far — the base of the next cap
  billedSpent    BigInt   @default(0)   // micro-USD, buy cost
  createdAt      DateTime @default(now())
  @@map("ai_accounts")
}

/// Rupiah balance of a workspace. `balance` caches the sum of its entries,
/// changed in the same transaction.
model Wallet {
  organizationId String @id
  balance        BigInt @default(0)     // micro-IDR
  @@map("wallets")
}

/// Append-only; corrections are new entries.
model WalletEntry {
  id             String   @id @default(cuid())
  organizationId String
  kind           String   // TOPUP | AI_USAGE | ADJUST | …
  amount         BigInt   // micro-IDR, signed
  /// TOPUP: the payment id; AI_USAGE: `<org>:<day>:<model>` — upserted, so re-reading the feed never charges twice
  ref            String   @unique
  note           String?
  createdAt      DateTime @default(now())
  @@map("wallet_entries")
}
```

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

Every minute (the existing cron):

1. `GET /admin/requests?after=<cursor>` — pages until empty.
2. Charge each request `cost × rate × markup`, added to its entry for the WIB
   day and model (`ref` upsert) — one transaction per page, which also moves
   the cursor and each account's `billedSpent` to the page's last request. A
   crash re-reads the page; the upsert keys keep it from counting twice.
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
- QRIS through a payment gateway; its paid webhook writes a `TOPUP` entry with
  `ref` = the payment id (a repeated webhook credits once) and raises the cap.
  The payment row — credit, PPN, fee, total — stays here for the books.

## Screens

- **Workspace → AI** (owners/admins): created on first open
  (`POST /admin/accounts` + `AiAccount`). Balance in rupiah, top-up, keys
  (DataTable; create in a modal, the key shown once; revoke), usage by day and
  model from the wallet entries, models with their rupiah prices.
- **Superadmin**: gateway config, rate and markup; credit a wallet by hand
  (`ADJUST` with who/why); suspend a workspace's AI (`PATCH … {disabled: true}`).
- **Pricing page**: an AI section — the gateway's models × rate × markup.

All gateway calls go through one service like `larikaGatewayService`
(`gateway()`, `GatewayError`); a workspace reaches only its own account — the
mapping is checked here, the gateway trusts the admin key.

## Open questions

- Markup value: 1.044 (≈ Rp 19,000 at 18,200)?
- Tax consultant: PPN on top-up vs usage; PKP; crediting the providers' PPN.
- The wallet is general (not AI-only) — WhatsApp and hosting can charge it later.
