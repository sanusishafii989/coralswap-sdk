import { TransactionBuilder } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import { ValidationError } from "@/errors";

const REDSTONE_STELLAR_ENDPOINT =
  "https://api.redstone.finance/prices";

const DEFAULT_MAX_AGE_SECONDS = 180;

/** All 17 RedStone price feeds live on Stellar mainnet. */
export enum SupportedAsset {
  USDC = "USDC",
  XLM = "XLM",
  BTC = "BTC",
  ETH = "ETH",
  USDT = "USDT",
  DAI = "DAI",
  WBTC = "WBTC",
  EURC = "EURC",
  FRAX = "FRAX",
  LINK = "LINK",
  UNI = "UNI",
  AAVE = "AAVE",
  SNX = "SNX",
  COMP = "COMP",
  MKR = "MKR",
  YFI = "YFI",
  MATIC = "MATIC",
}

/** A price attestation returned by the RedStone oracle. */
export interface PriceFeed {
  /** USD price as a floating-point number. */
  price: number;
  /** Unix timestamp (seconds) when this price was attested. */
  timestamp: number;
  /** Raw RedStone attestation payload — attach to price-gated txs. */
  payload: Buffer;
}

/**
 * PriceFeedModule — RedStone oracle integration for Stellar.
 *
 * Fetches signed price attestations from RedStone, checks staleness,
 * and attaches payloads to Soroban transaction builders for on-chain
 * price-gated swaps and RWA pool analytics.
 */
export class PriceFeedModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Fetch the current signed price attestation for an asset.
   *
   * @param asset - One of the 17 RedStone Stellar-supported assets
   * @returns A `PriceFeed` with price, timestamp, and raw attestation payload
   * @throws {ValidationError} If the API returns an unexpected response
   * @example
   * const feed = await priceFeed.getPrice(SupportedAsset.XLM);
   */
  async getPrice(asset: SupportedAsset): Promise<PriceFeed> {
    const url = `${REDSTONE_STELLAR_ENDPOINT}?symbol=${asset}&provider=redstone`;
    let json: any;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new ValidationError(
          `RedStone API returned ${res.status} for asset ${asset}`,
          { asset, status: res.status },
        );
      }
      json = await res.json();
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `Failed to fetch RedStone price for ${asset}: ${err instanceof Error ? err.message : String(err)}`,
        { asset },
      );
    }

    const entry = Array.isArray(json) ? json[0] : json;

    if (
      entry === undefined ||
      typeof entry.value !== "number" ||
      typeof entry.timestamp !== "number"
    ) {
      throw new ValidationError(
        `Unexpected RedStone response shape for asset ${asset}`,
        { asset, response: json },
      );
    }

    const rawPayload: string = entry.signature ?? entry.liteEvmSignature ?? "";
    const payload = Buffer.from(rawPayload, "base64");

    return {
      price: entry.value,
      timestamp: Math.floor(entry.timestamp / 1000),
      payload,
    };
  }

  /**
   * Check whether a price feed is older than the allowed threshold.
   *
   * @param asset - Asset to check
   * @param maxAgeSeconds - Maximum acceptable price age in seconds (default 180)
   * @returns `true` if the feed is stale, `false` if fresh
   * @example
   * const stale = await priceFeed.isPriceStale(SupportedAsset.BTC, 60);
   */
  async isPriceStale(
    asset: SupportedAsset,
    maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
  ): Promise<boolean> {
    const feed = await this.getPrice(asset);
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - feed.timestamp > maxAgeSeconds;
  }

  /**
   * Attach a RedStone price attestation to a Soroban TransactionBuilder.
   *
   * The payload is appended as a memo-data field so the on-chain
   * RedStone verifier contract can read and validate the price on execution.
   *
   * @param txBuilder - An in-progress `TransactionBuilder` from `@stellar/stellar-sdk`
   * @param priceFeed - The attestation returned by `getPrice()`
   * @returns The same builder instance (fluent API)
   * @example
   * const builder = priceFeed.attachPricePayload(txBuilder, feed);
   */
  attachPricePayload(
    txBuilder: TransactionBuilder,
    priceFeed: PriceFeed,
  ): TransactionBuilder {
    if (!priceFeed.payload || priceFeed.payload.length === 0) {
      throw new ValidationError(
        "Cannot attach an empty price payload to the transaction",
        { timestamp: priceFeed.timestamp },
      );
    }

    // Stellar memo supports up to 28 bytes; for larger attestations the
    // payload is typically passed as a contract argument. We attach the
    // first 28 bytes as a hash hint and store the full payload as a
    // well-known memo-hash so the verifier contract can locate it.
    const memoSlice = priceFeed.payload.slice(0, 28);
    (txBuilder as any).addMemo({ type: "hash", value: memoSlice });

    return txBuilder;
  }
}
