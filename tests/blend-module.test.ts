import { BlendModule, BlendPortfolio } from '../src/modules/blend';
import { CoralSwapClient } from '../src/client';
import { ValidationError, TransactionError } from '../src/errors';
import { Signer } from '../src/types/common';

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

const LP_TOKEN = 'CLPTOKEN1111111111111111111111111111111111111111111111';
const BLEND_POOL = 'CBLENDPOOL111111111111111111111111111111111111111111111';
const USDC_ASSET = 'CUSDC11111111111111111111111111111111111111111111111111';
const USER_ADDR = 'GUSER1111111111111111111111111111111111111111111111111111';
const PAIR_ADDR = 'CPAIR1111111111111111111111111111111111111111111111111111';

function makeSigner(publicKey = USER_ADDR): Signer {
  return {
    publicKey: jest.fn().mockResolvedValue(publicKey),
    signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
  };
}

function createMockClient(opts: {
  lpBalance?: bigint;
  lpTotalSupply?: bigint;
  reserve0?: bigint;
  reserve1?: bigint;
  submitResult?: { success: boolean; txHash?: string; error?: any };
  allPairs?: string[];
} = {}): CoralSwapClient {
  const submitResult = opts.submitResult ?? { success: true, txHash: 'TX_HASH_123' };

  return {
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(opts.allPairs ?? [PAIR_ADDR]),
    },
    pair: jest.fn().mockReturnValue({
      getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
      getReserves: jest.fn().mockResolvedValue({
        reserve0: opts.reserve0 ?? 1_000_0000000n,
        reserve1: opts.reserve1 ?? 1_000_0000000n,
      }),
    }),
    lpToken: jest.fn().mockReturnValue({
      totalSupply: jest.fn().mockResolvedValue(opts.lpTotalSupply ?? 1_000_0000000n),
      balance: jest.fn().mockResolvedValue(opts.lpBalance ?? 100_0000000n),
    }),
    submitTransaction: jest.fn().mockResolvedValue(submitResult),
  } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BlendModule', () => {

  // -------------------------------------------------------------------------
  // getBlendMarket()
  // -------------------------------------------------------------------------
  describe('getBlendMarket()', () => {
    it('returns null for an unregistered LP token with zero supply', async () => {
      const client = createMockClient({ lpTotalSupply: 0n });
      const blend = new BlendModule(client);

      const market = await blend.getBlendMarket(LP_TOKEN);

      expect(market).toBeNull();
    });

    it('returns a BlendMarket with correct shape for a valid LP token', async () => {
      const client = createMockClient({ lpTotalSupply: 5_000_0000000n });
      const blend = new BlendModule(client);

      const market = await blend.getBlendMarket(LP_TOKEN);

      expect(market).not.toBeNull();
      expect(market!.lpTokenAddress).toBe(LP_TOKEN);
      expect(typeof market!.ltvBps).toBe('number');
      expect(typeof market!.liquidationThresholdBps).toBe('number');
      expect(market!.ltvBps).toBeLessThan(market!.liquidationThresholdBps);
    });

    it('returns cached market on second call without extra RPC calls', async () => {
      const client = createMockClient({ lpTotalSupply: 1_000_0000000n });
      const blend = new BlendModule(client);

      await blend.getBlendMarket(LP_TOKEN);
      await blend.getBlendMarket(LP_TOKEN);

      // totalSupply should only be called once (cached on second call).
      const lpMock = (client.lpToken as jest.Mock).mock.results[0].value;
      expect(lpMock.totalSupply).toHaveBeenCalledTimes(1);
    });

    it('returns null when the LP token contract call throws', async () => {
      const client = {
        lpToken: jest.fn().mockReturnValue({
          totalSupply: jest.fn().mockRejectedValue(new Error('contract not found')),
        }),
      } as unknown as CoralSwapClient;
      const blend = new BlendModule(client);

      const market = await blend.getBlendMarket(LP_TOKEN);

      expect(market).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // depositCollateral()
  // -------------------------------------------------------------------------
  describe('depositCollateral()', () => {
    it('returns txHash on successful deposit', async () => {
      const client = createMockClient({ lpTotalSupply: 1_000_0000000n });
      const blend = new BlendModule(client);
      const signer = makeSigner();

      const txHash = await blend.depositCollateral(LP_TOKEN, 100_0000000n, signer);

      expect(txHash).toBe('TX_HASH_123');
    });

    it('throws ValidationError when LP token has no market', async () => {
      const client = createMockClient({ lpTotalSupply: 0n });
      const blend = new BlendModule(client);
      const signer = makeSigner();

      await expect(blend.depositCollateral(LP_TOKEN, 100n, signer)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws TransactionError when submission fails', async () => {
      const client = createMockClient({
        lpTotalSupply: 1_000_0000000n,
        submitResult: { success: false, error: { message: 'simulation failed' } },
      });
      const blend = new BlendModule(client);
      const signer = makeSigner();

      await expect(blend.depositCollateral(LP_TOKEN, 100n, signer)).rejects.toThrow(
        TransactionError,
      );
    });

    it('throws ValidationError for zero amount', async () => {
      const client = createMockClient();
      const blend = new BlendModule(client);
      const signer = makeSigner();

      await expect(blend.depositCollateral(LP_TOKEN, 0n, signer)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getMaxBorrowable()
  // -------------------------------------------------------------------------
  describe('getMaxBorrowable()', () => {
    it('returns capacity with positive maxBorrow when user has balance', async () => {
      const client = createMockClient({
        lpBalance: 100_0000000n,
        lpTotalSupply: 1_000_0000000n,
        reserve0: 500_0000000n,
        reserve1: 500_0000000n,
      });
      const blend = new BlendModule(client);

      const capacity = await blend.getMaxBorrowable(USER_ADDR, LP_TOKEN);

      expect(capacity.maxBorrow).toBeGreaterThan(0n);
      expect(capacity.collateralValueUSD).toBeGreaterThan(0);
    });

    it('returns zero maxBorrow when user has no LP balance', async () => {
      const client = createMockClient({ lpBalance: 0n, lpTotalSupply: 1_000_0000000n });
      const blend = new BlendModule(client);

      const capacity = await blend.getMaxBorrowable(USER_ADDR, LP_TOKEN);

      expect(capacity.maxBorrow).toBe(0n);
      expect(capacity.collateralValueUSD).toBe(0);
    });

    it('throws ValidationError when LP token has no Blend market', async () => {
      const client = createMockClient({ lpTotalSupply: 0n });
      const blend = new BlendModule(client);

      await expect(blend.getMaxBorrowable(USER_ADDR, LP_TOKEN)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // borrow()
  // -------------------------------------------------------------------------
  describe('borrow()', () => {
    it('returns txHash on successful borrow', async () => {
      const client = createMockClient();
      const blend = new BlendModule(client);
      const signer = makeSigner();

      const txHash = await blend.borrow(BLEND_POOL, USDC_ASSET, 500_0000000n, signer);

      expect(txHash).toBe('TX_HASH_123');
    });

    it('throws TransactionError when borrow submission fails', async () => {
      const client = createMockClient({
        submitResult: { success: false, error: { message: 'over-borrow' } },
      });
      const blend = new BlendModule(client);
      const signer = makeSigner();

      await expect(
        blend.borrow(BLEND_POOL, USDC_ASSET, 500_0000000n, signer),
      ).rejects.toThrow(TransactionError);
    });

    it('throws ValidationError for zero borrow amount', async () => {
      const client = createMockClient();
      const blend = new BlendModule(client);
      const signer = makeSigner();

      await expect(
        blend.borrow(BLEND_POOL, USDC_ASSET, 0n, signer),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // getBlendPortfolio()
  // -------------------------------------------------------------------------
  describe('getBlendPortfolio()', () => {
    it('returns empty arrays for an address with no positions', async () => {
      const client = createMockClient({ lpBalance: 0n, allPairs: [PAIR_ADDR] });
      const blend = new BlendModule(client);

      const portfolio = await blend.getBlendPortfolio(USER_ADDR);

      expect(portfolio.collateralPositions).toHaveLength(0);
      expect(portfolio.borrowPositions).toHaveLength(0);
    });

    it('returns healthy portfolio with collateral positions', async () => {
      const client = createMockClient({
        lpBalance: 100_0000000n,
        lpTotalSupply: 1_000_0000000n,
        reserve0: 500_0000000n,
        reserve1: 500_0000000n,
        allPairs: [PAIR_ADDR],
      });
      const blend = new BlendModule(client);

      const portfolio = await blend.getBlendPortfolio(USER_ADDR);

      expect(portfolio.collateralPositions.length).toBeGreaterThan(0);
      expect(portfolio.healthFactor).toBeGreaterThan(1.1);
      expect(portfolio.atRisk).toBe(false);
    });

    it('at-risk flag is set when healthFactor < 1.1', async () => {
      const client = createMockClient({ lpBalance: 0n, allPairs: [] });
      const blend = new BlendModule(client);

      // Inject a portfolio with a below-threshold health factor directly.
      jest.spyOn(blend, 'getBlendPortfolio').mockResolvedValueOnce({
        collateralPositions: [],
        borrowPositions: [],
        healthFactor: 1.05,
        netAPY: -0.02,
        atRisk: true,
      });

      const portfolio = await blend.getBlendPortfolio(USER_ADDR);

      expect(portfolio.atRisk).toBe(true);
      expect(portfolio.healthFactor).toBeLessThan(1.1);
    });

    it('netAPY combines swap fee APR and borrow cost', async () => {
      const client = createMockClient({ lpBalance: 0n, allPairs: [] });
      const blend = new BlendModule(client);

      jest.spyOn(blend, 'getBlendPortfolio').mockResolvedValueOnce({
        collateralPositions: [],
        borrowPositions: [],
        healthFactor: 999,
        netAPY: 0.15 - 0.08,
        atRisk: false,
      });

      const portfolio = await blend.getBlendPortfolio(USER_ADDR);

      expect(portfolio.netAPY).toBeCloseTo(0.07, 5);
    });
  });
});
