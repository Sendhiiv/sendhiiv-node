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

// ── SMS ─────────────────────────────────────────────────────────────────────

const smsAccepted = {
  status: 202,
  body: {
    success: true,
    data: {
      object: "sms_batch",
      batch_id: "smsb_1",
      messages: [{ id: "sms_6740a1b2c3d4e5f6a7b8c9d0", to: "+2348031234567", status: "queued", pages: 1 }],
      rejected: [],
      cost: { amount: 750, currency: "NGN" },
    },
  },
};

test("sms.send posts to /sms/messages with a generated idempotency key", async () => {
  stubFetch(smsAccepted);
  const client = new Sendhiiv("sh_live_test");
  const result = await client.sms.send({ to: "08031234567", message: "Your code is 418302" });
  assert.equal(result.data.batch_id, "smsb_1");
  assert.equal(calls[0].url, "https://api.sendhiiv.com/api/v1/sms/messages");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { to: "08031234567", message: "Your code is 418302" });
  assert.match(calls[0].init.headers["Idempotency-Key"], /^sdk_[0-9a-f-]{36}$/);
});

test("sms.send uses your idempotency key when given", async () => {
  stubFetch(smsAccepted);
  const client = new Sendhiiv("sh_live_test");
  await client.sms.send({ to: "0803", message: "Hi" }, { idempotencyKey: "order-4521" });
  assert.equal(calls[0].init.headers["Idempotency-Key"], "order-4521");
});

test("sms.send retries a server error with the same key, so nothing sends twice", async () => {
  stubFetch({ status: 503, body: { success: false, code: "SMS_UNAVAILABLE", error: "x" } }, smsAccepted);
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 1 });
  const started = Date.now();
  const result = await client.sms.send({ to: "0803", message: "Hi" });
  assert.equal(result.data.batch_id, "smsb_1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["Idempotency-Key"], calls[1].init.headers["Idempotency-Key"]);
  assert.ok(Date.now() - started >= 900, "backs off before retrying");
});

test("sms.send retries a network error too", async () => {
  stubFetch(new TypeError("fetch failed"), smsAccepted);
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 1 });
  const result = await client.sms.send({ to: "0803", message: "Hi" });
  assert.equal(result.data.batch_id, "smsb_1");
  assert.equal(calls.length, 2);
});

test("email sends still don't retry server errors", async () => {
  stubFetch({ status: 503, body: { success: false, error: "down" } }, queued);
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 2 });
  await assert.rejects(client.messages.send({ to: "a@example.com", subject: "x", html: "x" }), SendhiivError);
  assert.equal(calls.length, 1);
});

test("a low balance surfaces as a SendhiivError with the shortfall", async () => {
  stubFetch({
    status: 402,
    body: { success: false, code: "SMS_INSUFFICIENT_BALANCE", error: "Your SMS balance is too low for this send.", short_by: { amount: 650, currency: "NGN" } },
  });
  const client = new Sendhiiv("sh_live_test");
  await assert.rejects(client.sms.send({ to: "0803", message: "Hi" }), (err) => {
    assert.equal(err.status, 402);
    assert.equal(err.code, "SMS_INSUFFICIENT_BALANCE");
    assert.equal(err.body.short_by.amount, 650);
    return true;
  });
});

test("sms.get, sms.list filters and sms.balance hit the right paths", async () => {
  stubFetch({ status: 200, body: { success: true, data: {} } });
  const client = new Sendhiiv("sh_live_test");
  await client.sms.get("sms_6740a1b2c3d4e5f6a7b8c9d0");
  await client.sms.list({ status: "failed", batchId: "smsb_1", createdAfter: "2026-11-01" });
  await client.sms.balance();
  assert.equal(calls[0].url, "https://api.sendhiiv.com/api/v1/sms/messages/sms_6740a1b2c3d4e5f6a7b8c9d0");
  assert.equal(calls[1].url, "https://api.sendhiiv.com/api/v1/sms/messages?status=failed&batch_id=smsb_1&created_after=2026-11-01");
  assert.equal(calls[2].url, "https://api.sendhiiv.com/api/v1/sms/balance");
});

test("sms.listAll walks every page", async () => {
  stubFetch(
    { status: 200, body: { success: true, data: [{ id: "sms_a" }, { id: "sms_b" }], has_more: true, next_cursor: "sms_b" } },
    { status: 200, body: { success: true, data: [{ id: "sms_c" }], has_more: false, next_cursor: null } },
  );
  const client = new Sendhiiv("sh_live_test");
  const { listAll } = client.sms; // safe to destructure
  const ids = [];
  for await (const sms of listAll({ status: "delivered" })) ids.push(sms.id);
  assert.deepEqual(ids, ["sms_a", "sms_b", "sms_c"]);
  assert.match(calls[1].url, /cursor=sms_b/);
});

// ── Verify ──────────────────────────────────────────────────────────────────

test("verify.send posts snake_case fields with an idempotency key", async () => {
  stubFetch({ status: 202, body: { success: true, data: { id: "vrf_1", status: "pending" } } });
  const client = new Sendhiiv("sh_live_test");
  const { data } = await client.verify.send({ to: "08031234567", appName: "Lagos Bloom", codeLength: 4, expiresInMinutes: 5 });
  assert.equal(data.id, "vrf_1");
  assert.equal(calls[0].url, "https://api.sendhiiv.com/api/v1/verify");
  assert.deepEqual(calls[0].body, { to: "08031234567", app_name: "Lagos Bloom", code_length: 4, expires_in_minutes: 5 });
  assert.match(calls[0].init.headers["Idempotency-Key"], /^sdk_/);
});

test("verify.check returns valid/result and is never retried automatically", async () => {
  stubFetch({ status: 503, body: { success: false, error: "down" } }, { status: 200, body: { success: true, data: { valid: true } } });
  const client = new Sendhiiv({ apiKey: "sh_live_test", maxRetries: 2 });
  await assert.rejects(client.verify.check({ id: "vrf_1", code: "418302" }), SendhiivError);
  assert.equal(calls.length, 1, "a retried check would use up an attempt");
  assert.deepEqual(calls[0].body, { id: "vrf_1", code: "418302" });
});

test("verify.get and verify.cancel hit the right paths", async () => {
  stubFetch({ status: 200, body: { success: true, data: { status: "canceled" } } });
  const client = new Sendhiiv("sh_live_test");
  await client.verify.get("vrf_1");
  await client.verify.cancel("vrf_1");
  assert.equal(calls[0].url, "https://api.sendhiiv.com/api/v1/verify/vrf_1");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].url, "https://api.sendhiiv.com/api/v1/verify/vrf_1/cancel");
});
