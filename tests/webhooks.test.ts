import { WebhookModule } from '../src/modules/webhooks';
import type { CoralSwapClient } from '../src/client';

describe('WebhookModule', () => {
  let client: CoralSwapClient;
  let webhooks: WebhookModule;

  beforeEach(() => {
    client = {} as unknown as CoralSwapClient;
    webhooks = new WebhookModule(client);
  });

  it('should return empty history for new/non-existent webhooks', async () => {
    const history = await webhooks.getWebhookHistory('new-webhook-id');
    expect(history).toEqual([]);
  });

  it('should log and return delivery history in chronological order', async () => {
    const webhookId = 'test-webhook';

    const delivery1 = {
      timestamp: 1000,
      payload: { event: 'swap', amount: 100 },
      statusCode: 200,
      delivered: true,
      retryCount: 0,
    };

    const delivery2 = {
      timestamp: 2000,
      payload: { event: 'swap', amount: 200 },
      statusCode: 500,
      delivered: false,
      retryCount: 3,
      error: 'Timeout',
    };

    // Log out of order to ensure sorting works
    webhooks.logDelivery(webhookId, delivery2);
    webhooks.logDelivery(webhookId, delivery1);

    const history = await webhooks.getWebhookHistory(webhookId);

    expect(history).toHaveLength(2);
    // Should be chronological (oldest first: delivery1 before delivery2)
    expect(history[0]).toEqual(delivery1);
    expect(history[1]).toEqual(delivery2);
  });

  it('should apply default limit of 50', async () => {
    const webhookId = 'limit-webhook';

    for (let i = 0; i < 60; i++) {
      webhooks.logDelivery(webhookId, {
        timestamp: 1000 + i,
        payload: { index: i },
        statusCode: 200,
        delivered: true,
        retryCount: 0,
      });
    }

    const history = await webhooks.getWebhookHistory(webhookId);
    expect(history).toHaveLength(50);
    // Verify it returned the last 50 entries
    expect(history[0].timestamp).toBe(1010);
    expect(history[49].timestamp).toBe(1059);
  });

  it('should respect custom limit', async () => {
    const webhookId = 'custom-limit-webhook';

    for (let i = 0; i < 10; i++) {
      webhooks.logDelivery(webhookId, {
        timestamp: 1000 + i,
        payload: { index: i },
        statusCode: 200,
        delivered: true,
        retryCount: 0,
      });
    }

    const history = await webhooks.getWebhookHistory(webhookId, 5);
    expect(history).toHaveLength(5);
    expect(history[0].timestamp).toBe(1005);
    expect(history[4].timestamp).toBe(1009);
  });

  it('should support clearing history', async () => {
    const webhookId = 'clear-webhook';
    webhooks.logDelivery(webhookId, {
      timestamp: 1000,
      payload: { test: true },
      statusCode: 200,
      delivered: true,
      retryCount: 0,
    });

    let history = await webhooks.getWebhookHistory(webhookId);
    expect(history).toHaveLength(1);

    webhooks.clearHistory(webhookId);

    history = await webhooks.getWebhookHistory(webhookId);
    expect(history).toEqual([]);
  });
});
