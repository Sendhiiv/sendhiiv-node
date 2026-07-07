# Sendhiiv Node.js SDK

Official Node.js client for the [Sendhiiv](https://sendhiiv.com) email API.
Zero dependencies, works on Node 18+.

```bash
npm install sendhiiv
```

## Quickstart

```js
const { Sendhiiv } = require("sendhiiv");
// or: import { Sendhiiv } from "sendhiiv";

const sendhiiv = new Sendhiiv(process.env.SENDHIIV_API_KEY);

const result = await sendhiiv.messages.send({
  from: "Acme <hello@yourdomain.com>",
  to: "customer@example.com",
  subject: "Welcome aboard",
  html: "<p>Hi there, your account is ready.</p>",
});

console.log(result.message); // "1 email(s) queued for delivery"
```

Get an API key from your [Sendhiiv dashboard](https://app.sendhiiv.com) —
the free tier includes 3,000 emails/month.

## Sending options

```js
await sendhiiv.messages.send({
  to: ["a@example.com", "b@example.com"], // string, array, or comma-separated
  subject: "March invoice",
  templateKey: "brand-layout",            // saved layout or message template
  html: "<p>Your invoice is attached.</p>",
  variables: { firstName: "Ada" },        // fills {{firstName}} merge tags
  replyTo: "billing@yourdomain.com",
  attachments: [
    {
      filename: "invoice.pdf",
      content: base64Pdf,                 // base64 string
      contentType: "application/pdf",
    },
  ],
});
```

Drip mode spreads large recipient lists into scheduled batches:

```js
await sendhiiv.messages.send({
  to: recipients,
  subject: "Product update",
  html,
  sendMode: "drip",
  batchSize: 100,             // default 50, max 500
  batchIntervalMinutes: 30,   // default 15, max 1440
});
```

## Error handling

Every non-2xx response throws a `SendhiivError` with `status`, `code`, and
the full response `body`:

```js
const { SendhiivError } = require("sendhiiv");

try {
  await sendhiiv.messages.send({ to, subject, html });
} catch (err) {
  if (err instanceof SendhiivError) {
    switch (err.code) {
      case "CONTENT_COMPLIANCE_BLOCKED":
        console.error("Blocked:", err.compliance.reasons);
        break;
      case "ATTACHMENT_TOO_LARGE": // 413 — 10 MB total limit
      case "INVALID_ATTACHMENTS":  // 400
      default:
        console.error(`HTTP ${err.status}:`, err.message);
    }
  }
}
```

| Status | Meaning |
| --- | --- |
| 202 | Accepted — message(s) queued for delivery |
| 400 | Invalid request (missing `to`, bad attachments, content blocked by compliance review — check `code`) |
| 401 | Missing, invalid, or revoked API key |
| 402 | Pay-as-you-go balance exhausted |
| 403 | Plan does not include API access |
| 413 | Attachments exceed 10 MB total |
| 429 | Rate limit (100 requests/min) or plan quota reached |

## Retries and timeouts

The SDK retries **only** HTTP 429 responses (honoring `Retry-After`), because
the rate limiter runs before anything is queued — a retry can never
double-send. Network errors and 5xx responses are not retried automatically,
since the message may already have been accepted. Sendhiiv itself retries
temporary delivery failures server-side after a message is queued.

```js
const sendhiiv = new Sendhiiv({
  apiKey: process.env.SENDHIIV_API_KEY,
  timeoutMs: 30000, // per-request timeout (default 30s)
  maxRetries: 2,    // 429 retries (default 2)
});
```

## License

MIT
