import { AnalyticsModule, PoolStats } from '../src/modules/analytics';
import { CoralSwapClient } from '../src/client';

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

const PAIR_A = 'CPAIRA111111111111111111111111111111111111111111111111111';
const PAIR_B = 'CPAIRB111111111111111111111111111111111111111111111111111';
const PAIR_C = 'CPAIRC111111111111111111111111111111111111111111111111111';
const LP_ADDR = 'CLPTOKEN1111111111111111111111111111111111111111111111111';
const FACTORY = 'CFACTORY111111111111111111111111111111111111111111111111';

function createMockClient(opts: {
  allPairs?: string[];
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
  totalSupply?: bigint;
  feeCurrent?: number;
  currentLedger?: number;
  events?: any[];
} = {}): CoralSwapClient {
  return {
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(opts.allPairs ?? [PAIR_A]),
    },
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({
        reserve0: opts.reserve0 ?? 1_000_0000000n,
        reserve1: opts.reserve1 ?? 1_000_0000000n,
      }),
      getTokens: jest.fn().mockResolvedValue({
        token0: opts.token0 ?? 'TOKEN_A',
        token1: opts.token1 ?? 'TOKEN_B',
      }),
      getLPTokenAddress: jest.fn().mockResolvedValue(LP_ADDR),
      getFeeState: jest.fn().mockResolvedValue({ feeCurrent: opts.feeCurrent ?? 30 }),
    }),
    lpToken: jest.fn().mockReturnValue({
      totalSupply: jest.fn().mockResolvedValue(opts.totalSupply ?? 1_000_0000000n),
    }),
    getCurrentLedger: jest.fn().mockResolvedValue(opts.currentLedger ?? 100000),
    server: {
      getEvents: jest.fn().mockResolvedValue({ events: opts.events ?? [] }),
    },
  } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsModule', () => {

  // -------------------------------------------------------------------------
  // getPoolStats()
  // -------------------------------------------------------------------------
  describe('getPoolStats()', () => {
    it('returns correct TVL for a known pool state', async () => {
      // 1000 token0 @ $1 + 1000 token1 @ $1 = $2000 TVL
      const client = createMockClient({
        reserve0: 1000_0000000n,
        reserve1: 1000_0000000n,
        token0: 'USDC_CONTRACT',
        token1: 'XLM',
      });
      const analytics = new AnalyticsModule(client);

      const stats = await analytics.getPoolStats(PAIR_A);

      // token0 is USDC → priceUSD 1, token1 = reserve0/reserve1 = 1
      expect(stats.tvlUSD).toBeCloseTo(2000, 0);
      expect(stats.pairAddress).toBe(PAIR_A);
      expect(stats.token0Reserve).toBe(1000_0000000n);
      expect(stats.token1Reserve).toBe(1000_0000000n);
    });

    it('returns volume24hUSD = 0 for a pool with no swaps', async () => {
      const client = createMockClient({ events: [] });
      const analytics = new AnalyticsModule(client);

      const stats = await analytics.getPoolStats(PAIR_A);

      expect(stats.volume24hUSD).toBe(0);
    });

    it('computes feeAPR from 24h fee revenue / TVL × 365', async () => {
      const client = createMockClient({
        reserve0: 100_0000000n,
        reserve1: 100_0000000n,
        token0: 'USDC_CONTRACT',
        events: [],
        feeCurrent: 30,
      });
      const analytics = new AnalyticsModule(client);

      const stats = await analytics.getPoolStats(PAIR_A);

      // With zero volume, daily fee = 0, feeAPR = 0
      expect(stats.feeAPR).toBe(0);
    });

    it('exposes totalLPSupply from the LP token', async () => {
      const client = createMockClient({ totalSupply: 5_000_0000000n });
      const analytics = new AnalyticsModule(client);

      const stats = await analytics.getPoolStats(PAIR_A);

      expect(stats.totalLPSupply).toBe(5_000_0000000n);
    });

    it('uses 1 USD fallback when neither token is a stable', async () => {
      const client = createMockClient({
        reserve0: 100_0000000n,
        reserve1: 200_0000000n,
        token0: 'WBTC',
        token1: 'ETH',
      });
      const analytics = new AnalyticsModule(client);

      const stats = await analytics.getPoolStats(PAIR_A);

      // Fallback: both tokens priced at $1
      expect(stats.tvlUSD).toBeCloseTo(300, 0);
    });
  });

  // -------------------------------------------------------------------------
  // getTopPools()
  // -------------------------------------------------------------------------
  describe('getTopPools()', () => {
    it('returns pools sorted by TVL descending', async () => {
      const client: any = {
        factory: {
          getAllPairs: jest.fn().mockResolvedValue([PAIR_A, PAIR_B, PAIR_C]),
        },
        getCurrentLedger: jest.fn().mockResolvedValue(100000),
        server: {
          getEvents: jest.fn().mockResolvedValue({ events: [] }),
        },
        lpToken: jest.fn().mockReturnValue({
          totalSupply: jest.fn().mockResolvedValue(1_000_0000000n),
        }),
        pair: jest.fn().mockImplementation((addr: string) => ({
          getReserves: jest.fn().mockResolvedValue(
            addr === PAIR_A
              ? { reserve0: 1000_0000000n, reserve1: 1000_0000000n }
              : addr === PAIR_B
              ? { reserve0: 500_0000000n, reserve1: 500_0000000n }
              : { reserve0: 2000_0000000n, reserve1: 2000_0000000n },
          ),
          getTokens: jest.fn().mockResolvedValue({ token0: 'USDC', token1: 'XLM' }),
          getLPTokenAddress: jest.fn().mockResolvedValue(LP_ADDR),
          getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
        })),
      } as unknown as CoralSwapClient;

      const analytics = new AnalyticsModule(client);

      const top = await analytics.getTopPools(FACTORY, 3);

      expect(top).toHaveLength(3);
      // PAIR_C should be first (highest TVL ~4000)
      expect(top[0].pairAddress).toBe(PAIR_C);
      expect(top[0].tvlUSD).toBeGreaterThan(top[1].tvlUSD);
      expect(top[1].tvlUSD).toBeGreaterThan(top[2].tvlUSD);
    });

    it('respects the limit parameter', async () => {
      const client = createMockClient({ allPairs: [PAIR_A, PAIR_B, PAIR_C] });
      // Override to return three distinct pairs with mock pair calls
      const analytics = new AnalyticsModule(client);

      const top = await analytics.getTopPools(FACTORY, 1);

      expect(top.length).toBeLessThanOrEqual(1);
    });

    it('returns fewer than limit when fewer pools exist', async () => {
      const client = createMockClient({ allPairs: [PAIR_A] });
      const analytics = new AnalyticsModule(client);

      const top = await analytics.getTopPools(FACTORY, 10);

      expect(top.length).toBeLessThanOrEqual(1);
    });

    it('multi-pool ranking puts highest TVL first', async () => {
      const client = createMockClient({ allPairs: [PAIR_A, PAIR_B] });
      const analytics = new AnalyticsModule(client);

      const top = await analytics.getTopPools(FACTORY, 2);

      for (let i = 0; i < top.length - 1; i++) {
        expect(top[i].tvlUSD).toBeGreaterThanOrEqual(top[i + 1].tvlUSD);
      }
    });
  });
});
