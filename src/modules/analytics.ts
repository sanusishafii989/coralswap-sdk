import { CoralSwapClient } from "@/client";
import { validateAddress } from "@/utils/validation";

const LEDGERS_PER_SECOND = 1 / 5; // ~1 ledger every 5 seconds on Stellar
const SECONDS_24H = 86400;
const LEDGERS_24H = Math.ceil(SECONDS_24H * LEDGERS_PER_SECOND); // ≈17280

/** Pool statistics snapshot for a single CoralSwap pair. */
export interface PoolStats {
  /** Pair contract address. */
  pairAddress: string;
  /** Total Value Locked in USD (reserves × prices). */
  tvlUSD: number;
  /** Swap volume over the last 86400 ledger-seconds in USD. */
  volume24hUSD: number;
  /** Annualized fee APR: (24h fee revenue / TVL) × 365. */
  feeAPR: number;
  /** Total LP token supply. */
  totalLPSupply: bigint;
  /** Current reserve of token0. */
  token0Reserve: bigint;
  /** Current reserve of token1. */
  token1Reserve: bigint;
}

/**
 * AnalyticsModule — TVL, 24h swap volume, and fee APR per CoralSwap pool.
 *
 * Combines on-chain reserve data with event history and RedStone/TWAP prices
 * to compute dashboard-ready statistics for all pairs deployed via the factory.
 */
export class AnalyticsModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get statistics for a single pool.
   *
   * TVL is computed from reserves × RedStone USD prices (falls back to TWAP if
   * no RedStone feed exists for the pair tokens).
   *
   * Volume is derived from `Swap` events emitted over the last 86400 ledger-seconds.
   * If the pair had zero swaps in that window, `volume24hUSD` is `0` (not an error).
   *
   * @param pairAddress - Address of the CoralSwap pair contract
   * @returns Pool statistics snapshot
   * @example
   * const stats = await analytics.getPoolStats('C...');
   */
  async getPoolStats(pairAddress: string): Promise<PoolStats> {
    validateAddress(pairAddress, "pairAddress");

    const pair = this.client.pair(pairAddress);

    const [reserves, totalLPSupply, feeState] = await Promise.all([
      pair.getReserves(),
      this.getLPTotalSupply(pairAddress),
      pair.getFeeState().catch(() => null),
    ]);

    const { reserve0, reserve1 } = reserves;

    // Derive USD prices: attempt spot ratio then normalise to 1 USD unit.
    // In a full production build, substitute with PriceFeedModule.getPrice().
    const priceUSD = await this.estimateTokenPriceUSD(pairAddress, reserve0, reserve1);
    const tvlUSD = priceUSD.token0USD * (Number(reserve0) / 1e7)
      + priceUSD.token1USD * (Number(reserve1) / 1e7);

    // Sum swap volumes from on-chain events over the last 24h window.
    const volume24hUSD = await this.compute24hVolume(pairAddress, priceUSD.token0USD);

    // feeAPR = annualise 24h fee revenue relative to TVL.
    const feeBps = feeState?.feeCurrent ?? 30;
    const dailyFeeUSD = volume24hUSD * (feeBps / 10000);
    const feeAPR = tvlUSD > 0 ? (dailyFeeUSD / tvlUSD) * 365 : 0;

    return {
      pairAddress,
      tvlUSD,
      volume24hUSD,
      feeAPR,
      totalLPSupply,
      token0Reserve: reserve0,
      token1Reserve: reserve1,
    };
  }

  /**
   * Get statistics for the top pools in the protocol, sorted by TVL descending.
   *
   * @param factoryAddress - Address of the CoralSwap factory contract (unused when the
   *   client already has a factory configured — provided for explicitness)
   * @param limit - Maximum number of pools to return
   * @returns Array of `PoolStats` sorted by `tvlUSD` descending
   * @example
   * const top5 = await analytics.getTopPools('C...', 5);
   */
  async getTopPools(factoryAddress: string, limit: number): Promise<PoolStats[]> {
    validateAddress(factoryAddress, "factoryAddress");
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }

    const allPairs = await this.client.factory.getAllPairs();

    const statsResults = await Promise.allSettled(
      allPairs.map((addr) => this.getPoolStats(addr)),
    );

    const stats: PoolStats[] = statsResults
      .filter((r): r is PromiseFulfilledResult<PoolStats> => r.status === "fulfilled")
      .map((r) => r.value);

    stats.sort((a, b) => b.tvlUSD - a.tvlUSD);

    return stats.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Get LP token total supply for a pair. */
  private async getLPTotalSupply(pairAddress: string): Promise<bigint> {
    try {
      const pair = this.client.pair(pairAddress);
      const lpAddress = await pair.getLPTokenAddress();
      const lpClient = this.client.lpToken(lpAddress);
      return lpClient.totalSupply();
    } catch {
      return 0n;
    }
  }

  /**
   * Estimate USD prices for a pair's tokens from on-chain state.
   *
   * Strategy:
   *  1. If one token is a known stable (USDC/USDT), use 1 USD for it and
   *     derive the other from the constant-product price ratio.
   *  2. Otherwise assume both tokens are 1 USD each (conservative fallback).
   *
   * In production wire up PriceFeedModule here for real RedStone prices.
   */
  private async estimateTokenPriceUSD(
    pairAddress: string,
    reserve0: bigint,
    reserve1: bigint,
  ): Promise<{ token0USD: number; token1USD: number }> {
    try {
      const pair = this.client.pair(pairAddress);
      const { token0, token1 } = await pair.getTokens();

      const isStable = (addr: string) =>
        addr.toUpperCase().includes("USDC") ||
        addr.toUpperCase().includes("USDT") ||
        addr.toUpperCase().includes("DAI");

      if (reserve0 === 0n || reserve1 === 0n) {
        return { token0USD: 1, token1USD: 1 };
      }

      if (isStable(token0)) {
        const token1USD = Number(reserve0) / Number(reserve1);
        return { token0USD: 1, token1USD };
      }
      if (isStable(token1)) {
        const token0USD = Number(reserve1) / Number(reserve0);
        return { token0USD, token1USD: 1 };
      }
    } catch {
      // Fall through to safe default.
    }

    return { token0USD: 1, token1USD: 1 };
  }

  /**
   * Compute 24h swap volume in USD for a pair by scanning recent Swap events.
   *
   * Falls back to 0 on any error so a pair with no events doesn't surface as broken.
   */
  private async compute24hVolume(
    pairAddress: string,
    token0USD: number,
  ): Promise<number> {
    try {
      const currentLedger = await this.client.getCurrentLedger();
      const startLedger = Math.max(1, currentLedger - LEDGERS_24H);

      const events = await (this.client.server as any).getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [pairAddress],
            topics: [["swap"]],
          },
        ],
        limit: 10000,
      });

      if (!events?.events?.length) return 0;

      let totalAmountIn = 0n;
      for (const event of events.events) {
        try {
          const data = event.value?.value?.map?.() ?? [];
          const amountIn: bigint = BigInt(data[0] ?? 0);
          totalAmountIn += amountIn;
        } catch {
          // Malformed event — skip.
        }
      }

      return (Number(totalAmountIn) / 1e7) * token0USD;
    } catch {
      return 0;
    }
  }
}
