"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Sendhiiv, SendhiivError } = require("./index.js");

const realFetch = global.fetch;
let calls;

function stubFetch(...responses) {
  let i = 0;
  global.fetch = async (url, init) => {
    calls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name) => r.headers?.[name.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  global.fetch = realFetch;
});

const queued = {
  status: 202,
  body: {
    success: true,
    status: "queued",
    code: "QUEUED_FOR_DELIVERY",
    message: "1 email(s) queued for delivery",
    total: 1,
    retry: { automatic: true, retryable_temporary_failures: true },
  },
};

test("requires an API key", () => {
  assert.throws(() => new Sendhiiv(), /missing API key/);
  assert.throws(() => new Sendhiiv({}), /missing API key/);
});

test("sends with Bearer auth and returns the queue confirmation", async () => {
  stubFetch(queued);
  const client = new Sendhiiv("sh_live_test");
  const result = await client.messages.send({
    to: "a@example.com",
    subject: "Hi",
    html: "<p>Hi</p>",
  });

  assert.equal(result.code, "QUEUED_FOR_DELIVERY");
  assert.equal(result.total, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.sendhiiv.com/api/v1/messages");
  assert.equal(
    calls[0].init.headers.Authorization,
    "Bearer sh_live_test",
  );
});

test("maps camelCase fields to the snake_case wire format", async () => {
  stubFetch(queued);
  const client = new Sendhiiv("sh_live_test");
  await client.messages.send({
    to: "a@example.com",
    subject: "Hi",
    html: "<p>Hi</p>",
    replyTo: "reply@example.com",
    templateKey: "brand-layout",
    sendMode: "drip",
    batchSize: 100,
    batchIntervalMinutes: 30,
    attachments: [
      { filename: "a.pdf", content: "aGk=", contentType: "application/pdf" },
    ],
  });

  const sent = calls[0].body;
  assert.equal(sent.reply_to, "reply@example.com");
  assert.equal(sent.template_key, "brand-layout");
  assert.equal(sent.send_mode, "drip");
  assert.equal(sent.batch_size, 100);
  assert.equal(sent.batch_interval_minutes, 30);
  assert.equal(sent.attachments[0].content_type, "application/pdf");
  assert.equal(sent.replyTo, undefined);
  assert.equal(sent.attachments[0].contentType, undefined);
});

test("throws SendhiivError with code and compliance details", async () => {
  stubFetch({
    status: 400,
    body: {
      success: false,
      error: "Content blocked for high-risk promotional/spam patterns",
      code: "CONTENT_COMPLIANCE_BLOCKED",
      compliance: { score: 101, severity: "high", reasons: ["lottery"] },
    },
  });
  const client = new Sendhiiv("sh_live_test");

  await assert.rejects(
    client.messages.send({ to: "a@example.com", subject: "x", html: "y" }),
    (err) => {
      assert.ok(err instanceof SendhiivError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "CONTENT_COMPLIANCE_BLOCKED");
      assert.deepEqual(err.compliance.reasons, ["lottery"]);
      return true;
    },
  );
});

test("retries 429 honoring Retry-After, then succeeds", async () => {
  stubFetch(
    {
      status: 429,
      headers: { "retry-after": "0" },
      body: { success: false, error: "Rate limit exceeded" },
    },
    queued,
  );
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 2 });
  const result = await client.messages.send({
    to: "a@example.com",
    subject: "x",
    html: "y",
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
});

test("gives up on 429 after maxRetries", async () => {
  stubFetch({
    status: 429,
    headers: { "retry-after": "0" },
    body: { success: false, error: "Rate limit exceeded" },
  });
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 1 });

  await assert.rejects(
    client.messages.send({ to: "a@example.com", subject: "x", html: "y" }),
    (err) => err.status === 429,
  );
  assert.equal(calls.length, 2); // initial + 1 retry
});

test("does not retry 5xx (message may already be accepted)", async () => {
  stubFetch(
    { status: 500, body: { success: false, error: "Internal server error" } },
    queued,
  );
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 2 });

  await assert.rejects(
    client.messages.send({ to: "a@example.com", subject: "x", html: "y" }),
    (err) => err.status === 500,
  );
  assert.equal(calls.length, 1);
});

