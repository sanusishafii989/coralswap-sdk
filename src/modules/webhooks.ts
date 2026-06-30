import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  StoredWebhook,
  WebhookDeliveryResult,
  WebhookEnvelope,
  WebhookEventName,
  WebhookHistoryEntry,
  WebhookHistoryPage,
  WebhookHistoryQuery,
  WebhookOptions,
  WebhookPayload,
  WebhookVerifyOptions,
  WebhookVerifyResult,
  WEBHOOK_DEFAULTS,
  WEBHOOK_DISABLE_FAILURE_THRESHOLD,
  WEBHOOK_HISTORY_CAPACITY,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_VERIFY_PAYLOAD_TYPE,
} from '@/types/webhooks';
import { ValidationError, WebhookDisabledError, WebhookError } from '@/errors';
import type { Logger } from '@/types/common';

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
 * Per-webhook runtime state maintained by the module.
 *
 * Stored in memory alongside the public {@link StoredWebhook} record
 * and discarded when the webhook is unregistered via
 * {@link WebhookModule.deleteWebhook} or {@link WebhookModule.clear}.
 */
interface WebhookState {
  /** Ring buffer of recorded terminal delivery attempts. */
  history: WebhookHistoryEntry[];
  /** Consecutive terminal failures since the last successful delivery. */
  consecutiveFailures: number;
  /** `true` when the webhook has been automatically disabled. */
  disabled: boolean;
  /** Epoch ms when the auto-disable kicked in, if applicable. */
  disabledAt?: number;
}

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
 * In addition to dispatching payloads, the module tracks delivery
 * outcomes in a bounded per-webhook ring buffer
 * ({@link WEBHOOK_HISTORY_CAPACITY}) and auto-disables any webhook
 * that records {@link WEBHOOK_DISABLE_FAILURE_THRESHOLD} consecutive
 * terminal failures. Maintenance entry points — `verifyWebhook`,
 * `getWebhookHistory`, `disableWebhook`, `enableWebhook`,
 * `isWebhookDisabled` — let callers inspect and recover from this
 * behaviour without state leaking out of the module.
 *
 * @example
 * ```ts
 * const webhooks = new WebhookModule(client);
 * const id = await webhooks.registerWebhook(
 *   'https://hooks.example.com/coral',
 *   ['price', 'il'],
 *   'super-secret-shared-key',
 * );
 * const verify = await webhooks.verifyWebhook(id);
 * const result = await webhooks.sendWebhook(id, {
 *   type: 'price',
 *   pair: 'CXXX...',
 *   price: '1234567',
 * });
 * const page = webhooks.getWebhookHistory(id, { limit: 25 });
 * ```
 */
export class WebhookModule {
  private readonly webhooks: Map<string, StoredWebhook> = new Map();
  private readonly webhookState: Map<string, WebhookState> = new Map();
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
    this.webhookState.set(id, createInitialState());

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
   * If {@link WEBHOOK_DISABLE_FAILURE_THRESHOLD} consecutive terminal
   * failures are recorded the webhook is auto-disabled and subsequent
   * calls throw a {@link WebhookError} until re-enabled via
   * {@link WebhookModule.enableWebhook}.
   *
   * @param webhookId - Identifier returned by {@link registerWebhook}.
   * @param payload - JSON-serializable payload to send (any object).
   * @param options - Per-call overrides for retry / timeout / fetch.
   * @throws {WebhookError} If the webhook id is not registered or if
   *   the webhook has been auto-disabled.
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

    const state = this.requireState(webhookId);
    if (state.disabled) {
      throw new WebhookDisabledError(webhookId, state.consecutiveFailures, {
        ...(state.disabledAt !== undefined ? { disabledAt: state.disabledAt } : {}),
      });
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
    let attempts = 0;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const outcome = await attemptDelivery(fetchImpl, stored.url, body, headers, config.timeoutMs);
      attempts += 1;

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
        this.recordOutcome(state, {
          deliveryId: envelope.id,
          timestamp: Date.now(),
          statusCode: outcome.statusCode,
          delivered: true,
          attempts,
          retryCount,
          outcome: 'success',
        });
        return {
          statusCode: outcome.statusCode,
          delivered: true,
          retryCount,
        };
      }

      const isFinalAttempt = attempt >= config.maxRetries;
      if (!shouldRetry(outcome, attempt, config.maxRetries)) {
        const classification = classifyOutcome(outcome);
        this.recordOutcome(state, {
          deliveryId: envelope.id,
          timestamp: Date.now(),
          statusCode: outcome.statusCode,
          delivered: false,
          attempts,
          retryCount: attempt,
          outcome: classification.outcome,
          ...(classification.errorMessage !== undefined
            ? { errorMessage: classification.errorMessage }
            : {}),
        });
        if (isFinalAttempt) {
          this.logger?.warn?.('webhooks.sendWebhook: delivery failed after retries', {
            webhookId,
            attempt,
            retryCount: config.maxRetries,
            lastStatus: outcome.statusCode,
            lastError: outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? ''),
          });
        }
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

