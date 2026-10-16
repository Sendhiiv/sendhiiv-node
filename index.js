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

const DEFAULT_BASE_URL = "https://api.sendhiiv.com/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2; // 429 rate-limit retries only — see below

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
        this.#request("GET", `/messages/${encodeURIComponent(id)}`),
    };

    this.suppressions = {
      /** Addresses this account will not send to. */
      list: (params = {}) => this.#request("GET", "/suppressions", { params }),

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
    const { body, headers: extraHeaders, params } = options;
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

    // Only 429 (rate limit) is retried: the limiter runs before anything is
    // queued, so a retry can never double-send. 5xx and network errors are
    // NOT retried automatically — the message may already have been accepted.
    // Retry those yourself if you passed an idempotencyKey, which makes the
    // retry return the original response instead of sending again.
    for (let attempt = 0; ; attempt++) {
      let response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": "sendhiiv-node/0.2.0",
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
            ...(extraHeaders || {}),
          },
          ...(hasBody ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
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

      if (response.status === 429 && attempt < this.maxRetries) {
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

module.exports = { Sendhiiv, SendhiivError };
module.exports.default = Sendhiiv;
