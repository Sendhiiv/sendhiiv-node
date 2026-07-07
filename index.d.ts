export interface SendhiivConfig {
  apiKey: string;
  /** Defaults to https://api.sendhiiv.com/api/v1 */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Retries for HTTP 429 rate-limit responses only. Default 2. */
  maxRetries?: number;
}

export interface Attachment {
  filename: string;
  /** Base64-encoded file content. */
  content: string;
  /** MIME type, e.g. "application/pdf". Also accepted as content_type. */
  contentType?: string;
  content_type?: string;
}

export interface SendMessageParams {
  /** Recipient address, array of addresses, or comma-separated list. */
  to: string | string[];
  /** Subject line. Optional when a message template provides one. */
  subject?: string;
  /** HTML body. */
  html?: string;
  /** Plain-text body. Required if html and templateKey are both omitted. */
  text?: string;
  /** Display sender, e.g. "Acme <hello@yourdomain.com>". */
  from?: string;
  /** Reply-To address. Also accepted as reply_to. */
  replyTo?: string;
  reply_to?: string;
  /** Saved layout/message template key, e.g. "brand-layout". */
  templateKey?: string;
  template_key?: string;
  /** Values for merge tags such as {{firstName}}. */
  variables?: Record<string, unknown>;
  /** Attachments, 10 MB total per message. */
  attachments?: Attachment[];
  /** "drip" schedules recipients in batches instead of sending immediately. */
  sendMode?: "drip";
  send_mode?: "drip";
  /** Drip only: recipients per batch (default 50, max 500). */
  batchSize?: number;
  batch_size?: number;
  /** Drip only: minutes between batches (default 15, max 1440). */
  batchIntervalMinutes?: number;
  batch_interval_minutes?: number;
}

export interface SendMessageResponse {
  success: true;
  status: "queued";
  code: "QUEUED_FOR_DELIVERY";
  message: string;
  /** Number of recipients queued. */
  total: number;
  retry: {
    automatic: boolean;
    retryable_temporary_failures: boolean;
  };
}

export declare class SendhiivError extends Error {
  name: "SendhiivError";
  /** HTTP status (0 for network/timeout errors). */
  status: number;
  /** e.g. "CONTENT_COMPLIANCE_BLOCKED", "ATTACHMENT_TOO_LARGE". */
  code: string | null;
  /** Full parsed error body when the server returned JSON. */
  body: Record<string, unknown> | null;
  /** Present when code is CONTENT_COMPLIANCE_BLOCKED. */
  compliance: {
    score: number;
    severity: string;
    reasons: string[];
  } | null;
}

export declare class Sendhiiv {
  constructor(config: string | SendhiivConfig);
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  messages: {
    send(message: SendMessageParams): Promise<SendMessageResponse>;
  };
}

export default Sendhiiv;
