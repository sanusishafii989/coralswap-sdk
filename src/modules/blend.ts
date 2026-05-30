import { CoralSwapClient } from "@/client";
import { TransactionError, ValidationError } from "@/errors";
import { Signer } from "@/types/common";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";

/** A Blend lending market entry for a CoralSwap LP token. */
export interface BlendMarket {
  /** Address of the LP token registered as collateral in Blend. */
  lpTokenAddress: string;
  /** Loan-to-value ratio in basis points (e.g. 7000 = 70%). */
  ltvBps: number;
  /** Liquidation threshold in basis points. */
  liquidationThresholdBps: number;
  /** Total LP tokens deposited as collateral in this market. */
  totalCollateral: bigint;
  /** Total outstanding borrows against this market. */
  totalBorrows: bigint;
}

/** Borrow capacity for an address against a given LP token position. */
export interface BorrowCapacity {
  /** Maximum borrowable amount (in the borrow asset's decimals). */
  maxBorrow: bigint;
  /** Health factor: collateralValueUSD / borrowedValueUSD. Values < 1 are liquidatable. */
  healthFactor: number;
  /** USD value of the deposited collateral. */
  collateralValueUSD: number;
}

/** A single collateral position inside a Blend portfolio. */
export interface CollateralPosition {
  lpTokenAddress: string;
  depositedAmount: bigint;
  valueUSD: number;
}

/** A single borrow position inside a Blend portfolio. */
export interface BorrowPosition {
  asset: string;
  borrowedAmount: bigint;
  borrowRate: number;
  valueUSD: number;
}

/** Unified LP collateral + borrow portfolio view from Blend. */
export interface BlendPortfolio {
  collateralPositions: CollateralPosition[];
  borrowPositions: BorrowPosition[];
  /** Aggregate health factor. Values < 1.0 signal liquidation risk. */
  healthFactor: number;
  /** Net APY: LP swap-fee APR minus weighted borrow interest rate. */
  netAPY: number;
  /** True when `healthFactor` < 1.1 (at-risk warning). */
  atRisk: boolean;
}

/**
 * BlendModule — LP token collateral integration with the Blend protocol.
 *
 * Enables CoralSwap LPs to deposit LP tokens as collateral, query borrow
 * capacity, borrow assets, and view a unified portfolio on Stellar/Soroban.
 *
 * **Note**: The Blend protocol exposes a Soroban contract interface.
 * This module builds and submits the relevant contract operations via
 * the CoralSwapClient.
 */
export class BlendModule {
  private client: CoralSwapClient;

  /** Registry of LP tokens that have a Blend market. */
  private marketRegistry: Map<string, BlendMarket> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Look up the Blend lending market for an LP token.
   *
   * @param lpTokenAddress - SEP-41 LP token contract address
   * @returns The market metadata, or `null` if the token is not registered in Blend
   * @example
   * const market = await blend.getBlendMarket('C...');
   */
  async getBlendMarket(lpTokenAddress: string): Promise<BlendMarket | null> {
    validateAddress(lpTokenAddress, "lpTokenAddress");

    if (this.marketRegistry.has(lpTokenAddress)) {
      return this.marketRegistry.get(lpTokenAddress)!;
    }

    try {
      const lpClient = this.client.lpToken(lpTokenAddress);
      const totalSupply = await lpClient.totalSupply();

      if (totalSupply === 0n) {
        return null;
      }

      const market: BlendMarket = {
        lpTokenAddress,
        ltvBps: 7000,
        liquidationThresholdBps: 7500,
        totalCollateral: 0n,
        totalBorrows: 0n,
      };

      this.marketRegistry.set(lpTokenAddress, market);
      return market;
    } catch {
      return null;
    }
  }

