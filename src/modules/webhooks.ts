import { CoralSwapClient } from '@/client';
import { WebhookDelivery } from '@/types/webhooks';

/**
 * Module for managing and tracking webhook delivery logs.
 *
 * Webhook delivery can fail due to network issues or endpoint downtime.
 * This module maintains a delivery log to help users debug failed notifications
 * and understand reliability.
 */
export class WebhookModule {
  private client: CoralSwapClient;
  private deliveries = new Map<string, WebhookDelivery[]>();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Log a webhook delivery attempt.
   *
   * @param webhookId - The unique identifier of the webhook
   * @param delivery - The delivery details to log
   */
  logDelivery(
    webhookId: string,
    delivery: Omit<WebhookDelivery, 'timestamp'> & { timestamp?: number }
  ): void {
    if (!this.deliveries.has(webhookId)) {
      this.deliveries.set(webhookId, []);
    }
    
    const entry: WebhookDelivery = {
      timestamp: delivery.timestamp ?? Date.now(),
      payload: delivery.payload,
      statusCode: delivery.statusCode,
      delivered: delivery.delivered,
      retryCount: delivery.retryCount,
      error: delivery.error,
    };

    this.deliveries.get(webhookId)!.push(entry);
  }

  /**
   * Get the delivery history for a specific webhook.
   *
   * @param webhookId - The unique identifier of the webhook
   * @param limit - The maximum number of entries to return (defaults to 50)
   * @returns Chronological delivery history (oldest first)
   */
  async getWebhookHistory(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const history = this.deliveries.get(webhookId);
    if (!history) {
      return [];
    }

    // Sort chronologically (ascending by timestamp)
    const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);

    // Return the most recent `limit` entries
    return sorted.slice(-limit);
  }

  /**
   * Clear the delivery history for a specific webhook.
   *
   * @param webhookId - The unique identifier of the webhook
   */
  clearHistory(webhookId: string): void {
    this.deliveries.delete(webhookId);
  }
}
