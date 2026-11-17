"use strict";

/**
 * Sendhiiv Node.js SDK.
 *
 * Zero dependencies — uses the global fetch available in Node 18+.
 *
 *   const { Sendhiiv } = require("sendhiiv");
 *   const sendhiiv = new Sendhiiv(process.env.SENDHIIV_API_KEY);
 *   await sendhiiv.messages.send({
 *     from: "Acme <hello@yourdomain.com>",
 *     to: "customer@example.com",
 *     subject: "Welcome aboard",
 *     html: "<p>Hi there, your account is ready.</p>",
 *   });
 */

const { randomUUID } = require("node:crypto");

const VERSION = "0.3.0";
const DEFAULT_BASE_URL = "https://api.sendhiiv.com/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2; // see #request for what is retried

/** Error thrown for any non-2xx API response. */
class SendhiivError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "SendhiivError";
    /** HTTP status code, e.g. 401, 413, 429. 0 for network/timeout errors. */
    this.status = status ?? 0;
    /** Machine-readable code, e.g. "CONTENT_COMPLIANCE_BLOCKED". */
    this.code = code ?? null;
    /** Full parsed response body, when the server returned JSON. */
    this.body = body ?? null;
    /** Compliance details when code is CONTENT_COMPLIANCE_BLOCKED. */
    this.compliance = body?.compliance ?? null;
  }
}

// Accept both camelCase (JS convention) and snake_case (wire format).
const FIELD_MAP = {
  replyTo: "reply_to",
  templateKey: "template_key",
  sendMode: "send_mode",
  batchSize: "batch_size",
  batchIntervalMinutes: "batch_interval_minutes",
  batchId: "batch_id",
  createdAfter: "created_after",
  createdBefore: "created_before",
  appName: "app_name",
  codeLength: "code_length",
  expiresInMinutes: "expires_in_minutes",
};

function toWirePayload(message) {
  const payload = {};
  for (const [key, value] of Object.entries(message)) {
    if (value === undefined) continue;
    payload[FIELD_MAP[key] || key] = value;
  }
  if (Array.isArray(payload.attachments)) {
    payload.attachments = payload.attachments.map((a) => {
      if (!a || typeof a !== "object") return a;
      const { contentType, ...rest } = a;
      return contentType !== undefined
        ? { ...rest, content_type: contentType }
        : rest;
    });
  }
  return payload;
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Math.min(1000 * 2 ** attempt, 10_000);
}

