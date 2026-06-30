import { createHmac, randomUUID } from 'node:crypto';
import { Logger } from '@/types/common';
import {
  StoredWebhook,
  WebhookDeliveryResult,
  WebhookEnvelope,
  WebhookEventName,
  WebhookOptions,
  WebhookPayload,
  WEBHOOK_DEFAULTS,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
} from '@/types/webhooks';
import { ValidationError, WebhookError } from '@/errors';

interface LoggerProvider {
  logger?: Logger;
}

/**
 * Internal constructor parameter — accepts either a full client-like
 * object exposing a `logger` (e.g. `CoralSwapClient`) or `undefined`.
 * Decoupling from `@/client` keeps the module re-usable in environments
 * where the SDK client is not available.
 */
export type WebhookModuleDeps = LoggerProvider | undefined;

/**
 * Outbound webhook delivery module.
 *
 * Lets callers register HTTPS endpoints that should receive
 * notifications for a set of event names, then deliver arbitrary
 * payloads to those endpoints with HMAC-SHA256 authentication.
 *
 * The module is transport-agnostic: it uses the runtime's global
 * `fetch` (Node 20+ ships with one) or an explicit override for
 * testing. Every delivery attempt is logged at debug level when a
 * logger is available via the host client.
 *
 * @example
 * ```ts
 * const webhooks = new WebhookModule(client);
 * const id = await webhooks.registerWebhook(
 *   'https://hooks.example.com/coral',
 *   ['price', 'il'],
 *   'super-secret-shared-key',
 * );
 * const result = await webhooks.sendWebhook(id, {
 *   type: 'price',
 *   pair: 'CXXX...',
 *   price: '1234567',
 * });
 * ```
 */
export class WebhookModule {
  private readonly webhooks: Map<string, StoredWebhook> = new Map();
  private readonly logger?: Logger;

  constructor(deps: WebhookModuleDeps = undefined) {
    this.logger = deps?.logger;
  }

  /**
   * Register a webhook endpoint.
   *
   * Generates a unique identifier and stores the configuration for
   * later delivery. The URL is validated to use the HTTPS scheme —
   * plain HTTP endpoints are rejected to ensure credentials and
   * payloads cannot leak in cleartext.
   *
   * @param url - The HTTPS URL to POST notifications to.
   * @param events - Event names this endpoint is subscribed to.
   * @param secret - Optional shared secret for HMAC-SHA256 signing.
   * @returns The generated webhook identifier (string).
   * @throws {ValidationError} If the URL is missing, malformed, or
   *   not HTTPS; or if the event list is empty.
   */
  async registerWebhook(
    url: string,
    events: WebhookEventName[],
    secret?: string,
  ): Promise<string> {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new ValidationError('webhook url must not be empty', { url });
    }

    const parsed = parseHttpsUrl(url);
    if (!parsed) {
      throw new ValidationError(
        'webhook url must be a valid HTTPS URL',
        { url },
      );
    }

    if (!Array.isArray(events) || events.length === 0) {
      throw new ValidationError(
        'webhook events must be a non-empty array of strings',
        { events },
      );
    }

    for (const event of events) {
      if (typeof event !== 'string' || event.length === 0) {
        throw new ValidationError(
          'webhook event names must be non-empty strings',
          { event },
        );
      }
    }

    if (secret !== undefined && (typeof secret !== 'string' || secret.length === 0)) {
      throw new ValidationError(
        'webhook secret must be a non-empty string when provided',
        { secretProvided: secret !== undefined },
      );
    }

    const id = generateId();
    const stored: StoredWebhook = {
      id,
      url: parsed.toString(),
      events: [...events],
      ...(secret !== undefined ? { secret } : {}),
      createdAt: Date.now(),
    };
    this.webhooks.set(id, stored);

    this.logger?.info('webhooks.registerWebhook: registered', {
      id,
      url: stored.url,
      events: stored.events,
      signed: secret !== undefined,
    });

