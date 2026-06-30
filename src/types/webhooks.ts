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