// Walk a cursor-paged list endpoint, yielding items one by one.
async function* paginate(fetchPage, params) {
  let cursor = params.cursor;
  for (;;) {
    const page = await fetchPage({ ...params, cursor });
    for (const item of page.data || []) yield item;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Sendhiiv {
  /**
   * @param {string | { apiKey: string, baseUrl?: string, timeoutMs?: number, maxRetries?: number }} config
   */
  constructor(config) {
    const opts = typeof config === "string" ? { apiKey: config } : config || {};
    if (!opts.apiKey) {
      throw new Error(
        "Sendhiiv: missing API key. new Sendhiiv('sh_live_...') or new Sendhiiv({ apiKey })",
      );
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.messages = {
      /**
       * Send a transactional email. Resolves with the queue confirmation
       * (HTTP 202) — whose `data` array holds one `msg_…` id per recipient —
       * or throws SendhiivError.
       *
       * Pass `idempotencyKey` to make a retry safe: if the request was already
       * accepted, you get the original response back and nothing is sent again.
       *
       *   await sendhiiv.messages.send(message, { idempotencyKey: order.id });
       */
      send: (message, options = {}) =>
        this.#request("POST", "/messages", {
          body: message,
          headers: options.idempotencyKey
            ? { "Idempotency-Key": String(options.idempotencyKey) }
            : undefined,
        }),

      /**
       * Current status of one message, by the id returned when it was sent.
       * Use this to reconcile after a timeout or a missed webhook.
       */
      get: (id) =>
        this.#request("GET", `/messages/${encodeURIComponent(id)}`, { retrySafe: true }),
    };

    this.sms = {
      /**
       * Send one SMS to 1–1,000 numbers. Charged from your SMS balance;
       * numbers that can't be used come back in `data.rejected`, uncharged.
       *
       *   await sendhiiv.sms.send({ to: "08031234567", message: "Your code is 418302" });
       *
       * Every send carries an idempotency key (one is generated if you don't
       * pass `idempotencyKey`), so the SDK can safely retry a timeout or a
       * server error without texting, or charging, anyone twice. Pass your
       * own, such as an order id, to make retries across restarts safe too.
       */
      send: (message, options = {}) =>
        this.#request("POST", "/sms/messages", {
          body: message,
          headers: {
            "Idempotency-Key": String(options.idempotencyKey ?? `sdk_${randomUUID()}`),
          },
          retrySafe: true,
        }),

      /** One SMS by the `sms_…` id returned when it was sent. */
      get: (id) =>
        this.#request("GET", `/sms/messages/${encodeURIComponent(id)}`, { retrySafe: true }),

      /**
       * One page of SMS, newest first. Filter by status, reference, batchId,
       * to, createdAfter, createdBefore; page with `cursor`.
       */
      list: (params = {}) =>
        this.#request("GET", "/sms/messages", { params: toWirePayload(params), retrySafe: true }),

      /**
       * Every SMS matching the filters, fetching pages as you go.
       *
       *   for await (const sms of sendhiiv.sms.listAll({ status: "failed" })) { … }
       */
      listAll: (params = {}) => paginate((p) => this.sms.list(p), params),

      /** Balance, price per page on your tier, and today's daily limit. */
      balance: () => this.#request("GET", "/sms/balance", { retrySafe: true }),
    };

    this.verify = {
      /**
       * Text a one-time code to a number. Sendhiiv creates, expires and
       * checks it; you never see or store the code.
       *
       *   const { data } = await sendhiiv.verify.send({ to: "08031234567", appName: "Lagos Bloom" });
       *   // keep data.id, or check by number later
       *
       * Like sms.send, it always carries an idempotency key, so retries
       * never send a second code.
       */
      send: (params, options = {}) =>
        this.#request("POST", "/verify", {
          body: params,
          headers: {
            "Idempotency-Key": String(options.idempotencyKey ?? `sdk_${randomUUID()}`),
          },
          retrySafe: true,
        }),

      /**
       * Is this the code the user typed? Pass `id` from send(), or `to`.
       * `data.valid` is true only the first time the right code is given;
       * `data.result` says why not: "incorrect", "expired", "max_attempts",
       * "canceled" or "already_approved".
       *
       *   const { data } = await sendhiiv.verify.check({ id, code: req.body.code });
       *   if (!data.valid) return res.status(401).send("Wrong or expired code");
       *
       * Not retried on network errors: a retried check would use up an
       * attempt, so retry it yourself if you want to.
       */
      check: (params) => this.#request("POST", "/verify/check", { body: params }),

      /** Where a verification stands, by the `vrf_…` id. */
      get: (id) =>
        this.#request("GET", `/verify/${encodeURIComponent(id)}`, { retrySafe: true }),

      /** Stop a pending code being used, e.g. when the user cancels sign-in. */
      cancel: (id) =>
        this.#request("POST", `/verify/${encodeURIComponent(id)}/cancel`, { retrySafe: true }),
    };

    this.suppressions = {
      /** Addresses this account will not send to. */
      list: (params = {}) => this.#request("GET", "/suppressions", { params, retrySafe: true }),

      /** Suppress one address. */
      add: (suppression) =>
        this.#request("POST", "/suppressions", { body: suppression }),

      /** Remove a suppression. Only `manual` and `invalid` entries can go. */
      remove: (email) =>
        this.#request(
          "DELETE",
          `/suppressions/${encodeURIComponent(email)}`,
        ),

      /**
       * Bulk import, for moving a list off another provider.
       *
       *   await sendhiiv.suppressions.import({
       *     reason: "bounce",
       *     csv: fs.readFileSync("sendgrid-bounces.csv", "utf8"),
       *   });
       */
      import: (payload) =>
        this.#request("POST", "/suppressions/import", { body: payload }),
    };
  }

  async #request(method, path, options = {}) {
    const { body, headers: extraHeaders, params, retrySafe = false } = options;
    const hasBody = body !== undefined;
    const payload = hasBody ? toWirePayload(body) : null;
    const query = params
      ? Object.entries(params)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(
            ([key, value]) =>
              `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
          )
          .join("&")
      : "";
    const url = this.baseUrl + path + (query ? `?${query}` : "");

    // 429 (rate limit) is always retried: the limiter runs before anything is
    // queued, so a retry can never double-send.
    //
    // Timeouts, network errors and 5xx are retried only when the request is
    // `retrySafe`: reads, and SMS sends (which always carry an idempotency
    // key, so a retry returns the original response). Email sends aren't
    // retried on these, because the message may already have been accepted;
    // retry those yourself with an idempotencyKey.
    for (let attempt = 0; ; attempt++) {
      let response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": `sendhiiv-node/${VERSION}`,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
            ...(extraHeaders || {}),
          },
          ...(hasBody ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        if (retrySafe && attempt < this.maxRetries) {
          await sleep(retryDelayMs(null, attempt));
          continue;
        }
        throw new SendhiivError(
          err?.name === "AbortError"
            ? `Request timed out after ${this.timeoutMs}ms`
            : `Network error: ${err?.message || err}`,
          { status: 0 },
        );
      } finally {
        clearTimeout(timer);
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        // Non-JSON body (e.g. a proxy error page) — handled below.
      }

      if (response.ok) return body;

      const retryable = response.status === 429 || (retrySafe && response.status >= 500);
      if (retryable && attempt < this.maxRetries) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      throw new SendhiivError(
        body?.error || `Sendhiiv API error (HTTP ${response.status})`,
        { status: response.status, code: body?.code ?? null, body },
      );
    }
  }
}

module.exports = { Sendhiiv, SendhiivError, VERSION };
module.exports.default = Sendhiiv;
