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

Get an API key from your [Sendhiiv dashboard](https://app.sendhiiv.com) under
**Settings → API**. The free tier includes 3,000 emails/month. Keys look like
`sh_live_...` — keep them in an environment variable, not in code.

## What the package exports

The whole surface is two things:

| Export | What it's for |
| --- | --- |
| `Sendhiiv` | The client. Create one and reuse it for the life of your process. |
| `SendhiivError` | Thrown for any non-2xx response, network failure, or timeout. |

The API currently has one endpoint (`POST /messages`), so
`sendhiiv.messages.send(params)` is the only method you'll call. It returns a
promise that resolves with the queue confirmation or rejects with a
`SendhiivError`. When more endpoints ship they'll appear as new resources on
the client (`sendhiiv.domains`, etc.).

Both CommonJS (`require`) and ES modules (`import`) work, and TypeScript
definitions ship with the package — `SendMessageParams`,
`SendMessageResponse`, `SendhiivConfig`, and `Attachment` are all exported
types, so your editor autocompletes every field below.

The constructor takes either the key itself or a config object:

```js
new Sendhiiv("sh_live_...");
new Sendhiiv({
  apiKey: "sh_live_...",
  timeoutMs: 30000, // per-request timeout (default 30s)
  maxRetries: 2,    // 429 retries only (default 2)
  baseUrl: "https://api.sendhiiv.com/api/v1", // default; override for testing
});
```

## send() parameters, field by field

Fields are camelCase in JS; the SDK converts to the API's snake_case for you
(sending snake_case directly also works, if you're porting raw-fetch code).

| Field | Required | Notes |
| --- | --- | --- |
| `to` | yes | A string, an array, or a comma-separated list. One request with 200 recipients is cheaper than 200 requests. |
| `subject` | usually | Can only be omitted when a *message* template supplies its own subject. |
| `html` | see below | HTML body. When combined with a layout template, this content is placed inside the layout. |
| `text` | see below | Plain-text body. |
| `templateKey` | see below | Key of a saved layout or message template, e.g. `"brand-layout"`. Template keys are listed on the Templates page of the dashboard. |
| `from` | no | Display sender, e.g. `"Acme <hello@yourdomain.com>"`. The domain must be verified in your account. Omit it to send from the shared sender. |
| `replyTo` | no | Reply-To address. |
| `variables` | no | Object of values for `{{merge}}` tags in the subject, body, or template. `{ firstName: "Ada" }` fills `{{firstName}}`. |
| `attachments` | no | Array of `{ filename, content, contentType }` where `content` is base64. 10 MB total per message. |
| `sendMode` | no | Set to `"drip"` to schedule recipients in batches instead of sending all at once. |
| `batchSize` | no | Drip only. Recipients per batch, default 50, max 500. |
| `batchIntervalMinutes` | no | Drip only. Minutes between batches, default 15, max 1440. |

The one rule to remember: **every message needs `to` plus at least one of
`html`, `text`, or `templateKey`**. The rest is optional.

A fuller example:

```js
await sendhiiv.messages.send({
  from: "Acme Billing <billing@yourdomain.com>",
  to: ["a@example.com", "b@example.com"],
  subject: "March invoice",
  templateKey: "brand-layout",
  html: "<p>Your invoice is attached.</p>",
  variables: { firstName: "Ada" },
  replyTo: "billing@yourdomain.com",
  attachments: [
    {
      filename: "invoice.pdf",
      content: pdfBuffer.toString("base64"),
      contentType: "application/pdf",
    },
  ],
});
```

Drip mode spreads large recipient lists into scheduled batches:

```js
await sendhiiv.messages.send({
  from: "Acme <hello@yourdomain.com>",
  to: recipients,
  subject: "Product update",
  html,
  sendMode: "drip",
  batchSize: 100,
  batchIntervalMinutes: 30,
});
```

## A complete script from zero

```bash
mkdir email-demo && cd email-demo
npm init -y
npm install sendhiiv
```

`send.js`:

```js
const { Sendhiiv, SendhiivError } = require("sendhiiv");

const sendhiiv = new Sendhiiv(process.env.SENDHIIV_API_KEY);

async function main() {
  try {
    const result = await sendhiiv.messages.send({
      to: "you@example.com",
      subject: "Hello from the SDK",
      html: "<p>It works.</p>",
    });
    console.log(`${result.status}: ${result.message} (${result.total} recipient(s))`);
  } catch (err) {
    if (err instanceof SendhiivError) {
      console.error(`Send failed (HTTP ${err.status}, code ${err.code}): ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();
```

```bash
SENDHIIV_API_KEY=sh_live_... node send.js
```

Note there's no `from` in that example — without a verified domain the message
goes out via the shared sender, which is fine for trying things out.

## Using it in Express

Create the client once at startup, not inside handlers:

```js
const express = require("express");
const { Sendhiiv, SendhiivError } = require("sendhiiv");

const app = express();
app.use(express.json());

const sendhiiv = new Sendhiiv(process.env.SENDHIIV_API_KEY);

app.post("/signup", async (req, res) => {
  const user = await createUser(req.body);

  try {
    await sendhiiv.messages.send({
      from: "Acme <hello@yourdomain.com>",
      to: user.email,
      subject: "Welcome to Acme",
      templateKey: "welcome-email",
      variables: { firstName: user.firstName },
    });
  } catch (err) {
    // The account exists either way — log the email failure, don't fail signup.
    console.error("Welcome email failed:", err instanceof SendhiivError ? err.code : err);
  }

  res.status(201).json({ id: user.id });
});
```

## What a successful send returns

The API queues messages and answers `202 Accepted`. The resolved value:

```json
{
  "success": true,
  "status": "queued",
  "code": "QUEUED_FOR_DELIVERY",
  "message": "1 email(s) queued for delivery",
  "total": 1,
  "retry": { "automatic": true, "retryable_temporary_failures": true }
}
```

`total` is the number of recipients queued; `retry` describes server-side
behavior (Sendhiiv retries temporary delivery failures itself after queueing).
Queued means accepted for delivery, not delivered — delivery status shows up in
your dashboard's activity log.

## Error handling

Every non-2xx response throws a `SendhiivError`. It carries:

| Property | Meaning |
| --- | --- |
| `status` | HTTP status code. `0` for network errors and timeouts. |
| `code` | Machine-readable code such as `"QUOTA_EXCEEDED"`, or `null` when the API didn't send one. |
| `compliance` | `{ score, severity, reasons }` — only set when `code` is `"CONTENT_COMPLIANCE_BLOCKED"`. |
| `body` | The full parsed error body, when the server returned JSON. Useful for logging. |
| `message` | The API's error text, or a description of the network failure. |

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
