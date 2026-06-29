import { CoralSwapClient } from "@/client";
import { validateAddress } from "@/utils/validation";
import { ValidationError } from "@/errors";
import { SorobanRpc } from "@stellar/stellar-sdk";

export interface LeaderboardEntry {
  rank: number;
  address: string;
  metric: "volume" | "yield";
  metricValue: bigint;
  change24h: number;
}

export interface LeaderboardOptions {
  period: "24h" | "7d" | "30d";
  limit?: number;
  pairAddress?: string;
}

/**
 * Leaderboard module — ranks top LPs and traders by yield/volume.
 *
 * Interacts directly with Soroban contract events using the client RPC server
 * to compute real-time performance rankings.
 */
export class LeaderboardModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get the leaderboard of top LPs or traders by volume/yield.
   *
   * @param type - The type of leaderboard: 'lp' or 'trader'
   * @param options - Leaderboard options including period, limit, and pairAddress
   * @returns A promise resolving to an array of LeaderboardEntry objects
   */
  async getLeaderboard(
    type: "lp" | "trader",
    options: LeaderboardOptions = { period: "24h" },
  ): Promise<LeaderboardEntry[]> {
    if (type !== "lp" && type !== "trader") {
      throw new ValidationError(`Invalid leaderboard type: ${type}`);
    }

    const period = options.period ?? "24h";
    if (period !== "24h" && period !== "7d" && period !== "30d") {
      throw new ValidationError(`Invalid leaderboard period: ${period}`);
    }

    if (options.pairAddress) {
      validateAddress(options.pairAddress, "pairAddress");
    }

    // Determine ledger window sizes
    const ledgersPerDay = 17280;
    let periodLedgers = ledgersPerDay;
    if (period === "7d") periodLedgers = ledgersPerDay * 7;
    else if (period === "30d") periodLedgers = ledgersPerDay * 30;

    const currentLedger = await this.client.getCurrentLedger();
    const startLedger = Math.max(0, currentLedger - periodLedgers - ledgersPerDay);
    const endLedger = currentLedger;

    const topic = type === "trader" ? "swap" : "add_liquidity";

    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: options.pairAddress ? [options.pairAddress] : [],
          topics: [[topic]],
        },
      ],
      limit: 1000,
    };

    const response = await this.client.server.getEvents(request);
    if (!response || !Array.isArray(response.events)) return [];

    const currentMap = new Map<string, bigint>();
    const previousMap = new Map<string, bigint>();

    const currentStartBound = Math.max(0, currentLedger - periodLedgers);
    const previousStartBound = Math.max(0, currentLedger - periodLedgers - ledgersPerDay);
    const previousEndBound = Math.max(0, currentLedger - ledgersPerDay);

    for (const ev of response.events) {
      if (options.pairAddress && ev.contractId?.toString() !== options.pairAddress) continue;
      const topicName = ev.topic?.[0] ? decodeScValString(ev.topic[0]) : "";
      if (topicName !== topic) continue;
      if (!ev.value) continue;

      const data = decodeMapEvent(ev.value);
      if (!data) continue;

      const addressKey = type === "trader" ? "sender" : "provider";
      const userAddress = readAddress(data, addressKey);
      if (!userAddress) continue;

      const metricKey = type === "trader" ? "amount_in" : "liquidity";
      const value = readI128(data, metricKey);
      if (value === undefined) continue;

      // Classify event ledger sequence into current or previous period
      if (ev.ledger >= currentStartBound && ev.ledger <= endLedger) {
        currentMap.set(userAddress, (currentMap.get(userAddress) ?? 0n) + value);
      }
      if (ev.ledger >= previousStartBound && ev.ledger <= previousEndBound) {
        previousMap.set(userAddress, (previousMap.get(userAddress) ?? 0n) + value);
      }
    }

    // Convert currentMap to entries and sort
    const entries: LeaderboardEntry[] = [];
    const metricName = type === "trader" ? "volume" : "yield";

    for (const [address, metricValue] of currentMap.entries()) {
      const prevValue = previousMap.get(address) ?? 0n;
      let change24h = 0;

      if (prevValue > 0n) {
        change24h = Number(((metricValue - prevValue) * 10000n) / prevValue) / 100;
      } else if (metricValue > 0n) {
        change24h = 100;
      }

      entries.push({
        rank: 0,
        address,
        metric: metricName,
        metricValue,
        change24h,
      });
    }

    // Sort by metricValue descending
    entries.sort((a, b) => {
      if (b.metricValue > a.metricValue) return 1;
      if (b.metricValue < a.metricValue) return -1;
      return 0;
    });

    // Assign ranks
    entries.forEach((entry, idx) => {
      entry.rank = idx + 1;
    });

    const limit = options.limit ?? entries.length;
    return entries.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Event Decoding Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeMapEvent(value: any): Map<string, any> | null {
  const entries: unknown[] =
    typeof value?.map === "function" ? value.map() : value?._value;
  if (!Array.isArray(entries)) return null;

  const map = new Map<string, unknown>();
  for (const entry of entries as Array<{ key: unknown; val: unknown }>) {
    const k = entry.key as Record<string, () => { toString(): string }>;
    let key: string | undefined;
    try {
      key = k.sym?.().toString() ?? k.str?.().toString();
    } catch { /* skip */ }
    if (key) map.set(key, entry.val);
  }
  return map as Map<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readAddress(map: Map<string, any>, key: string): string | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.address === "function") return val.address().toString();
    if (typeof val._value?.toString === "function") return val._value.toString();
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readI128(map: Map<string, any>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.i128 === "function") {
      const parts = val.i128();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeScValString(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val.sym === "function") return val.sym().toString();
  if (typeof val.str === "function") return val.str().toString();
  return val.toString();
}
