import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';
import { MockProvider } from '../src/test/mocks/MockProvider';
import { xdr, Address, SorobanRpc } from '@stellar/stellar-sdk';

// Mock Contract to bypass address validation
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        Contract: jest.fn().mockImplementation((address) => ({
            address,
            call: jest.fn(),
            toString: jest.fn().mockReturnValue(address),
        })),
    };
});

describe('FactoryModule Caching', () => {
    const TOKEN_A = 'CAS3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
    const TOKEN_B = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const PAIR_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

    let client: CoralSwapClient;

    beforeEach(() => {
        client = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
            // Provide a dummy factory address to avoid "Factory address not configured" error
            // using a valid-looking Soroban contract ID
            rpcUrl: 'https://soroban-testnet.stellar.org',
        });
        // Inject factoryAddress directly into networkConfig for testing
        (client as any).networkConfig.factoryAddress = 'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
    });

    it('caches getPairAddress results', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();

        // First call - should hit the contract
        const addr1 = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr1).toBe(PAIR_ADDR);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Second call - should hit the cache
        const addr2 = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr2).toBe(PAIR_ADDR);
        expect(mockGetPair).toHaveBeenCalledTimes(1);
    });

    it('bypasses cache when requested', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Bypassing cache
        await module.getPairAddress(TOKEN_A, TOKEN_B, { bypassCache: true });
        expect(mockGetPair).toHaveBeenCalledTimes(2);
    });

    it('uses deterministic sorting for cache keys', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();

        // Call with (A, B)
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Call with (B, A) - should hit the same cache entry
        await module.getPairAddress(TOKEN_B, TOKEN_A);
        expect(mockGetPair).toHaveBeenCalledTimes(1);
    });

    it('supports pre-loading pairs', async () => {
        const mockGetPair = jest.fn();
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();
        module.preLoadPairs([[TOKEN_A, TOKEN_B, PAIR_ADDR]]);

        const addr = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr).toBe(PAIR_ADDR);
        expect(mockGetPair).not.toHaveBeenCalled();
    });

    it('clears cache on network switch', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Switch network
        client.setNetwork(Network.MAINNET);

        // After switching, the factoryAddress might be empty in the new config.
        // Re-inject it for testing.
        (client as any).networkConfig.factoryAddress = 'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';

        // After switching, the private _factory is null, so accessing client.factory 
        // creates a new FactoryClient with different internal state.
        // We need to re-mock the new FactoryClient's getPair.
        (client as any).factory.getPair = mockGetPair;

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// Helper: build i128 ScVal from a bigint
// ---------------------------------------------------------------------------
function scvI128(value: bigint): xdr.ScVal {
    const lo = xdr.Uint64.fromString(String(value & 0xFFFFFFFFFFFFFFFFn));
    const hi = xdr.Uint64.fromString(String(value >> 64n));
    return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo, hi }));
}

// ---------------------------------------------------------------------------
// Helper: create a minimal EventResponse for a given pool event type
// ---------------------------------------------------------------------------
const SENDER = 'GCCZXOSJ6XRJONMWNXGAGYW6DUBR5KORXT52JKFSUTSOYEIRELMEDR2H';
const TOKEN_A = 'GBBF3FGKU4HJ2UZQRR4OKU7KQWZSWW4NXMXJ4BTTD6QYWULBXBGWSETO';
const TOKEN_B = 'GD5XWXNLNRZUPIDFWWQUWS3YBFJPL4QB5Z7DNZ7NR3MSJQFKMF22GBCJ';

function makePoolEvent(
    type: 'swap' | 'mint' | 'burn',
    pairAddress: string,
    ledger: number,
    txHash: string,
): SorobanRpc.Api.EventResponse {
    const sender = Address.fromString(SENDER).toScVal();
    const tokenA = Address.fromString(TOKEN_A).toScVal();
    const tokenB = Address.fromString(TOKEN_B).toScVal();

    let entries: xdr.ScMapEntry[];
    switch (type) {
        case 'swap':
            entries = [
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sender'), val: sender }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token_in'), val: tokenA }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token_out'), val: tokenB }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_in'), val: scvI128(1000000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_out'), val: scvI128(990000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('fee_bps'), val: xdr.ScVal.scvU32(30) }),
            ];
            break;
        case 'mint':
            entries = [
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sender'), val: sender }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_a'), val: scvI128(500000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_b'), val: scvI128(500000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('liquidity'), val: scvI128(500000n) }),
            ];
            break;
        case 'burn':
            entries = [
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sender'), val: sender }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_a'), val: scvI128(250000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_b'), val: scvI128(250000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('liquidity'), val: scvI128(250000n) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('to'), val: sender }),
            ];
            break;
    }

    return {
        id: `event-${type}-${ledger}`,
        type: 'contract',
        ledger,
        ledgerClosedAt: new Date().toISOString(),
        pagingToken: `${ledger}-0`,
        inSuccessfulContractCall: true,
        txHash,
        contractId: { toString: () => pairAddress } as any,
        topic: [xdr.ScVal.scvSymbol(type)],
        value: xdr.ScVal.scvMap(entries),
    };
}

