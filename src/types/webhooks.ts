/**
 * Log entry for a webhook delivery attempt.
 */
export interface WebhookDelivery {
  /** The Unix timestamp (in milliseconds) when the delivery was attempted. */
  timestamp: number;
  /** The payload sent to the webhook endpoint. */
  payload: any;
  /** The HTTP status code returned by the endpoint (e.g., 200, 500). */
  statusCode: number;
  /** Whether the delivery was successful. */
  delivered: boolean;
  /** The number of retry attempts made before reaching the final outcome. */
  retryCount: number;
  /** Optional error message if the delivery failed. */
  error?: string;
}
