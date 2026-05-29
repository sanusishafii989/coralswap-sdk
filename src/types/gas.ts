/**
 * Gas / fee estimate returned by estimateGas() and the estimateOnly option.
 */
export interface GasEstimate {
  /** Raw fee in stroops (the smallest XLM unit). */
  fee: number;
  /** Human-readable fee string, e.g. "0.00001 XLM". */
  feeXLM: string;
  /** Optional USD equivalent of the fee (requires a price feed). */
  feeUSD?: number;
}
