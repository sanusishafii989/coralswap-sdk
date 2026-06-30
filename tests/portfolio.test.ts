import { CoralSwapClient } from '../src/client';
import { ValidationError } from '../src/errors';
import { PortfolioModule } from '../src/modules/portfolio';
import { Network } from '../src/types/common';

const TEST_SECRET =
  'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const USER =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('PortfolioModule input validation', () => {
  let client: CoralSwapClient;
  let portfolio: PortfolioModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });
    portfolio = new PortfolioModule(client);
  });

  it('rejects future dates before making portfolio RPC calls', async () => {
    const getPositionsSpy = jest
      .spyOn((portfolio as any).positions, 'getPositions')
      .mockResolvedValue({ positions: [] });

    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await expect(
      portfolio.getPortfolio(USER, { fromDate: futureDate } as any),
    ).rejects.toThrow(ValidationError);

    expect(getPositionsSpy).not.toHaveBeenCalled();
  });

  it('rejects inverted date ranges before making portfolio RPC calls', async () => {
    const getPositionsSpy = jest
      .spyOn((portfolio as any).positions, 'getPositions')
      .mockResolvedValue({ positions: [] });

    const fromDate = new Date('2024-01-02T00:00:00.000Z');
    const toDate = new Date('2024-01-01T00:00:00.000Z');

    await expect(
      portfolio.getPortfolio(USER, { fromDate, toDate } as any),
    ).rejects.toThrow(ValidationError);

    expect(getPositionsSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid limit values before making portfolio RPC calls', async () => {
    const getPositionsSpy = jest
      .spyOn((portfolio as any).positions, 'getPositions')
      .mockResolvedValue({ positions: [] });

    await expect(
      portfolio.getPortfolio(USER, { limit: 0 } as any),
    ).rejects.toThrow(ValidationError);

    expect(getPositionsSpy).not.toHaveBeenCalled();
  });
});
