/**
 * Type definitions for outbound webhooks.
 *
 * Webhooks allow callers to deliver event notifications to external HTTP
 * endpoints (Slack incoming webhooks, Discord webhooks, Telegram bots,
 * custom backends, etc.) from inside a CoralSwap SDK workflow.
 *
 * The module is intentionally transport-agnostic — the only requirement
 * on the receiver is that it accepts HTTPS POST requests with a JSON body
 * and (optionally) verifies the accompanying HMAC-SHA256 signature.
 */

/**
 * The list of event names a webhook is subscribed to.
 *
 * Events are free-form strings (e.g. `price`, `il`, `health`, `volume`,
 * or any custom domain-specific identifier). They are stored alongside
 * the webhook so the host application can decide what to dispatch to
 * each endpoint.
 */
export type WebhookEventName = string;

/**
 * Subscription configuration captured at registration time.
 *
 * `events` describes what kinds of notifications the webhook wants to
 * receive. `secret`, when present, is used to compute an HMAC-SHA256
 * signature over the request body sent to the endpoint — the receiver
 * MUST recompute the same signature with the shared secret to verify
 * authenticity.
 */
export interface WebhookConfig {
  /** HTTPS URL to POST notifications to. */
  url: string;
  /** Event names this webhook is subscribed to. */
  events: WebhookEventName[];
  /**
   * Optional shared secret. When provided, every outgoing delivery
   * includes an `X-Signature` header containing `sha256=<hex-digest>`
   * computed over the raw JSON body.
   */
  secret?: string;
}

/**
 * Arbitrary JSON-serializable payload delivered to a webhook endpoint.
 *
 * Callers can put any domain-specific data here — the SDK will wrap
 * this object with envelope metadata (delivery id, timestamp, event)
 * so the receiver knows the origin and ordering of the notification.
 *
 * The parameter `T` lets callers strongly type their own payload, while
 * the default `Record<string, unknown>` keeps calls ergonomic for ad-hoc
 * notifications.
 */
export type WebhookPayload<T = Record<string, unknown>> = T;

/**
 * Event name dispatched to a webhook subscription.
 *
 * Provided as part of the delivery envelope so receivers can route the
 * notification without inspecting arbitrary user-supplied fields.
 */
export interface WebhookEnvelope<T = Record<string, unknown>> {
  /** Unique delivery identifier (used for receiver-side dedup). */
  id: string;
  /** Unix epoch milliseconds when the delivery was dispatched. */
  timestamp: number;
  /**
   * Optional event name. When {@link WebhookModule.sendWebhook} is
   * invoked without one, this defaults to the first event in the
   * webhook's subscription list.
   */
  event?: WebhookEventName;
  /** The caller-supplied payload. */
  data: T;
}

/**
 * Result returned by {@link WebhookModule.sendWebhook}.
 *
 * The result is always returned (never thrown) when the call completes
 * successfully — i.e. the webhook registration existed and the
 * delivery attempt finished with a definitive outcome. Callers should
 * inspect `delivered` rather than relying on exceptions for normal
 * failure handling.
 */
export interface WebhookDeliveryResult {
  /**
   * HTTP status code returned by the endpoint, or `0` if the request
   * failed before a response was received (DNS failure, TCP reset,
   * timeout, etc.).
   */
  statusCode: number;
  /** `true` when the endpoint returned a 2xx status. */
  delivered: boolean;
  /**
   * Number of additional attempts performed after the initial one.
   * `0` means the first attempt succeeded. `>0` means retried before
   * obtaining a final response.
   */
  retryCount: number;
}

/**
 * Tunable behavior for a delivery attempt. All fields are optional —
 * the module supplies sensible defaults when omitted.
 */
export interface WebhookOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number;
  /** Initial delay between retries, in milliseconds (default 500). */
  baseDelayMs?: number;
  /** Maximum delay between retries (default 10_000). */
  maxDelayMs?: number;
  /**
   * Exponent applied to `baseDelayMs` for each subsequent attempt
   * (default 2). The actual delay is `min(maxDelayMs, baseDelayMs *
   * backoffMultiplier^attempt)`.
   */
  backoffMultiplier?: number;
  /**
   * Per-attempt timeout in milliseconds (default 10_000). Set to `0`
   * to disable.
   */
  timeoutMs?: number;
  /**
   * Custom `fetch` implementation. Useful for testing or for
   * environments without a global `fetch`. When omitted the
   * module uses `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Internal record stored for each registered webhook.
 *
 * The SDK-side representation extends {@link WebhookConfig} with a
 * generated identifier and a creation timestamp that the caller can
 * read back via {@link WebhookModule.getWebhook}.
 */
export interface StoredWebhook extends WebhookConfig {
  /** Auto-generated identifier assigned at registration time. */
  id: string;
  /** Unix epoch milliseconds when the webhook was registered. */
  createdAt: number;
}

/** Header name carrying the HMAC signature of the delivery body. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Signature';

/** Hash algorithm used for the signature header. */
export const WEBHOOK_SIGNATURE_ALGORITHM = 'sha256';

/**
 * Constants exposed for tests and downstream integrations that want to
 * verify the SDK's signature output deterministically.
 */
