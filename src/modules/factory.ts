import { CoralSwapClient } from '@/client';
import { PairInfo } from '@/types/pool';
import { sortTokens } from '@/utils/addresses';
import { PairNotFoundError } from '@/errors';

/** Default cache TTL in milliseconds (60 seconds). */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * A single entry in the pair-address cache.
 * Stores the resolved address (or null) together with the wall-clock
 * expiry so that stale data is automatically re-fetched.
 */
interface CacheEntry {
    /** Resolved pair address, or null when the pair does not exist. */
    address: string | null;
    /** Absolute timestamp (ms since epoch) after which this entry is stale. */
    expiresAt: number;
}

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
 * Provides a TTL-based caching layer for pair addresses to minimize RPC
 * traffic, plus a batched `getPairInfo()` that returns reserves, fee, and
 * total supply in a single parallel multicall.
 *
 * Cache TTL defaults to 60 seconds and is configurable at construction time.
 */
export class FactoryModule {
    private client: CoralSwapClient;
    private cache: Map<string, CacheEntry> = new Map();
    private cacheTtlMs: number;

    /**
     * @param client - The CoralSwapClient instance.
     * @param cacheTtlMs - Cache time-to-live in milliseconds. Defaults to 60 000 (60 s).
     */
    constructor(client: CoralSwapClient, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
        this.client = client;
        this.cacheTtlMs = cacheTtlMs;
    }

    /**
     * Resolve a pair contract address for two tokens.
     *
     * Checks the local TTL cache first. A cached entry is considered valid
     * until its `expiresAt` timestamp passes. Expired or absent entries
     * trigger a fresh on-chain lookup whose result is then cached.
     *
     * @param tokenA - First token address.
     * @param tokenB - Second token address.
     * @param options - Lookup options.
     * @returns The pair address, or null if the pair does not exist.
     */
    async getPairAddress(
        tokenA: string,
        tokenB: string,
        options: GetPairOptions = {},
    ): Promise<string | null> {
        const [t0, t1] = sortTokens(tokenA, tokenB);
        const cacheKey = `${t0}:${t1}`;

        if (!options.bypassCache) {
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() < cached.expiresAt) {
                return cached.address;
            }
        }

        const pairAddress = await this.client.factory.getPair(t0, t1);
        this.cache.set(cacheKey, {
            address: pairAddress,
            expiresAt: Date.now() + this.cacheTtlMs,
        });

        return pairAddress;
    }

    /**
     * Fetch batched pair metadata in a single parallel multicall.
     *
     * Resolves the pair address (from cache or on-chain), then concurrently
     * fetches reserves, dynamic fee, LP token address, and total LP supply —
     * returning all five fields in one `PairInfo` object.
     *
     * The pair address itself is cached with the standard TTL. Reserve/fee/
     * supply values are always fetched fresh (they change with every swap).
     *
     * @param tokenA - First token address.
     * @param tokenB - Second token address.
     * @returns A {@link PairInfo} containing address, reserveA, reserveB,
     *   feeBps, and totalSupply.
     * @throws {PairNotFoundError} If no pair exists for the given tokens.
     *
     * @example
     * const info = await factory.getPairInfo('CDLZ...', 'CBQH...');
     * console.log(info.reserveA, info.reserveB, info.feeBps, info.totalSupply);
     */
    async getPairInfo(tokenA: string, tokenB: string): Promise<PairInfo> {
        const [t0, t1] = sortTokens(tokenA, tokenB);

        const pairAddress = await this.getPairAddress(t0, t1);
        if (!pairAddress) {
            throw new PairNotFoundError(tokenA, tokenB);
        }

        const pair = this.client.pair(pairAddress);

        // Parallel multicall: reserves + fee + LP address fetched concurrently
        const [reserves, feeBps, lpTokenAddress] = await Promise.all([
            pair.getReserves(),
            pair.getDynamicFee(),
            pair.getLPTokenAddress(),
        ]);

        // Fetch total LP supply via the LP token contract
        const lpToken = this.client.lpToken(lpTokenAddress);
        const totalSupply = await lpToken.totalSupply();

        // Map reserves back to caller's token ordering (tokenA → reserveA)
        const isToken0A = t0 === tokenA;
        const reserveA = isToken0A ? reserves.reserve0 : reserves.reserve1;
        const reserveB = isToken0A ? reserves.reserve1 : reserves.reserve0;

        return {
            address: pairAddress,
            reserveA,
            reserveB,
            feeBps,
            totalSupply,
        };
    }

    /**
     * Invalidate cached data for a specific pair or for all pairs.
     *
     * - Called with a pair address: removes any cache entry whose stored
     *   address matches the given pair address.
     * - Called with no argument: clears the entire cache.
     *
     * Use this after creating a new pair, or when you know that on-chain
     * state has changed and you need fresh data on the next lookup.
     *
     * @param pairAddress - Optional pair contract address to invalidate.
     *   When omitted, all cached entries are cleared.
     *
     * @example
     * // Invalidate one pair
     * factory.invalidateCache('CPAIR...');
     *
     * // Clear everything
     * factory.invalidateCache();
     */
    invalidateCache(pairAddress?: string): void {
        if (pairAddress === undefined) {
            this.cache.clear();
            return;
        }

        // Walk the cache and remove any entry whose resolved address matches
        for (const [key, entry] of this.cache.entries()) {
            if (entry.address === pairAddress) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Pre-load the cache with known token pairs and their contract addresses.
     *
     * Useful for performance optimization when an application already knows
     * common pairs from a token list or local storage. Pre-loaded entries
     * are given a fresh TTL from the moment of insertion.
     *
     * @param pairs - Array of token pairs `[tokenA, tokenB, pairAddress]`.
     */
    preLoadPairs(pairs: Array<[string, string, string]>): void {
        for (const [a, b, addr] of pairs) {
            const [t0, t1] = sortTokens(a, b);
            this.cache.set(`${t0}:${t1}`, {
                address: addr,
                expiresAt: Date.now() + this.cacheTtlMs,
            });
        }
    }

    /**
     * Clear all cached pair addresses.
     *
     * Equivalent to `invalidateCache()` with no argument. Retained for
     * backward compatibility (called by `CoralSwapClient.setNetwork()`).
     */
    clearCache(): void {
        this.cache.clear();
    }
}
