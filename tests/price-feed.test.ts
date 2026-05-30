import { PriceFeedModule, SupportedAsset, PriceFeed } from '../src/modules/price-feed';
import { CoralSwapClient } from '../src/client';
import { ValidationError } from '../src/errors';
import { TransactionBuilder } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

function createMockClient(): CoralSwapClient {
  return {} as unknown as CoralSwapClient;
}

const MOCK_PAYLOAD = Buffer.from('redstone-attestation-payload', 'utf8');

function mockFeedResponse(value: number, timestamp: number, signature = 'cGF5bG9hZA==') {
  return JSON.stringify([{ value, timestamp: timestamp * 1000, signature }]);
}

function stubFetch(responseBody: string, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(responseBody)),
  } as unknown as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PriceFeedModule', () => {
  const NOW_SEC = Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------------------
  // getPrice()
  // -------------------------------------------------------------------------
  describe('getPrice()', () => {
    it('returns price, timestamp, and payload for a fresh feed', async () => {
      stubFetch(mockFeedResponse(0.12, NOW_SEC));
      const module = new PriceFeedModule(createMockClient());

      const feed = await module.getPrice(SupportedAsset.XLM);

      expect(feed.price).toBe(0.12);
      expect(feed.timestamp).toBe(NOW_SEC);
      expect(feed.payload).toBeInstanceOf(Buffer);
    });

    it('returns price for every SupportedAsset without throwing', async () => {
      const assets = Object.values(SupportedAsset);
      for (const asset of assets) {
        stubFetch(mockFeedResponse(1.0, NOW_SEC));
        const module = new PriceFeedModule(createMockClient());
        const feed = await module.getPrice(asset as SupportedAsset);
        expect(typeof feed.price).toBe('number');
      }
    });

    it('throws ValidationError when API returns non-200', async () => {
      stubFetch('{"error":"not found"}', 404);
      const module = new PriceFeedModule(createMockClient());

      await expect(module.getPrice(SupportedAsset.BTC)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when response shape is unexpected', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ unexpected: 'format' }),
      } as unknown as Response);
      const module = new PriceFeedModule(createMockClient());

      await expect(module.getPrice(SupportedAsset.ETH)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when fetch throws a network error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      const module = new PriceFeedModule(createMockClient());

      await expect(module.getPrice(SupportedAsset.USDC)).rejects.toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // isPriceStale()
  // -------------------------------------------------------------------------
  describe('isPriceStale()', () => {
    it('returns false when feed is within the default 180s threshold', async () => {
      const recentTimestamp = NOW_SEC - 60;
      stubFetch(mockFeedResponse(1.0, recentTimestamp));
      const module = new PriceFeedModule(createMockClient());

      const stale = await module.isPriceStale(SupportedAsset.USDC);

      expect(stale).toBe(false);
    });

    it('returns true when feed is older than the default 180s threshold', async () => {
      const oldTimestamp = NOW_SEC - 300;
      stubFetch(mockFeedResponse(1.0, oldTimestamp));
      const module = new PriceFeedModule(createMockClient());

      const stale = await module.isPriceStale(SupportedAsset.USDC);

      expect(stale).toBe(true);
    });

    it('respects a custom maxAgeSeconds parameter', async () => {
      const timestampSec = NOW_SEC - 45;
      stubFetch(mockFeedResponse(1.0, timestampSec));
      const module = new PriceFeedModule(createMockClient());

      const staleWithStrict = await module.isPriceStale(SupportedAsset.XLM, 30);

      expect(staleWithStrict).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // attachPricePayload()
  // -------------------------------------------------------------------------
  describe('attachPricePayload()', () => {
    function createMockBuilder(): TransactionBuilder {
      return {
        addMemo: jest.fn().mockReturnThis(),
      } as unknown as TransactionBuilder;
    }

    it('returns the same builder instance (fluent API)', () => {
      const module = new PriceFeedModule(createMockClient());
      const builder = createMockBuilder();
      const feed: PriceFeed = { price: 1.0, timestamp: NOW_SEC, payload: MOCK_PAYLOAD };

      const result = module.attachPricePayload(builder, feed);

      expect(result).toBe(builder);
    });

    it('calls addMemo on the builder with a hash slice', () => {
      const module = new PriceFeedModule(createMockClient());
      const builder = createMockBuilder();
      const feed: PriceFeed = { price: 1.0, timestamp: NOW_SEC, payload: MOCK_PAYLOAD };

      module.attachPricePayload(builder, feed);

      expect((builder as any).addMemo).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'hash' }),
      );
    });

    it('throws ValidationError when payload is empty', () => {
      const module = new PriceFeedModule(createMockClient());
      const builder = createMockBuilder();
      const feed: PriceFeed = { price: 1.0, timestamp: NOW_SEC, payload: Buffer.alloc(0) };

      expect(() => module.attachPricePayload(builder, feed)).toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // SupportedAsset enum
  // -------------------------------------------------------------------------
  describe('SupportedAsset', () => {
    it('covers exactly 17 assets', () => {
      expect(Object.keys(SupportedAsset)).toHaveLength(17);
    });

    it('includes core assets: USDC, XLM, BTC, ETH', () => {
      expect(SupportedAsset.USDC).toBe('USDC');
      expect(SupportedAsset.XLM).toBe('XLM');
      expect(SupportedAsset.BTC).toBe('BTC');
      expect(SupportedAsset.ETH).toBe('ETH');
    });
  });
});
