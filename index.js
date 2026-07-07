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
       * (HTTP 202) or throws SendhiivError.
       */
      send: (message) => this.#request("POST", "/messages", message),
    };
  }

  async #request(method, path, message) {
    const payload = toWirePayload(message || {});

    // Only 429 (rate limit) is retried: the limiter runs before anything is
    // queued, so a retry can never double-send. 5xx and network errors are
    // NOT retried — the message may already have been accepted.
    for (let attempt = 0; ; attempt++) {
      let response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "sendhiiv-node/0.1.0",
          },
          body: JSON.stringify(payload),
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
