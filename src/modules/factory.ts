import { xdr } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import { sortTokens } from '@/utils/addresses';
import { EventParser } from '@/utils/events';
import { PoolEvent } from '@/types/events';
import { Logger } from '@/types/common';
import { CoralSwapEvent } from '@/types/events';

/**
 * Options for getPairAddress lookups.
 */
export interface GetPairOptions {
    /** Skip the local cache and query the contract directly. Defaults to false. */
    bypassCache?: boolean;
}

/**
 * Module for interacting with the CoralSwap Factory contract.
 *
 * Implements a caching layer for pair addresses to minimize RPC traffic
 * and improve performance across the SDK.
 */
export class FactoryModule {
    private client: CoralSwapClient;
    private cache: Map<string, string | null> = new Map();

    constructor(client: CoralSwapClient) {
        this.client = client;
    }

    /**
     * Resolve a pair contract address for two tokens.
     *
     * Checks the local cache first before querying the on-chain Factory contract.
     * Resulting addresses are cached for the lifetime of the client or until
     * the network is switched.
     *
     * @param tokenA - First token address.
     * @param tokenB - Second token address.
     * @param options - Lookup options.
     * @returns The pair address, or null if it doesn't exist.
     */
    async getPairAddress(
        tokenA: string,
        tokenB: string,
        options: GetPairOptions = {},
    ): Promise<string | null> {
        const [t0, t1] = sortTokens(tokenA, tokenB);
        const cacheKey = `${t0}:${t1}`;

        if (!options.bypassCache && this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey) ?? null;
        }

        const pairAddress = await this.client.factory.getPair(t0, t1);
        this.cache.set(cacheKey, pairAddress);

        return pairAddress;
    }

    /**
     * Pre-load the cache with known token pairs and their contract addresses.
     *
     * Useful for performance optimization when an application already knows
     * common pairs from a token list or local storage.
     *
     * @param pairs - Array of tokens pairs [tokenA, tokenB, pairAddress].
     */
    preLoadPairs(pairs: Array<[string, string, string]>): void {
        for (const [a, b, addr] of pairs) {
            const [t0, t1] = sortTokens(a, b);
            this.cache.set(`${t0}:${t1}`, addr);
        }
    }

    /**
     * Clear all cached pair addresses.
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Subscribe to real-time swap, mint, and burn events from a pool.
     *
     * Polls the Soroban RPC `getEvents` endpoint at the given interval
     * (default: 6000ms ≈ one Stellar ledger) and delivers parsed
     * {@link PoolEvent} objects to the supplied callback.
     *
     * Events are deduplicated at the ledger level — the same ledger never
     * fires the callback more than once. Polling errors are logged but
     * never crash the subscription.
     *
     * @param pairAddress - The Soroban contract address of the pool/pair.
     * @param callback    - Called once per new event with the parsed event.
     * @param intervalMs  - Polling interval in milliseconds (default 6000).
     * @returns An unsubscribe function that stops polling immediately.
     *
     * @example
     * ```ts
     * const unsubscribe = factory.watchPool(pairAddress, (event) => {
     *   if (event.type === 'swap') {
     *     console.log(`Swapped ${event.amountIn} → ${event.amountOut}`);
     *   }
     * });
     *
     * // Later:
     * unsubscribe();
     * ```
     */
    watchPool(
      pairAddress: string,
      callback: (event: PoolEvent) => void,
      intervalMs?: number,
    ): () => void {
      const interval = intervalMs ?? 6000;
      let active = true;
      let lastSeenLedger = 0;
      const parser = new EventParser([pairAddress]);
      const logger: Logger | undefined = this.client.config.logger;

      const poll = async () => {
        if (!active) return;

        try {
          const topics = ['swap', 'mint', 'burn'].map((t) =>
            xdr.ScVal.scvSymbol(t).toXDR('base64'),
          );

          const response = await this.client.server.getEvents({
            startLedger: lastSeenLedger + 1,
            filters: [
              {
                type: 'contract',
                contractIds: [pairAddress],
                topics: topics.map((t) => [t]),
              },
            ],
            limit: 100,
          });

          for (const event of response.events) {
            if (event.ledger <= lastSeenLedger) continue;

            const parsed = parser.fromEventResponse(event);
            if (parsed && isPoolEvent(parsed)) {
              callback(parsed);
            }
          }

          if (response.events.length > 0) {
            lastSeenLedger = response.events.reduce(
              (max, e) => Math.max(max, e.ledger),
              lastSeenLedger,
            );
          }
        } catch (err) {
          logger?.error(
            'watchPool: polling error',
            err instanceof Error ? err : String(err),
          );
        }
      };

      const id = setInterval(poll, interval);
      poll();

      return () => {
        active = false;
        clearInterval(id);
      };
    }
}

function isPoolEvent(event: CoralSwapEvent): event is PoolEvent {
  return event.type === 'swap' || event.type === 'mint' || event.type === 'burn';
}
