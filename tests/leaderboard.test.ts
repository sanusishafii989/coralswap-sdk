import { CoralSwapClient } from "../src/client";
import { LeaderboardModule } from "../src/modules/leaderboard";
import { Network } from "../src/types/common";
import { ValidationError } from "../src/errors";
import { SorobanRpc } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";
const PAIR_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAIR_B = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const USER_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USER_2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USER_3 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";

// ---------------------------------------------------------------------------
// Raw event builder helpers
// ---------------------------------------------------------------------------

function makeRawSwapEvent(opts: {
  contractId: string;
  sender: string;
  amountIn: bigint;
  ledger: number;
}): Record<string, unknown> {
  const makeAddr = (addr: string) => ({
    address: () => ({ toString: () => addr }),
  });

  const makeI128 = (n: bigint) => ({
    i128: () => ({
      hi: () => ({ toString: () => String(n >> 64n) }),
      lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
    }),
  });

  const makeSym = (s: string) => ({
    sym: () => ({ toString: () => s }),
  });

  const mapEntries = [
    { key: makeSym("sender"), val: makeAddr(opts.sender) },
    { key: makeSym("amount_in"), val: makeI128(opts.amountIn) },
    { key: makeSym("token_in"), val: makeAddr("TOKEN_X") },
    { key: makeSym("token_out"), val: makeAddr("TOKEN_Y") },
    { key: makeSym("amount_out"), val: makeI128(opts.amountIn) },
    { key: makeSym("fee_bps"), val: { u32: () => 30 } },
  ];

  return {
    topic: ["swap"],
    value: { map: () => mapEntries },
    contractId: opts.contractId,
    ledger: opts.ledger,
  };
}

function makeRawAddLiquidityEvent(opts: {
  contractId: string;
  provider: string;
  liquidity: bigint;
  ledger: number;
}): Record<string, unknown> {
  const makeAddr = (addr: string) => ({
    address: () => ({ toString: () => addr }),
  });

  const makeI128 = (n: bigint) => ({
    i128: () => ({
      hi: () => ({ toString: () => String(n >> 64n) }),
      lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
    }),
  });

  const makeSym = (s: string) => ({
    sym: () => ({ toString: () => s }),
  });

  const mapEntries = [
    { key: makeSym("provider"), val: makeAddr(opts.provider) },
    { key: makeSym("liquidity"), val: makeI128(opts.liquidity) },
    { key: makeSym("token_a"), val: makeAddr("TOKEN_X") },
    { key: makeSym("token_b"), val: makeAddr("TOKEN_Y") },
    { key: makeSym("amount_a"), val: makeI128(100n) },
    { key: makeSym("amount_b"), val: makeI128(200n) },
  ];

  return {
    topic: ["add_liquidity"],
    value: { map: () => mapEntries },
    contractId: opts.contractId,
    ledger: opts.ledger,
  };
}