export const WEBHOOK_DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  timeoutMs: 10_000,
} as const;

/**
 * Number of consecutive delivery failures (network error after all
 * retries, or repeated 5xx responses) that triggers the SDK to
 * auto-disable a webhook and refuse further {@link WebhookModule.sendWebhook}
 * calls until the caller explicitly resumes it via
 * {@link WebhookModule.enableWebhook}.
 */
export const WEBHOOK_DISABLE_FAILURE_THRESHOLD = 5;

/**
 * Maximum number of delivery-history entries retained in memory per
 * registered webhook. The history is a ring buffer — once the cap is
 * reached, the oldest entry is evicted to make room for the newest.
 * Set high enough to be useful for paging; small enough to bound
 * memory usage for applications registering many webhooks.
 */
export const WEBHOOK_HISTORY_CAPACITY = 500;

/**
 * Type discriminator included in the body of {@link WebhookModule.verifyWebhook}
 * handshakes. Receivers can use this to distinguish a verification
 * request from a regular event delivery.
 */
export const WEBHOOK_VERIFY_PAYLOAD_TYPE = 'webhook.verify' as const;

/**
 * Result returned by {@link WebhookModule.verifyWebhook}.
 *
 * The verify handshake is a single POST to the registered URL with a
 * challenge payload. Endpoints that are healthy must respond with a
 * 2xx status; anything else is treated as a failed handshake. The
 * caller is expected to inspect `verified` rather than catching
 * exceptions — failures surface through this result object so the
 * surrounding code does not have to wrap the call in try/catch.
 */
export interface WebhookVerifyResult {
  /**
   * `true` when the endpoint returned a 2xx status during the handshake.
   */
  verified: boolean;
  /**
   * HTTP status code returned by the endpoint, or `0` if the request
   * failed before a response was received.
   */
  statusCode: number;
  /**
   * Wall-clock latency of the handshake request, in milliseconds.
   * Useful for call-site observability (logging, metrics).
   */
  latencyMs: number;
  /**
   * The challenge string embedded in the request body. Exposed so
   * receivers that echo the challenge back can be verified by the
   * caller without re-sending the request.
   */
  challenge: string;
  /**
   * Optional human-readable error message when `verified` is `false`.
   */
  error?: string;
}

/**
 * Tunable behavior for a {@link WebhookModule.verifyWebhook} handshake.
 */
export interface WebhookVerifyOptions {
  /**
   * Per-attempt timeout in milliseconds. Defaults to the module's
   * global `WEBHOOK_DEFAULTS.timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Custom `fetch` override (same semantics as
   * {@link WebhookOptions.fetchImpl}).
   */
  fetchImpl?: typeof fetch;
}

/**
 * A single recorded delivery attempt — one entry is appended every
 * time {@link WebhookModule.sendWebhook} finishes (success or
 * terminal failure), regardless of how many retries ran inside the
 * call. The history array per webhook is bounded by
 * {@link WEBHOOK_HISTORY_CAPACITY}.
 */
export interface WebhookHistoryEntry {
  /** Identifier copied from the envelope (`X-Webhook-Delivery`). */
  deliveryId: string;
  /** Unix epoch milliseconds when the delivery attempt finished. */
  timestamp: number;
  /** Final HTTP status code observed, or `0` for network errors. */
  statusCode: number;
  /** `true` when the endpoint returned a 2xx response. */
  delivered: boolean;
  /** Total number of attempts made for this delivery (>= 1). */
  attempts: number;
  /**
   * Number of retries performed after the initial attempt — same
   * semantics as {@link WebhookDeliveryResult.retryCount}.
   */
  retryCount: number;
  /**
   * Failure category. `"network"` covers timeouts and socket errors,
   * `"client"` covers 4xx responses, `"server"` covers 5xx, and
   * `"success"` records a delivered payload.
   */
  outcome: 'success' | 'network' | 'client' | 'server';
  /** Optional short error message captured when the attempt failed. */
  errorMessage?: string;
}

/**
 * Query parameters for {@link WebhookModule.getWebhookHistory}.
 *
 * Pagination is cursor-based: callers pass the `nextCursor` value
 * returned by the previous page to walk the history. For convenience,
 * `limit` may also be combined with a numeric `offset` to support
 * the classic index/limit style.
 */
export interface WebhookHistoryQuery {
  /** Maximum number of entries per page (1..200). Defaults to 50. */
  limit?: number;
  /**
   * Opaque cursor returned by the previous page. When present,
   * returned entries start immediately after the cursor.
   */
  cursor?: string;
  /**
   * Zero-based offset relative to the start of the history, used when
   * no `cursor` is provided.
   */
  offset?: number;
}

/**
 * A single page of delivery history.
 *
 * `nextCursor` is non-null when more entries remain after this page.
 * The caller should pass it as `cursor` on the next call to continue
 * iterating.
 */
export interface WebhookHistoryPage {
  /** Entries in the requested page, newest first. */
  items: WebhookHistoryEntry[];
  /**
   * Cursor for the next page, or `null` when this is the last page.
   * Opaque to callers — pass it back unchanged.
   */
  nextCursor: string | null;
  /** Total entries stored for this webhook (across all pages). */
  total: number;
}