    // The loop above always returns inside (success or final retry).
    // This branch is unreachable but exists as a strict-mode
    // exhaustiveness net — any new code path that breaks the loop's
    // return discipline will surface here with a clear error rather
    // than silently returning undefined.
    throw new WebhookError(
      'webhook delivery exited retry loop without a terminal outcome',
      { webhookId },
    );
  }

  /**
   * Perform a handshake with the registered endpoint to confirm
   * connectivity, TLS validity, and that the receiver understands
   * the SDK's payload format.
   *
   * The handshake is a single POST whose body is `{
   *   type: WEBHOOK_VERIFY_PAYLOAD_TYPE, challenge: <random> }`,
   * signed with the same HMAC key as live deliveries when a secret is
   * configured for the webhook. The result is always returned
   * rather than thrown so callers can branch on `verified` without
   * try/catch.
   *
   * Failure to find the webhook raises {@link WebhookError}; failures
   * from the remote endpoint populate `verified: false` and
   * `error`.
   *
   * @param webhookId - Identifier returned by {@link registerWebhook}.
   * @param options - Per-call overrides (timeout, fetchImpl).
   */
  async verifyWebhook(
    webhookId: string,
    options: WebhookVerifyOptions = {},
  ): Promise<WebhookVerifyResult> {
    const stored = this.webhooks.get(webhookId);
    if (!stored) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }

    const challenge = generateChallenge();
    const body = JSON.stringify({
      type: WEBHOOK_VERIFY_PAYLOAD_TYPE,
      challenge,
      webhookId,
      timestamp: Date.now(),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CoralSwap-SDK/1.0 (+webhooks)',
      'X-Webhook-Verify': '1',
    };
    if (stored.secret) {
      headers[WEBHOOK_SIGNATURE_HEADER] = buildSignature(stored.secret, body);
    }

    const timeoutMs = options.timeoutMs ?? WEBHOOK_DEFAULTS.timeoutMs;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new WebhookError('no fetch implementation available in this environment', {
        webhookId,
      });
    }

    const start = Date.now();
    try {
      const response = await runWithTimeout(fetchImpl, stored.url, {
        method: 'POST',
        headers,
        body,
      }, timeoutMs);
      const latencyMs = Date.now() - start;
      const verified = response.status >= 200 && response.status < 300;
      this.logger?.debug('webhooks.verifyWebhook: handshake completed', {
        webhookId,
        statusCode: response.status,
        verified,
        latencyMs,
      });
      return {
        verified,
        statusCode: response.status,
        latencyMs,
        challenge,
        ...(verified ? {} : { error: `endpoint returned status ${response.status}` }),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.('webhooks.verifyWebhook: handshake failed', {
        webhookId,
        latencyMs,
        error: message,
      });
      return {
        verified: false,
        statusCode: 0,
        latencyMs,
        challenge,
        error: message,
      };
    }
  }

  /**
   * Return a paginated slice of recorded delivery entries for a
   * webhook. Pagination is both cursor-based (preferred for large
   * datasets) and offset-based (convenient for UI pagination
   * controls). The newest entry is returned first.
   *
   * Ordering and pagination semantics:
   * - `total` is the count of all entries stored for the webhook.
   * - Pages are returned **newest first**: the most recent successful
   *   or failed delivery sits at index 0 of `items`.
   * - `limit` caps the number of items per page (1..200, default 50).
   * - `cursor` takes precedence over `offset`. The cursor is opaque,
   *   but encodes the count of items already consumed from the
   *   newest-first ordering; callers should pass back the value
   *   returned in the previous page's `nextCursor`.
   * - `offset` skips the first `offset` entries (when measured from
   *   the newest end) and returns the next `limit` items. Useful for
   *   classic index/limit UI controls.
   *
   * @param webhookId - Identifier returned by {@link registerWebhook}.
   * @param query - Optional pagination controls.
   * @throws {WebhookError} If the webhook id is unknown.
   */
  getWebhookHistory(
    webhookId: string,
    query: WebhookHistoryQuery = {},
  ): WebhookHistoryPage {
    const stored = this.webhooks.get(webhookId);
    if (!stored) {
      throw new WebhookError(`webhook not found: ${webhookId}`, { webhookId });
    }

    const state = this.requireState(webhookId);
    const limit = clampLimit(query.limit);
    const total = state.history.length;

    // Cursor takes precedence: it encodes how many entries have
    // already been consumed from the newest-first ordering. We
    // re-derive startIndex so subsequent pages continue where the
    // previous one left off.
    let startIndex = total;
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      const decoded = decodeCursor(query.cursor);
      if (decoded !== null && decoded >= 0 && decoded <= total) {
        startIndex = total - decoded;
      }
    } else if (typeof query.offset === 'number' && query.offset >= 0) {
      startIndex = total - query.offset;
    }

    const sliceEnd = Math.max(0, startIndex - limit);
    const items = state.history.slice(sliceEnd, startIndex).reverse();
    const nextOffset = total - startIndex + items.length;
    const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : null;

    return {
      items,
      nextCursor,
      total,
    };
  }

  /**
   * `true` if a webhook has been auto-disabled after recording
   * {@link WEBHOOK_DISABLE_FAILURE_THRESHOLD} consecutive failures,
   * or {@link WebhookModule.disableWebhook} was called explicitly.
   */
  isWebhookDisabled(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    return state?.disabled === true;
  }

  /**
   * Manually disable a webhook. Subsequent calls to
   * {@link WebhookModule.sendWebhook} will throw
   * {@link WebhookError} until {@link WebhookModule.enableWebhook}
   * is called. Resets the failure counter without altering the
   * delivery history.
   */
  disableWebhook(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    if (!state) return false;
    if (!state.disabled) {
      state.disabled = true;
      state.disabledAt = Date.now();
      this.logger?.info('webhooks.disableWebhook: webhook disabled', { webhookId });
    }
    return true;
  }

  /**
   * Re-enable a previously auto-disabled or manually disabled
   * webhook and reset the consecutive-failure counter. The
   * delivery history is preserved.
   */
  enableWebhook(webhookId: string): boolean {
    const state = this.webhookState.get(webhookId);
    if (!state) return false;
    if (state.disabled || state.consecutiveFailures > 0) {
      state.disabled = false;
      state.consecutiveFailures = 0;
      delete state.disabledAt;
      this.logger?.info('webhooks.enableWebhook: webhook re-enabled', { webhookId });
    }
    return true;
  }

  /**
   * Return the current consecutive-failure count for a webhook.
   * Used by tests and observability tooling.
   */
  getWebhookFailureCount(webhookId: string): number {
    return this.webhookState.get(webhookId)?.consecutiveFailures ?? 0;
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
    this.webhookState.delete(webhookId);
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
    return this.webhooks.get(webhookId);
  }

  /**
   * Remove every registered webhook and clear all per-webhook
   * runtime state. Intended for test teardown and for callers that
   * want to re-initialise the module state.
   */
  clear(): void {
    this.webhooks.clear();
    this.webhookState.clear();
    this.logger?.info('webhooks.clear: cleared all webhooks');
  }

  private requireState(webhookId: string): WebhookState {
    const state = this.webhookState.get(webhookId);
    if (!state) {
      throw new WebhookError(`webhook state missing: ${webhookId}`, { webhookId });
    }
    return state;
  }

  private recordTerminal(state: WebhookState, entry: WebhookHistoryEntry): void {
    state.history.push(entry);
    if (state.history.length > WEBHOOK_HISTORY_CAPACITY) {
      state.history.splice(0, state.history.length - WEBHOOK_HISTORY_CAPACITY);
    }
  }

  private recordOutcome(state: WebhookState, entry: WebhookHistoryEntry): void {
    this.recordTerminal(state, entry);
    if (entry.outcome === 'success') {
      // Success resets the consecutive-failure counter and lifts any
      // auto-disable (so the webhook resumes delivery immediately).
      if (state.consecutiveFailures !== 0) {
        state.consecutiveFailures = 0;
      }
      return;
    }
    if (entry.outcome === 'client') {
      // Permanent client errors (4xx other than 429/408) are not counted
      // toward the consecutive-failure threshold; reset to be safe.
      if (state.consecutiveFailures !== 0) {
        state.consecutiveFailures = 0;
      }
      return;
    }
    // 'network' or 'server' advance the failure counter and may
    // trigger auto-disable at the threshold.
    state.consecutiveFailures += 1;
    if (
      state.consecutiveFailures >= WEBHOOK_DISABLE_FAILURE_THRESHOLD &&
      !state.disabled
    ) {
      state.disabled = true;
      state.disabledAt = Date.now();
      this.logger?.warn?.('webhooks.sendWebhook: auto-disabled after consecutive failures', {
        consecutiveFailures: state.consecutiveFailures,
        threshold: WEBHOOK_DISABLE_FAILURE_THRESHOLD,
      });
    }
  }
}

interface DeliveryOutcome {
  statusCode: number;
  delivered: boolean;
  networkError: boolean;
  error?: unknown;
}

interface OutcomeClassification {
  outcome: WebhookHistoryEntry['outcome'];
  errorMessage?: string;
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

function classifyOutcome(outcome: DeliveryOutcome): OutcomeClassification {
  if (outcome.networkError) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? '');
    return { outcome: 'network', errorMessage: message };
  }
  const code = outcome.statusCode;
  if (code >= 200 && code < 300) {
    return { outcome: 'success' };
  }
  if (code >= 500 && code < 600) {
    return { outcome: 'server', errorMessage: `server returned ${code}` };
  }
  return { outcome: 'client', errorMessage: `client returned ${code}` };
}

function computeBackoff(attempt: number, config: Required<Omit<WebhookOptions, 'fetchImpl'>>): number {
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

function generateChallenge(): string {
  try {
    return randomBytes(16).toString('hex');
  } catch {
    return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function createInitialState(): WebhookState {
  return {
    history: [],
    consecutiveFailures: 0,
    disabled: false,
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return 50;
  }
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^o:(\d+)$/.exec(decoded);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