function makeEventsResponse(
  events: Record<string, unknown>[],
): SorobanRpc.Api.GetEventsResponse {
  return {
    events: events as unknown as SorobanRpc.Api.EventResponse[],
    latestLedger: 2000,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("LeaderboardModule.getLeaderboard()", () => {
  let client: CoralSwapClient;
  let leaderboard: LeaderboardModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    leaderboard = new LeaderboardModule(client);

    // Default current ledger: 50000
    jest.spyOn(client, "getCurrentLedger").mockResolvedValue(50000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Validation & Options Check", () => {
    it("throws ValidationError for invalid type", async () => {
      await expect(
        leaderboard.getLeaderboard("invalid-type" as any),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for invalid period", async () => {
      await expect(
        leaderboard.getLeaderboard("trader", { period: "invalid-period" as any }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for invalid pairAddress", async () => {
      await expect(
        leaderboard.getLeaderboard("trader", { period: "24h", pairAddress: "invalid-addr" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("Trader Leaderboard", () => {
    it("returns correctly sorted and ranked trader entries", async () => {
      // 50000 is current ledger.
      // 24h period is 17280 ledgers.
      // Current range is [32720, 50000].
      // Previous range is [15440, 32720].
      const events = [
        // Current period swaps
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1000n, ledger: 40000 }),
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_2, amountIn: 5000n, ledger: 41000 }),
        makeRawSwapEvent({ contractId: PAIR_B, sender: USER_1, amountIn: 2000n, ledger: 42000 }),
        // Previous period swaps for USER_1 (to calculate change24h)
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1500n, ledger: 20000 }),
      ];

      jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("trader", { period: "24h" });

      expect(result).toHaveLength(2);

      // USER_2 has 5000n current volume, prev volume is 0
      expect(result[0].address).toBe(USER_2);
      expect(result[0].metricValue).toBe(5000n);
      expect(result[0].rank).toBe(1);
      expect(result[0].change24h).toBe(100);

      // USER_1 has 3000n current volume, prev volume is 1500n -> +100% change
      expect(result[1].address).toBe(USER_1);
      expect(result[1].metricValue).toBe(3000n);
      expect(result[1].rank).toBe(2);
      expect(result[1].change24h).toBe(100);
    });

    it("filters by pairAddress option", async () => {
      const events = [
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1000n, ledger: 40000 }),
        makeRawSwapEvent({ contractId: PAIR_B, sender: USER_2, amountIn: 5000n, ledger: 41000 }),
      ];

      const spy = jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("trader", {
        period: "24h",
        pairAddress: PAIR_A,
      });

      // Verification that pairAddress is passed to getEvents query filter
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [
            expect.objectContaining({
              contractIds: [PAIR_A],
            }),
          ],
        }),
      );

      // Only USER_1 (Pair A swap) should be aggregated
      expect(result).toHaveLength(1);
      expect(result[0].address).toBe(USER_1);
      expect(result[0].metricValue).toBe(1000n);
    });

    it("respects limit option", async () => {
      const events = [
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_1, amountIn: 1000n, ledger: 40000 }),
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_2, amountIn: 5000n, ledger: 41000 }),
        makeRawSwapEvent({ contractId: PAIR_A, sender: USER_3, amountIn: 3000n, ledger: 42000 }),
      ];

      jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("trader", {
        period: "24h",
        limit: 2,
      });

      expect(result).toHaveLength(2);
      expect(result[0].address).toBe(USER_2); // rank 1
      expect(result[1].address).toBe(USER_3); // rank 2
    });
  });

  describe("LP Leaderboard", () => {
    it("returns correctly sorted and ranked LP entries", async () => {
      // 50000 is current ledger.
      // 24h period is 17280 ledgers.
      // Current range is [32720, 50000].
      // Previous range is [15440, 32720].
      const events = [
        // Current period liquidity additions
        makeRawAddLiquidityEvent({ contractId: PAIR_A, provider: USER_1, liquidity: 1000n, ledger: 40000 }),
        makeRawAddLiquidityEvent({ contractId: PAIR_A, provider: USER_2, liquidity: 5000n, ledger: 41000 }),
        makeRawAddLiquidityEvent({ contractId: PAIR_B, provider: USER_1, liquidity: 2000n, ledger: 42000 }),
        // Previous period liquidity additions for USER_1 (to calculate change24h)
        makeRawAddLiquidityEvent({ contractId: PAIR_A, provider: USER_1, liquidity: 4000n, ledger: 20000 }),
      ];

      jest
        .spyOn(client.server, "getEvents")
        .mockResolvedValue(makeEventsResponse(events));

      const result = await leaderboard.getLeaderboard("lp", { period: "24h" });

      expect(result).toHaveLength(2);

      // USER_2 has 5000n current yield, prev yield is 0
      expect(result[0].address).toBe(USER_2);
      expect(result[0].metricValue).toBe(5000n);
      expect(result[0].rank).toBe(1);
      expect(result[0].change24h).toBe(100);

      // USER_1 has 3000n current yield, prev yield is 4000n -> -25% change
      expect(result[1].address).toBe(USER_1);
      expect(result[1].metricValue).toBe(3000n);
      expect(result[1].rank).toBe(2);
      expect(result[1].change24h).toBe(-25);
    });
  });
});