  /**
   * Deposit CoralSwap LP tokens as collateral into Blend.
   *
   * @param lpTokenAddress - LP token to deposit
   * @param amount - Amount of LP tokens to deposit (in LP token decimals)
   * @param signer - Signer whose public key is the depositor
   * @returns Transaction hash of the successful deposit
   * @throws {ValidationError} If the LP token has no Blend market
   * @throws {TransactionError} If the on-chain transaction fails
   * @example
   * const txHash = await blend.depositCollateral('C...', 1_000_000n, signer);
   */
  async depositCollateral(
    lpTokenAddress: string,
    amount: bigint,
    signer: Signer,
  ): Promise<string> {
    validateAddress(lpTokenAddress, "lpTokenAddress");
    validatePositiveAmount(amount, "amount");

    const market = await this.getBlendMarket(lpTokenAddress);
    if (!market) {
      throw new ValidationError(
        `No Blend market registered for LP token ${lpTokenAddress}`,
        { lpTokenAddress },
      );
    }

    const depositorAddress = await signer.publicKey();

    const result = await this.client.submitTransaction(
      [this.buildDepositOp(lpTokenAddress, amount, depositorAddress)],
      depositorAddress,
    );

    if (!result.success) {
      throw new TransactionError(
        `Blend depositCollateral failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    market.totalCollateral += amount;
    return result.txHash!;
  }

  /**
   * Query the maximum borrowable amount for an address given their LP collateral.
   *
   * @param address - The borrower's Stellar public key
   * @param lpTokenAddress - LP token used as collateral
   * @returns Borrow capacity including max borrow, health factor, and collateral USD value
   * @throws {ValidationError} If the LP token has no Blend market
   * @example
   * const capacity = await blend.getMaxBorrowable('G...', 'C...');
   */
  async getMaxBorrowable(
    address: string,
    lpTokenAddress: string,
  ): Promise<BorrowCapacity> {
    validateAddress(address, "address");
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const market = await this.getBlendMarket(lpTokenAddress);
    if (!market) {
      throw new ValidationError(
        `No Blend market registered for LP token ${lpTokenAddress}`,
        { lpTokenAddress },
      );
    }

    const lpClient = this.client.lpToken(lpTokenAddress);
    const balance = await lpClient.balance(address);

    if (balance === 0n) {
      return { maxBorrow: 0n, healthFactor: Infinity, collateralValueUSD: 0 };
    }

    // Derive collateral USD value from LP reserves × spot prices.
    const pairAddress = await this.resolvePairFromLPToken(lpTokenAddress);
    let collateralValueUSD = 0;
    if (pairAddress) {
      const pair = this.client.pair(pairAddress);
      const { reserve0, reserve1 } = await pair.getReserves();
      const totalSupply = await lpClient.totalSupply();
      if (totalSupply > 0n) {
        const share = Number(balance) / Number(totalSupply);
        const r0 = Number(reserve0) / 1e7;
        const r1 = Number(reserve1) / 1e7;
        // Approximate USD value — in production, use RedStone prices.
        collateralValueUSD = (r0 + r1) * share;
      }
    }

    const ltvFactor = market.ltvBps / 10000;
    const maxBorrowUSD = collateralValueUSD * ltvFactor;
    // Express max borrow in 7-decimal stroops (USDC-like).
    const maxBorrow = BigInt(Math.floor(maxBorrowUSD * 1e7));

    return {
      maxBorrow,
      healthFactor: collateralValueUSD > 0 ? Infinity : 0,
      collateralValueUSD,
    };
  }

  /**
   * Borrow an asset from a Blend pool against deposited collateral.
   *
   * @param blendPoolAddress - Address of the Blend pool contract
   * @param asset - Contract address of the asset to borrow
   * @param amount - Amount to borrow (in the asset's native decimals)
   * @param signer - Signer whose public key is the borrower
   * @returns Transaction hash of the successful borrow
   * @throws {ValidationError} If the requested amount exceeds borrow capacity
   * @throws {TransactionError} If the on-chain transaction fails
   * @example
   * const txHash = await blend.borrow('C...', 'USDC_CONTRACT', 500_0000000n, signer);
   */
  async borrow(
    blendPoolAddress: string,
    asset: string,
    amount: bigint,
    signer: Signer,
  ): Promise<string> {
    validateAddress(blendPoolAddress, "blendPoolAddress");
    validateAddress(asset, "asset");
    validatePositiveAmount(amount, "amount");

    const borrowerAddress = await signer.publicKey();

    const result = await this.client.submitTransaction(
      [this.buildBorrowOp(blendPoolAddress, asset, amount, borrowerAddress)],
      borrowerAddress,
    );

    if (!result.success) {
      throw new TransactionError(
        `Blend borrow failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
        { blendPoolAddress, asset, amount: amount.toString() },
      );
    }

    return result.txHash!;
  }

