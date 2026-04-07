<p align="center">
  <img src="https://img.shields.io/npm/v/@sam-ael/medusa-plugin-payu?style=flat-square&color=7C3AED" alt="npm version" />
  <img src="https://img.shields.io/badge/medusa-v2-0F172A?style=flat-square" alt="Medusa v2" />
  <img src="https://img.shields.io/badge/category-payment-5B21B6?style=flat-square" alt="payment plugin" />
  <img src="https://img.shields.io/npm/l/@sam-ael/medusa-plugin-payu?style=flat-square" alt="license" />
</p>

# @sam-ael/medusa-plugin-payu

Production-focused PayU India payment provider for Medusa v2 with redirect checkout flow, callback handling, and fraud-aware verification.

## Highlights

- Redirect-based PayU checkout integration for Medusa payment sessions
- Hash generation and reverse-hash verification flow
- Webhook/callback handling for asynchronous payment status
- Hardened callback processing with replay protection
- Constant-time hash comparison and amount discrepancy guards
- Timeout configuration and retry-classification utilities

## Install

```bash
yarn add @sam-ael/medusa-plugin-payu
```

## Medusa Configuration

```ts
modules: [
  {
    resolve: "@medusajs/medusa/payment",
    options: {
      providers: [
        {
          resolve: "@sam-ael/medusa-plugin-payu/providers/payu",
          id: "payu",
          options: {
            merchantKey: process.env.PAYU_MERCHANT_KEY,
            merchantSalt: process.env.PAYU_MERCHANT_SALT,
            environment: process.env.PAYU_ENVIRONMENT || "test",
          },
        },
      ],
    },
  },
]
```

## Environment Variables

```env
PAYU_MERCHANT_KEY=your_merchant_key
PAYU_MERCHANT_SALT=your_merchant_salt
PAYU_ENVIRONMENT=test

STOREFRONT_URL=http://localhost:8000
PAYU_REDIRECT_URL=/order/confirmed
PAYU_REDIRECT_FAILURE_URL=/checkout
PAYU_API_TIMEOUT_MS=30000
```

## Callback Endpoint

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/hooks/payment/payu_payu` | PayU callback/webhook handling via Medusa payment provider |

## Security and Reliability Notes

- Replay guard for repeated callback payloads
- Constant-time hash comparison for webhook verification
- Normalized callback parsing for structured and URL-encoded payload variants
- Amount discrepancy path for underpaid callback reports
- Timeout defaults centralized in provider config helpers

## Quality Gates

```bash
yarn typecheck
yarn lint
yarn test
yarn build
```

Smoke tests are available under `src/tests`.

## License

MIT
