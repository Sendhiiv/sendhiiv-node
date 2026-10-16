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

Methods are grouped by resource:

| Call | What it does |
| --- | --- |
| `sendhiiv.messages.send(params, options?)` | Send email. Resolves with the queue confirmation, including one id per recipient. |
| `sendhiiv.messages.get(id)` | Look a message up by that id — current status, opens, clicks, bounce reason. |
| `sendhiiv.suppressions.list(params?)` | Addresses you will not send to again. |
| `sendhiiv.suppressions.add({ email, reason, details })` | Suppress one address. |
| `sendhiiv.suppressions.remove(email)` | Remove a suppression you added. |
| `sendhiiv.suppressions.import({ csv \| emails, reason })` | Bulk import, including exports from another provider. |

Every one resolves with the parsed response or rejects with a `SendhiivError`.

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
  "data": [{ "id": "msg_6ad2009154c402f10b8caf8e", "to": "jane@example.com" }],
  "retry": { "automatic": true, "retryable_temporary_failures": true }
}
```

`data` holds one entry per recipient, in the order you listed them. **Store the
`id`** — it is what every webhook event for that message carries as
`message_id`, and what `messages.get()` takes:

```js
const { data } = await sendhiiv.messages.send({
  to: ["jane@example.com", "john@example.com"],
  subject: "Your receipt",
  html: "<p>Thanks!</p>",
});

for (const message of data) {
  await db.receipts.update(message.to, { messageId: message.id });
}
```

`total` is the number of recipients queued; `retry` describes server-side
behavior (Sendhiiv retries temporary delivery failures itself after queueing).
Queued means accepted for delivery, not delivered.

### Checking what happened to a message

```js
const { data } = await sendhiiv.messages.get("msg_6ad2009154c402f10b8caf8e");

data.status; // queued | delivered | bounced | failed | suppressed | blocked
data.reason; // why it bounced, failed or was suppressed
data.opens;  // engagement counters, when tracking is on
```

Webhooks are the push version of this; use `messages.get()` to reconcile after
a timeout, or when an event was missed.

## Idempotency

If a send is accepted but the response never reaches you — a timeout, a dropped
connection — retrying blind would deliver the message twice. Pass an
`idempotencyKey` and the retry is safe:

```js
await sendhiiv.messages.send(
  { to: "jane@example.com", subject: "Your receipt", html: "<p>Thanks!</p>" },
  { idempotencyKey: `receipt-${order.id}` },
);
```

A retry with the same key returns the **original** response, with the same
message ids, and sends nothing further. Keys are remembered for 24 hours, so
derive them from something stable in your own system — an order id, an invoice
number, a job id — rather than a fresh random value per attempt.

Reusing a key with a different body throws a `SendhiivError` with code
`IDEMPOTENCY_KEY_REUSED` (HTTP 422); that is a different message and needs its
own key. A request that was *rejected* frees its key immediately, so you can fix
the payload and retry with the same one.

## Test mode

A key beginning `sh_test_` runs every check a live send does — plan, required
fields, template rendering, attachment limits, sender and domain resolution,
your suppression list, content compliance — and then stops before delivery.

```js
const sendhiiv = new Sendhiiv(process.env.SENDHIIV_TEST_KEY); // sh_test_...

const result = await sendhiiv.messages.send({
  to: "anyone@example.com",
  subject: "Rehearsal",
  html: "<p>Nothing leaves the building.</p>",
});

result.mode;   // "test"
result.status; // "accepted"
result.data;   // real ids you can look up
```

Nothing is delivered, no quota is spent, and test sends stay out of your
delivery statistics and sender reputation. Your webhooks still fire, with
`"mode": "test"` in the payload, so a handler can be verified end to end.
Create a test key from the dashboard by choosing the Test environment.

## Suppressions

The suppression list is the set of addresses Sendhiiv will not send to again.
Hard bounces, spam complaints, unsubscribes and failed validations are added
automatically and enforced on every send.

```js
// What is on the list
const { data, total } = await sendhiiv.suppressions.list({
  reason: "bounce",
  limit: 100,
});

// Add one you learned about through your own channel
await sendhiiv.suppressions.add({
  email: "jane@example.com",
  reason: "unsubscribe",
  details: "Asked by reply",
});

// Move a list over from another provider
await sendhiiv.suppressions.import({
  reason: "bounce",
  csv: fs.readFileSync("sendgrid-bounces.csv", "utf8"),
});
```

`import()` reads provider export files directly, finding the email column by its
header rather than its position. It returns how many were imported, how many
were already listed, and a sample of any unusable rows. It never overwrites an
existing entry, so it cannot downgrade a complaint already on file.

Only entries added as `manual` or `invalid` can be removed — a hard bounce or a
spam complaint is the receiving side's verdict, and removing it would knowingly
damage your own deliverability.

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
since the message may already have been accepted.

If you want those retried too, pass an `idempotencyKey` and retry them
yourself: with a key, a repeated request returns the original response instead
of sending again. Sendhiiv also retries temporary *delivery* failures
server-side after a message is queued, which is a separate thing from retrying
the API call.

```js
const sendhiiv = new Sendhiiv({
  apiKey: process.env.SENDHIIV_API_KEY,
  timeoutMs: 30000, // per-request timeout (default 30s)
  maxRetries: 2,    // 429 retries (default 2)
});
```

## License

MIT