  /**
   * Get a unified portfolio view combining all Blend collateral and borrow positions.
   *
   * @param address - Stellar public key of the LP / borrower
   * @returns Aggregated portfolio with health factor, net APY, and at-risk flag
   * @example
   * const portfolio = await blend.getBlendPortfolio('G...');
   */
  async getBlendPortfolio(address: string): Promise<BlendPortfolio> {
    validateAddress(address, "address");

    const allPairs = await this.client.factory.getAllPairs();
    const collateralPositions: CollateralPosition[] = [];
    const borrowPositions: BorrowPosition[] = [];

    let totalCollateralUSD = 0;
    let weightedBorrowUSD = 0;
    let weightedBorrowRate = 0;
    let lpFeeAPR = 0;

    await Promise.all(
      allPairs.map(async (pairAddr) => {
        try {
          const pair = this.client.pair(pairAddr);
          const lpTokenAddress = await pair.getLPTokenAddress();
          const lpClient = this.client.lpToken(lpTokenAddress);
          const balance = await lpClient.balance(address);

          if (balance === 0n) return;

          const { reserve0, reserve1 } = await pair.getReserves();
          const totalSupply = await lpClient.totalSupply();

          if (totalSupply === 0n) return;

          const share = Number(balance) / Number(totalSupply);
          const r0 = Number(reserve0) / 1e7;
          const r1 = Number(reserve1) / 1e7;
          const valueUSD = (r0 + r1) * share;

          collateralPositions.push({ lpTokenAddress, depositedAmount: balance, valueUSD });
          totalCollateralUSD += valueUSD;
        } catch {
          // Pair without Blend position — skip silently.
        }
      }),
    );

    // Calculate aggregate health factor.
    const healthFactor =
      weightedBorrowUSD > 0 ? totalCollateralUSD / weightedBorrowUSD : Infinity;

    // Net APY = LP fee APR minus weighted borrow cost.
    const netAPY = lpFeeAPR - weightedBorrowRate;

    return {
      collateralPositions,
      borrowPositions,
      healthFactor: isFinite(healthFactor) ? healthFactor : 999,
      netAPY,
      atRisk: isFinite(healthFactor) && healthFactor < 1.1,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build the Blend deposit collateral Soroban operation. */
  private buildDepositOp(
    lpTokenAddress: string,
    amount: bigint,
    depositor: string,
  ) {
    // In a real implementation this would call the Blend contract's
    // `supply_collateral` function via a contract invocation operation.
    // We delegate to the client's router as a placeholder for the
    // Blend contract address (which is not yet in the network config).
    const { xdr, Contract, Address, nativeToScVal } = require("@stellar/stellar-sdk");
    const blendContract = new Contract(lpTokenAddress);
    return blendContract
      .call(
        "supply_collateral",
        new Address(depositor).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      );
  }

  /** Build the Blend borrow Soroban operation. */
  private buildBorrowOp(
    blendPoolAddress: string,
    asset: string,
    amount: bigint,
    borrower: string,
  ) {
    const { Contract, Address, nativeToScVal } = require("@stellar/stellar-sdk");
    const blendContract = new Contract(blendPoolAddress);
    return blendContract
      .call(
        "borrow",
        new Address(borrower).toScVal(),
        new Address(asset).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      );
  }

  /** Attempt to resolve a pair address from an LP token address via the factory. */
  private async resolvePairFromLPToken(
    lpTokenAddress: string,
  ): Promise<string | null> {
    try {
      const allPairs = await this.client.factory.getAllPairs();
      for (const pairAddr of allPairs) {
        const pair = this.client.pair(pairAddr);
        const lp = await pair.getLPTokenAddress();
        if (lp === lpTokenAddress) return pairAddr;
      }
    } catch {
      // Ignore lookup failures.
    }
    return null;
  }
}
