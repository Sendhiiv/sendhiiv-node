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

export interface SendOptions {
  /**
   * Any unique string identifying this send. Retrying with the same key
   * returns the original response instead of sending again. Remembered for
   * 24 hours.
   */
  idempotencyKey?: string;
}

export interface AcceptedMessage {
  /** Message id, e.g. "msg_6ad2009154c402f10b8caf8e". Store this. */
  id: string;
  to: string;
  /** Test mode only. */
  status?: "delivered" | "suppressed";
  /** Drip sends only. */
  scheduled_for?: string;
}

export interface SendMessageResponse {
  success: true;
  /** "accepted" in test mode, where nothing is delivered. */
  status: "queued" | "scheduled" | "accepted";
  code: "QUEUED_FOR_DELIVERY" | "TEST_MODE_ACCEPTED" | string;
  message: string;
  /** Number of recipients accepted. */
  total: number;
  /**
   * One entry per accepted recipient, in request order. Each `id` is what
   * webhook events carry as `message_id`.
   */
  data: AcceptedMessage[];
  /** "drip" for a batched send, "test" when a sh_test_ key was used. */
  mode?: "drip" | "test";
  retry?: {
    automatic: boolean;
    retryable_temporary_failures: boolean;
  };
}

export type MessageStatus =
  | "queued"
  | "delivered"
  | "failed"
  | "bounced"
  | "suppressed"
  | "blocked";

export interface Message {
  id: string;
  to: string;
  subject: string;
  status: MessageStatus;
  mode: "live" | "test";
  source: "api" | "smtp" | "app";
  /** SMTP Message-ID, once the message reached a provider. */
  provider_message_id: string | null;
  /** Why it failed, bounced or was suppressed. */
  reason: string | null;
  bounce_category:
    | "spam_block"
    | "hard_bounce"
    | "soft"
    | "complaint"
    | "other"
    | null;
  campaign_id: string | null;
  delivery_mode: "immediate" | "drip";
  scheduled_for: string | null;
  opens: number;
  clicks: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  first_clicked_at: string | null;
  last_clicked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageResponse {
  success: true;
  data: Message;
}

export type SuppressionReason =
  | "bounce"
  | "complaint"
  | "unsubscribe"
  | "manual"
  | "invalid";

export interface Suppression {
  email: string;
  reason: SuppressionReason;
  domain: string | null;
  details: string | null;
  /** Only `manual` and `invalid` entries can be removed. */
  removable: boolean;
  created_at: string;
}

export interface SuppressionListParams {
  limit?: number;
  page?: number;
  reason?: SuppressionReason;
  email?: string;
}

export interface SuppressionListResponse {
  success: true;
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  data: Suppression[];
}

export interface SuppressionImportParams {
  /** Addresses, or objects with an email and a reason. */
  emails?: Array<string | { email: string; reason?: SuppressionReason }>;
  /** CSV contents, as an alternative to `emails`. Accepts SendGrid exports. */
  csv?: string;
  /** Reason for rows that don't supply one. Defaults to "manual". */
  reason?: SuppressionReason;
  details?: string;
}

export interface SuppressionImportResponse {
  success: true;
  received: number;
  imported: number;
  already_suppressed: number;
  invalid: number;
  invalid_sample: string[];
}

// ── SMS ─────────────────────────────────────────────────────────────────────

/** An amount in the currency's minor unit (kobo for NGN: 750 = ₦7.50). */
export interface Money {
  amount: number;
  currency: string;
}

export type SmsType = "transactional" | "promotional";

/** New statuses may be added; treat unknown ones as pending. */
export type SmsStatus = "queued" | "sent" | "delivered" | "failed" | "rejected" | (string & {});

export interface SendSmsParams {
  /** One number, or up to 1,000. 08031234567 and +2348031234567 both work. */
  to: string | string[];
  /** Up to 6 pages. A page is 160 characters, or 70 with emoji or ₦. */
  message: string;
  /** Defaults to "transactional" (reaches DND numbers). */
  type?: SmsType;
  /** An approved sender ID on your account. Leave out for the default. */
  from?: string;
  /** Your own id, up to 100 characters. Returned with the message and filterable. */
  reference?: string;
  /** Up to 20 keys / 2 KB of your own data, returned with the message. */
  metadata?: Record<string, unknown>;
}

export interface SmsSendOptions {
  /** Defaults to a generated key, so the SDK's own retries never double-send. */
  idempotencyKey?: string;
}

export interface SmsBatch {
  object: "sms_batch";
  batch_id: string;
  type: SmsType;
  from: string | null;
  reference: string | null;
  messages: { id: string; to: string; status: SmsStatus; pages: number }[];
  /** Numbers that couldn't be used. Not sent, not charged. */
  rejected: { to: string; reason: string }[];
  recipients: number;
  pages_per_message: number;
  encoding: "GSM-7" | "UCS-2";
  cost: Money;
  /** Balance after this send; null for accounts that send free. */
  balance: Money | null;
  test: boolean;
}

export interface Sms {
  id: string;
  object: "sms";
  batch_id: string;
  to: string;
  from: string | null;
  message: string;
  type: SmsType;
  status: SmsStatus;
  pages: number;
  encoding: string;
  cost: Money;
  error: string | null;
  reference: string | null;
  metadata: Record<string, unknown> | null;
  test: boolean;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}

export interface SmsListParams {
  status?: "queued" | "sent" | "delivered" | "failed" | "rejected";
  reference?: string;
  batchId?: string;
  to?: string;
  createdAfter?: string | Date;
  createdBefore?: string | Date;
  /** 1–100, default 20. */
  limit?: number;
  cursor?: string;
}

export interface SmsListResponse {
  success: true;
  data: Sms[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SmsBalance {
  object: "sms_balance";
  balance: Money | null;
  free_sending: boolean;
  tier: {
    name: string;
    price_per_page: { transactional: Money; promotional: Money };
  } | null;
  daily_limit: { pages: number; used_pages: number; remaining_pages: number } | null;
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
    send(
      message: SendMessageParams,
      options?: SendOptions,
    ): Promise<SendMessageResponse>;
    get(id: string): Promise<MessageResponse>;
  };
  sms: {
    send(message: SendSmsParams, options?: SmsSendOptions): Promise<{ success: true; data: SmsBatch }>;
    get(id: string): Promise<{ success: true; data: Sms }>;
    list(params?: SmsListParams): Promise<SmsListResponse>;
    /** Every matching SMS, fetching pages as you go. */
    listAll(params?: SmsListParams): AsyncGenerator<Sms, void, unknown>;
    balance(): Promise<{ success: true; data: SmsBalance }>;
  };
  suppressions: {
    list(params?: SuppressionListParams): Promise<SuppressionListResponse>;
    add(suppression: {
      email: string;
      reason?: SuppressionReason;
      details?: string;
    }): Promise<{ success: true; data: Suppression }>;
    remove(
      email: string,
    ): Promise<{ success: true; email: string; removed: boolean }>;
    import(
      params: SuppressionImportParams,
    ): Promise<SuppressionImportResponse>;
  };
}

export declare const VERSION: string;

export default Sendhiiv;
