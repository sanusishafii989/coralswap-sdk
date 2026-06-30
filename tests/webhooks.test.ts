import { createHmac } from 'node:crypto';
import { WebhookModule } from '../src/modules/webhooks';
import {
  WEBHOOK_DEFAULTS,
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
} from '../src/types/webhooks';
import { ValidationError, WebhookError } from '../src/errors';
import type { Logger } from '../src/types/common';

const VALID_URL = 'https://hooks.example.com/coral';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(
  responses: Array<(call: FetchCall) => Response | Promise<Response>>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = jest.fn(async (url: any, init?: any) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    const handler = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return handler(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function responseWithStatus(status: number, body: unknown = ''): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('WebhookModule', () => {
  describe('registerWebhook()', () => {
    it('returns a non-empty webhook id', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('stores the webhook so listWebhooks returns it', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il'], 'shh');
      const list = webhooks.listWebhooks();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id,
        url: VALID_URL,
        events: ['price', 'il'],
        secret: 'shh',
      });
    });

    it('attaches a createdAt timestamp', async () => {
      const webhooks = new WebhookModule();
      const before = Date.now();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const record = webhooks.getWebhook(id);
      expect(record?.createdAt).toBeGreaterThanOrEqual(before);
    });

    it('rejects non-HTTPS URLs', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('http://hooks.example.com/coral', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects malformed URLs', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('not-a-url', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects URLs with empty host', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('https://', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('accepts uppercase HTTPS protocol via URL normalization', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('HTTPS://hooks.example.com/coral', ['price']),
      ).resolves.toEqual(expect.any(String));
    });

    it('rejects empty url strings', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook('   ', ['price']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects empty events arrays', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook(VALID_URL, []),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects events that contain empty strings', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook(VALID_URL, ['price', '']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects empty secrets when provided', async () => {
      const webhooks = new WebhookModule();
      await expect(
        webhooks.registerWebhook(VALID_URL, ['price'], ''),
      ).rejects.toThrow(ValidationError);
    });

    it('generates unique ids across registrations', async () => {
      const webhooks = new WebhookModule();
      const ids = await Promise.all(
        Array.from({ length: 12 }, () => webhooks.registerWebhook(VALID_URL, ['price'])),
      );
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('sendWebhook()', () => {
    it('throws WebhookError when the webhook id is unknown', async () => {
      const webhooks = new WebhookModule();
      await expect(webhooks.sendWebhook('unknown-id', { foo: 'bar' })).rejects.toThrow(WebhookError);
    });

    it('throws WebhookError when no fetch implementation is available', async () => {
      const webhooks = new WebhookModule();
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const original = globalThis.fetch;
      // @ts-expect-error -- intentionally detach fetch for this test
      globalThis.fetch = undefined;
      try {
        await expect(webhooks.sendWebhook(id, { foo: 'bar' })).rejects.toThrow(WebhookError);
      } finally {
        globalThis.fetch = original;
      }
    });

    it('returns delivered=true with retryCount=0 on a 2xx response', async () => {
      const mock = installFetchMock([() => responseWithStatus(200, { ok: true })]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' });
        expect(result).toEqual({ statusCode: 200, delivered: true, retryCount: 0 });
        expect(mock.calls).toHaveLength(1);
      } finally {
        mock.restore();
      }
    });

    it('returns delivered=true with retryCount when retrying succeeds', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(503),
        () => responseWithStatus(502),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.retryCount).toBeGreaterThanOrEqual(1);
        expect(mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        mock.restore();
      }
    });

    it('returns delivered=false on a 4xx response and does NOT retry', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(401),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' });
        expect(result.delivered).toBe(false);
        expect(result.statusCode).toBe(401);
        expect(result.retryCount).toBe(0);
        expect(mock.calls).toHaveLength(1);
      } finally {
        mock.restore();
      }
    });

    it('retries on 429 and stops when subsequent attempts succeed', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(429),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.retryCount).toBeGreaterThanOrEqual(1);
      } finally {
        mock.restore();
      }
    });

    it('retries on network errors and ultimately fails', async () => {
      const mock = installFetchMock([
        () => Promise.reject(new Error('ECONNRESET')),
        () => Promise.reject(new Error('ECONNRESET')),
        () => Promise.reject(new Error('ECONNRESET')),
        () => Promise.reject(new Error('ECONNRESET')),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, { baseDelayMs: 1 });
        expect(result.delivered).toBe(false);
        expect(result.statusCode).toBe(0);
        expect(result.retryCount).toBe(3);
        expect(mock.calls).toHaveLength(4); // initial + 3 retries (default)
      } finally {
        mock.restore();
      }
    });

    it('respects the configured maxRetries override', async () => {
      const mock = installFetchMock([
        () => Promise.reject(new Error('ETIMEDOUT')),
        () => Promise.reject(new Error('ETIMEDOUT')),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        const result = await webhooks.sendWebhook(id, 'x', { maxRetries: 1, baseDelayMs: 1 });
        expect(result.delivered).toBe(false);
        expect(result.retryCount).toBe(1);
        expect(mock.calls).toHaveLength(2);
      } finally {
        mock.restore();
      }
    });

    it('sends the payload as JSON body with correct content-type', async () => {
      const mock = installFetchMock([() => responseWithStatus(204)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const init = mock.calls[0].init;
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(typeof init.body).toBe('string');
        const envelope = JSON.parse(init.body as string);
        expect(envelope.data).toEqual({ foo: 'bar' });
        expect(typeof envelope.id).toBe('string');
        expect(typeof envelope.timestamp).toBe('number');
      } finally {
        mock.restore();
      }
    });

    it('includes event metadata headers from the first subscribed event', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price', 'il']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers['X-Webhook-Event']).toBe('price');
        expect(headers['X-Webhook-Delivery']).toBeDefined();
      } finally {
        mock.restore();
      }
    });

    it('assigns a unique X-Webhook-Delivery id per attempt', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(200),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        await webhooks.sendWebhook(id, { foo: 'baz' });
        const delivery1 = (mock.calls[0].init.headers as Record<string, string>)['X-Webhook-Delivery'];
        const delivery2 = (mock.calls[1].init.headers as Record<string, string>)['X-Webhook-Delivery'];
        expect(delivery1).toBeTruthy();
        expect(delivery2).toBeTruthy();
        expect(delivery1).not.toBe(delivery2);
      } finally {
        mock.restore();
      }
    });

    it('aborts a hung fetch via timeoutMs', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      const original = globalThis.fetch;
      globalThis.fetch = jest.fn((_url: any, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as any).name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof fetch;
      try {
        const result = await webhooks.sendWebhook(id, { foo: 'bar' }, {
          timeoutMs: 10,
          baseDelayMs: 1,
          maxRetries: 0,
        });
        expect(result.delivered).toBe(false);
        expect(result.statusCode).toBe(0);
        expect(result.retryCount).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
    });

    it('accepts a custom fetchImpl override', async () => {
      const customFetch = jest.fn().mockResolvedValue(responseWithStatus(200));
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      // Detach global fetch to confirm the override path is used.
      const original = globalThis.fetch;
      // @ts-expect-error -- intentional detachment
      globalThis.fetch = undefined;
      try {
        await webhooks.sendWebhook(id, { foo: 'bar' }, { fetchImpl: customFetch });
        expect(customFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe('HMAC signature', () => {
    it('signs the body when a secret is provided', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = 'super-secret-key';
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        const signature = headers[WEBHOOK_SIGNATURE_HEADER];
        expect(signature).toBeDefined();

        const body = mock.calls[0].init.body as string;
        const expected = `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(body).digest('hex')}`;
        expect(signature).toBe(expected);
      } finally {
        mock.restore();
      }
    });

    it('signature differs when the body changes', async () => {
      const mock = installFetchMock([
        () => responseWithStatus(200),
        () => responseWithStatus(200),
      ]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = 'super-secret-key';
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const sig1 = (mock.calls[0].init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER];
        await webhooks.sendWebhook(id, { foo: 'changed' });
        const sig2 = (mock.calls[1].init.headers as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER];
        expect(sig1).toBeDefined();
        expect(sig2).toBeDefined();
        expect(sig1).not.toBe(sig2);
      } finally {
        mock.restore();
      }
    });

    it('signature verifies a recomputed hash independently', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const secret = 'shared-secret';
        const id = await webhooks.registerWebhook(VALID_URL, ['price'], secret);
        await webhooks.sendWebhook(id, { tick: 'up' });

        const headers = mock.calls[0].init.headers as Record<string, string>;
        const body = mock.calls[0].init.body as string;
        const sent = headers[WEBHOOK_SIGNATURE_HEADER];
        const recomputed = `${WEBHOOK_SIGNATURE_ALGORITHM}=${createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secret).update(body).digest('hex')}`;
        expect(sent).toBe(recomputed);
      } finally {
        mock.restore();
      }
    });

    it('does NOT include the signature header when no secret was given', async () => {
      const mock = installFetchMock([() => responseWithStatus(200)]);
      try {
        const webhooks = new WebhookModule({ logger: silentLogger });
        const id = await webhooks.registerWebhook(VALID_URL, ['price']);
        await webhooks.sendWebhook(id, { foo: 'bar' });
        const headers = mock.calls[0].init.headers as Record<string, string>;
        expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
      } finally {
        mock.restore();
      }
    });
  });

  describe('lifecycle', () => {
    it('deleteWebhook returns true for known ids and false for unknown ids', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      const id = await webhooks.registerWebhook(VALID_URL, ['price']);
      expect(webhooks.deleteWebhook(id)).toBe(true);
      expect(webhooks.deleteWebhook(id)).toBe(false);
      expect(webhooks.listWebhooks()).toHaveLength(0);
    });

    it('clear() removes all webhooks', async () => {
      const webhooks = new WebhookModule({ logger: silentLogger });
      await webhooks.registerWebhook(VALID_URL, ['price']);
      await webhooks.registerWebhook(VALID_URL, ['il']);
      webhooks.clear();
      expect(webhooks.listWebhooks()).toHaveLength(0);
    });
  });

  describe('exported constants', () => {
    it('exposes the webhook retry defaults', () => {
      expect(WEBHOOK_DEFAULTS.maxRetries).toBe(3);
      expect(typeof WEBHOOK_DEFAULTS.baseDelayMs).toBe('number');
      expect(typeof WEBHOOK_DEFAULTS.backoffMultiplier).toBe('number');
    });

    it('exposes the signature header and algorithm constants', () => {
      expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Signature');
      expect(WEBHOOK_SIGNATURE_ALGORITHM).toBe('sha256');
    });
  });
});