// ---------------------------------------------------------------------------
// watchPool tests
// ---------------------------------------------------------------------------
describe('watchPool', () => {
    const PAIR_ADDRESS = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

    let mockProvider: MockProvider;
    let client: CoralSwapClient;
    let module: ReturnType<CoralSwapClient['factoryModule']>;

    beforeEach(() => {
        mockProvider = new MockProvider();

        client = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
            rpcUrl: 'https://soroban-testnet.stellar.org',
        });

        // Replace the RPC server with MockProvider
        (client as any)._server = mockProvider;

        module = client.factoryModule();
    });

    afterEach(() => {
        mockProvider.reset();
    });

    it('fires callback for swap events', async () => {
        const events = [makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1')];
        mockProvider.setEvents(PAIR_ADDRESS, events);
        mockProvider.setLatestLedger(100);

        const callback = jest.fn();
        const unsubscribe = module.watchPool(PAIR_ADDRESS, callback, 10_000);

        // Wait for the initial (immediate) poll to complete
        await new Promise((r) => setTimeout(r, 50));

        expect(callback).toHaveBeenCalledTimes(1);

        const ev = callback.mock.calls[0][0];
        expect(ev.type).toBe('swap');
        if (ev.type === 'swap') {
            expect(ev.amountIn).toBe(1000000n);
            expect(ev.amountOut).toBe(990000n);
            expect(ev.feeBps).toBe(30);
        }

        unsubscribe();
    });

    it('fires callback for mint and burn events', async () => {
        const events = [
            makePoolEvent('mint', PAIR_ADDRESS, 100, 'tx1'),
            makePoolEvent('burn', PAIR_ADDRESS, 101, 'tx2'),
        ];
        mockProvider.setEvents(PAIR_ADDRESS, events);
        mockProvider.setLatestLedger(101);

        const callback = jest.fn();
        const unsubscribe = module.watchPool(PAIR_ADDRESS, callback, 10_000);

        await new Promise((r) => setTimeout(r, 50));

        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback.mock.calls[0][0].type).toBe('mint');
        expect(callback.mock.calls[1][0].type).toBe('burn');

        unsubscribe();
    });

    it('does not emit duplicate events from previously seen ledgers', async () => {
        // First poll: events at ledger 100
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1'),
        ]);
        mockProvider.setLatestLedger(100);

        const callback = jest.fn();
        const unsubscribe = module.watchPool(PAIR_ADDRESS, callback, 200);

        await new Promise((r) => setTimeout(r, 50));
        expect(callback).toHaveBeenCalledTimes(1);

        // Second interval fires at ~200ms with the same events (should be skipped)
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1'),
        ]);
        mockProvider.setLatestLedger(100);

        await new Promise((r) => setTimeout(r, 250));

        // No additional callbacks — the event was deduplicated
        expect(callback).toHaveBeenCalledTimes(1);

        unsubscribe();

        // Second poll: same event at ledger 100 again (should be skipped)
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1'),
        ]);
        mockProvider.setLatestLedger(100);

        // Advance to next interval
        await new Promise((r) => setTimeout(r, 50));

        // No additional callbacks — the event was deduplicated
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('emits events from a new ledger after previously seen ones', async () => {
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1'),
        ]);
        mockProvider.setLatestLedger(100);

        const callback = jest.fn();
        const unsubscribe = module.watchPool(PAIR_ADDRESS, callback, 200);

        // Initial poll fires immediately
        await new Promise((r) => setTimeout(r, 50));
        expect(callback).toHaveBeenCalledTimes(1);

        // New event at ledger 101 — next interval should pick it up
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('mint', PAIR_ADDRESS, 101, 'tx2'),
        ]);
        mockProvider.setLatestLedger(101);

        await new Promise((r) => setTimeout(r, 250));

        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback.mock.calls[1][0].type).toBe('mint');

        unsubscribe();
    });

    it('unsubscribe stops polling immediately', async () => {
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1'),
        ]);
        mockProvider.setLatestLedger(100);

        const callback = jest.fn();
        const unsubscribe = module.watchPool(PAIR_ADDRESS, callback, 10_000);

        // Let the initial poll fire
        await new Promise((r) => setTimeout(r, 50));
        expect(callback).toHaveBeenCalledTimes(1);

        // Unsubscribe
        unsubscribe();

        // Add new events and advance — no further callbacks expected
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('mint', PAIR_ADDRESS, 101, 'tx2'),
        ]);
        mockProvider.setLatestLedger(101);

        await new Promise((r) => setTimeout(r, 100));

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('logs polling errors without crashing', async () => {
        const errorLogger = jest.fn();
        const errClient = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
            rpcUrl: 'https://soroban-testnet.stellar.org',
            logger: { debug: jest.fn(), info: jest.fn(), error: errorLogger },
        });
        (errClient as any)._server = mockProvider;

        const errModule = errClient.factoryModule();

        let calls = 0;
        const originalGetEvents = mockProvider.getEvents.bind(mockProvider);
        mockProvider.getEvents = jest.fn().mockImplementation((req) => {
            calls++;
            if (calls === 1) return Promise.reject(new Error('RPC failure'));
            return originalGetEvents(req);
        });

        const callback = jest.fn();
        const unsubscribe = errModule.watchPool(PAIR_ADDRESS, callback, 200);

        // First poll: rejects — error logged, no callback
        await new Promise((r) => setTimeout(r, 50));
        expect(errorLogger).toHaveBeenCalledWith(
            'watchPool: polling error',
            expect.any(Error),
        );
        expect(callback).not.toHaveBeenCalled();

        // Stage events; next poll cycle should succeed
        mockProvider.setEvents(PAIR_ADDRESS, [
            makePoolEvent('swap', PAIR_ADDRESS, 100, 'tx1'),
        ]);
        await new Promise((r) => setTimeout(r, 250));

        expect(callback).toHaveBeenCalledTimes(1);

        unsubscribe();
    });
});
