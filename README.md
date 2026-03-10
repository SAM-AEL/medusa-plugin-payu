<p align="center">
  <img src="https://img.shields.io/npm/v/@sam-ael/medusa-plugin-payu?style=flat-square&color=8B5CF6" alt="npm version" />
  <img src="https://img.shields.io/badge/medusa-v2-7C3AED?style=flat-square" alt="Medusa v2" />
  <img src="https://img.shields.io/npm/l/@sam-ael/medusa-plugin-payu?style=flat-square" alt="license" />
</p>

# @sam-ael/medusa-plugin-payu

A seamless **PayU India** payment integration for **MedusaJS v2**.

This plugin enables a redirect-based checkout flow with PayU, complete with robust webhook handling to automatically verify and capture transactions even if the user drops off during the redirect.

---

## Features

- 💳 **Seamless Redirection** — Automatically generates the required signature hashes (`form_data`) for the frontend to redirect directly to PayU.
- 🪝 **Robust Webhooks** — Listens for Server-to-Server callbacks from PayU to verify and capture the payment natively in Medusa. 
- 🔒 **Reverse Hash Verification** — Uses SHA-512 to ensure incoming webhooks are authentic and strictly from PayU to prevent tampering.
- ⚙️ **Dual Environments** — Supports `test` and `production` environments configured through environment variables.
- 🛒 **Customer Auto-Fill** — Tries to automatically extract `firstname`, `email`, and `phone` requirements from the Medusa cart’s shipping and billing addresses to fulfill PayU requirements.

---

## Prerequisites

- **MedusaJS v2** (`>= 2.x`)
- A **PayU India** Merchant Account.
- Your PayU **Merchant Key** and **Merchant Salt** (V1 Salt).

---

## Installation

```bash
yarn add @sam-ael/medusa-plugin-payu
```

Or with npm:

```bash
npm install @sam-ael/medusa-plugin-payu
```

---

## Configuration

### 1. Set environment variables

Add your PayU credentials to your `.env` file:

```env
# Required
PAYU_MERCHANT_KEY="your_merchant_key"
PAYU_MERCHANT_SALT="your_merchant_salt" # Note: This plugin uses Salt V1 for hashing!
PAYU_ENVIRONMENT="test"                 # or "production"

# Optional Base URLs (used to build the redirect URLs dynamically based on context)
STOREFRONT_URL="http://localhost:8000"
# PAYU_REDIRECT_URL="/order/confirmed"  
# PAYU_REDIRECT_FAILURE_URL="/checkout" 
```

### 2. Configure the plugin in `medusa-config.ts`

```typescript
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
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
  ],
})
```

### 3. Add to Medusa Admin
Make sure you go into your Medusa Admin → Settings → Regions and add `payu` as a payment provider to your Indian region.

---

## Frontend Integration

PayU requires a redirect-based flow. Because MedusaJS's `initiatePayment` doesn't directly redirect the user natively, the plugin generates the required raw signature hashes and returns them in the `form_data` attribute of the payment session.

You are expected to construct a hidden HTML form using this data and automatically submit it on the frontend to execute the redirect.

> **Note:** PayU requires `firstname`, `email`, and `phone`. The plugin automatically attempts to extract this from the Medusa cart's shipping/billing address. To avoid errors, you can explicitly pass `shipping_address_phone` in the data payload when initializing the payment session.

### Example in React/Next.js

```tsx
"use client"

function PayUPaymentButton({ cart }) {
  const handlePayment = async () => {
    const paymentSession = cart.payment_collection?.payment_sessions?.find(
      (session) => session.provider_id === "pp_payu_payu"
    )

    if (!paymentSession?.data?.form_data) return;

    const { form_data, paymentUrl } = paymentSession.data

    // Create a hidden form to POST to PayU
    const form = document.createElement("form")
    form.method = "POST"
    form.action = paymentUrl

    Object.entries(form_data).forEach(([key, value]) => {
      const input = document.createElement("input")
      input.type = "hidden"
      input.name = key
      input.value = String(value)
      form.appendChild(input)
    })

    document.body.appendChild(form)
    form.submit()
  }

  return <button onClick={handlePayment}>Pay with PayU</button>
}
```

---

## Webhooks (Critical for Production)

Users often close the browser before completing the redirect back to the store. Setting up Server-to-Server callbacks ensures Medusa captures the payment regardless. 

1. Go to your PayU Dashboard → Webhooks.
2. Add your webhook URL: `https://your-medusa-backend.com/hooks/payment/payu_payu`

The plugin handles reverse SHA-512 verification automatically to ensure incoming webhooks are strictly from PayU and have not been tampered with.

---

## Development & Local Testing

When using the `test` environment, use PayU's standard test cards (e.g., `4012 0010 3844 3335`, CVV: `123`, any future expiry). 

Note that for webhook testing locally, you will need a tunneling service like ngrok to expose your local Medusa instance to PayU's webhook dispatcher.

---

## License

MIT