    return id;
  }

  /**
   * Deliver a payload to a previously registered webhook.
   *
   * Returns a {@link WebhookDeliveryResult} describing the final HTTP
   * response (or the network-error status code 0). The result is
   * returned even when the delivery fails — callers should inspect
   * `delivered` rather than relying on exceptions for routine
   * transport problems.
   *
   * Retries are performed automatically for 5xx responses, 429 rate
   * limits, and network errors. 4xx responses (other than 429) are
   * treated as permanent failures and surfaced immediately.
   *
   * @param webhookId - Identifier returned by {@link registerWebhook}.
   * @param payload - JSON-serializable payload to send (any object).
   * @param options - Per-call overrides for retry / timeout / fetch.
   * @throws {WebhookError} If the webhook id is not registered.
   */
  async sendWebhook<T extends WebhookPayload = WebhookPayload>(
    webhookId: string,
    payload: T,
    options: WebhookOptions = {},
  ): Promise<WebhookDeliveryResult> {
    const stored = this.webhooks.get(webhookId);
    if (!stored) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }

    const config = resolveOptions(options);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new WebhookError('no fetch implementation available in this environment', {
        webhookId,
      });
    }

    const event = pickEvent(stored.events);
    const envelope: WebhookEnvelope<T> = {
      id: generateUUID(),
      timestamp: Date.now(),
      ...(event !== undefined ? { event } : {}),
      data: payload,
    };
    const body = JSON.stringify(envelope);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CoralSwap-SDK/1.0 (+webhooks)',
    };
    if (stored.secret) {
      headers[WEBHOOK_SIGNATURE_HEADER] = buildSignature(stored.secret, body);
    }
    if (envelope.event) {
      headers['X-Webhook-Event'] = envelope.event;
    }
    headers['X-Webhook-Delivery'] = envelope.id;

    let retryCount = 0;
    let lastStatus = 0;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const outcome = await attemptDelivery(fetchImpl, stored.url, body, headers, config.timeoutMs);

      this.logger?.debug('webhooks.sendWebhook: attempt completed', {
        webhookId,
        attempt,
        maxRetries: config.maxRetries,
        statusCode: outcome.statusCode,
        delivered: outcome.delivered,
        networkError: outcome.networkError,
      });

      if (outcome.delivered) {
        if (attempt > 0) retryCount = attempt;
        return {
          statusCode: outcome.statusCode,
          delivered: true,
          retryCount,
        };
      }

      lastStatus = outcome.statusCode;
      lastError = outcome.error;

      if (!shouldRetry(outcome, attempt, config.maxRetries)) {
        return {
          statusCode: outcome.statusCode,
          delivered: false,
          retryCount: attempt,
        };
      }

      const delay = computeBackoff(attempt, config);
      this.logger?.debug('webhooks.sendWebhook: scheduling retry', {
        webhookId,
        nextDelayMs: delay,
      });
      await sleep(delay);
    }

    this.logger?.warn('webhooks.sendWebhook: delivery failed after retries', {
      webhookId,
      retryCount: config.maxRetries,
      lastStatus,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    });

    return {
      statusCode: lastStatus,
      delivered: false,
      retryCount: config.maxRetries,
    };
  }

  /**
   * Remove a webhook from the registry.
   *
   * Returns `true` if the webhook existed and was removed, `false`
   * otherwise. Does not throw for unknown ids so callers can use
   * this as an idempotent cleanup step.
   */
  deleteWebhook(webhookId: string): boolean {
    const existed = this.webhooks.delete(webhookId);
    if (existed) {
      this.logger?.info('webhooks.deleteWebhook: removed', { webhookId });
    }
    return existed;
  }

  /**
   * Return a read-only snapshot of all currently registered webhooks.
   */
  listWebhooks(): StoredWebhook[] {
    return Array.from(this.webhooks.values()).map((w) => ({
      ...w,
      events: [...w.events],
      ...(w.secret ? { secret: w.secret } : {}),
    }));
  }

  /**
   * Look up a registered webhook by id.
   */
  getWebhook(webhookId: string): StoredWebhook | undefined {
    const stored = this.webhooks.get(webhookId);
    return stored;
  }

  /**
   * Remove every registered webhook. Intended for test teardown and
   * for callers that want to re-initialise the module state.
   */
  clear(): void {
    this.webhooks.clear();
    this.logger?.info('webhooks.clear: cleared all webhooks');
  }
}

interface DeliveryOutcome {
  statusCode: number;
  delivered: boolean;
  networkError: boolean;
  error?: unknown;
}

async function attemptDelivery(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<DeliveryOutcome> {
  const init: RequestInit = {
    method: 'POST',
    headers,
    body,
  };

  try {
    const response = await runWithTimeout(fetchImpl, url, init, timeoutMs);
    const statusCode = response.status;
    const delivered = statusCode >= 200 && statusCode < 300;
    return { statusCode, delivered, networkError: false };
  } catch (err) {
    return {
      statusCode: 0,
      delivered: false,
      networkError: true,
      error: err,
    };
  }
}

async function runWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(
  outcome: DeliveryOutcome,
  attempt: number,
  maxRetries: number,
): boolean {
  if (attempt >= maxRetries) return false;

  if (outcome.networkError) return true;

  const code = outcome.statusCode;
  if (code === 429 || code === 408) return true;
  if (code >= 500 && code < 600) return true;
  return false;
}

function computeBackoff(attempt: number, config: Required<WebhookOptions>): number {
  const raw = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(config.maxDelayMs, raw);
}

interface ResolvedOptions extends Required<Omit<WebhookOptions, 'fetchImpl'>> {
  fetchImpl?: typeof fetch;
}

function resolveOptions(options: WebhookOptions): ResolvedOptions {
  return {
    maxRetries: options.maxRetries ?? WEBHOOK_DEFAULTS.maxRetries,
    baseDelayMs: options.baseDelayMs ?? WEBHOOK_DEFAULTS.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? WEBHOOK_DEFAULTS.maxDelayMs,
    backoffMultiplier: options.backoffMultiplier ?? WEBHOOK_DEFAULTS.backoffMultiplier,
    timeoutMs: options.timeoutMs ?? WEBHOOK_DEFAULTS.timeoutMs,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
}

function parseHttpsUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || parsed.hostname.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pickEvent(events: WebhookEventName[]): WebhookEventName | undefined {
  return events.length > 0 ? events[0] : undefined;
}

function buildSignature(secret: string, body: string): string {
  const digest = createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(body).digest('hex');
  return `${WEBHOOK_SIGNATURE_ALGORITHM}=${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateUUID(): string {
  try {
    return randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID.
    return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}