test("wraps network errors in SendhiivError with status 0", async () => {
  stubFetch(new TypeError("fetch failed"));
  const client = new Sendhiiv("sh_live_test");

  await assert.rejects(
    client.messages.send({ to: "a@example.com", subject: "x", html: "y" }),
    (err) => {
      assert.ok(err instanceof SendhiivError);
      assert.equal(err.status, 0);
      assert.match(err.message, /Network error/);
      return true;
    },
  );
});

// ── Message ids ────────────────────────────────────────────────────────────

const queuedWithIds = {
  status: 202,
  body: {
    success: true,
    status: "queued",
    code: "QUEUED_FOR_DELIVERY",
    total: 2,
    data: [
      { id: "msg_aaaaaaaaaaaaaaaaaaaaaaaa", to: "a@example.com" },
      { id: "msg_bbbbbbbbbbbbbbbbbbbbbbbb", to: "b@example.com" },
    ],
  },
};

test("returns one message id per recipient", async () => {
  stubFetch(queuedWithIds);
  const client = new Sendhiiv("sh_live_test");
  const result = await client.messages.send({
    to: ["a@example.com", "b@example.com"],
    subject: "Hi",
    text: "Hi",
  });

  assert.deepEqual(
    result.data.map((m) => m.id),
    ["msg_aaaaaaaaaaaaaaaaaaaaaaaa", "msg_bbbbbbbbbbbbbbbbbbbbbbbb"],
  );
});

// ── Idempotency ────────────────────────────────────────────────────────────

test("sends Idempotency-Key only when one is given", async () => {
  stubFetch(queued);
  const client = new Sendhiiv("sh_live_test");

  await client.messages.send(
    { to: "a@example.com", subject: "Hi", text: "Hi" },
    { idempotencyKey: "order-5521" },
  );
  assert.equal(calls[0].init.headers["Idempotency-Key"], "order-5521");

  await client.messages.send({ to: "a@example.com", subject: "Hi", text: "Hi" });
  assert.equal(calls[1].init.headers["Idempotency-Key"], undefined);
});

// ── Status lookup ──────────────────────────────────────────────────────────

test("looks a message up by id without sending a body", async () => {
  stubFetch({
    status: 200,
    body: { success: true, data: { id: "msg_abc", status: "delivered" } },
  });
  const client = new Sendhiiv("sh_live_test");
  const result = await client.messages.get("msg_abc");

  assert.equal(result.data.status, "delivered");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].url, "https://api.sendhiiv.com/api/v1/messages/msg_abc");
  assert.equal(calls[0].init.body, undefined);
  // A GET with a JSON content type confuses some proxies and gateways.
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
});

// ── Suppressions ───────────────────────────────────────────────────────────

test("lists suppressions with query parameters", async () => {
  stubFetch({ status: 200, body: { success: true, total: 0, data: [] } });
  const client = new Sendhiiv("sh_live_test");
  await client.suppressions.list({ reason: "bounce", limit: 50, page: undefined });

  assert.equal(
    calls[0].url,
    "https://api.sendhiiv.com/api/v1/suppressions?reason=bounce&limit=50",
  );
});

test("removes a suppression, escaping the address", async () => {
  stubFetch({ status: 200, body: { success: true, removed: true } });
  const client = new Sendhiiv("sh_live_test");
  await client.suppressions.remove("jane+tag@example.com");

  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(
    calls[0].url,
    "https://api.sendhiiv.com/api/v1/suppressions/jane%2Btag%40example.com",
  );
});

test("imports a suppression list", async () => {
  stubFetch({ status: 200, body: { success: true, imported: 2 } });
  const client = new Sendhiiv("sh_live_test");
  const result = await client.suppressions.import({
    reason: "bounce",
    csv: "email,created\nbob@acme.com,2024-01-02\n",
  });

  assert.equal(result.imported, 2);
  assert.equal(calls[0].body.reason, "bounce");
  assert.match(calls[0].body.csv, /bob@acme\.com/);
});
