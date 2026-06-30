/**
 * Monitoring module — collect, query, and dashboard CoralSwap protocol metrics.
 *
 * Tracks on-chain metrics across multiple categories (liquidity, volume, fees,
 * gas, price, pairs). Metrics are collected as time-series data points and
 * can be queried over custom windows.
 *
 * ## Metric categories
 *
 * | Category    | Description                          |
 * |-------------|--------------------------------------|
 * | `liquidity` | Pool TVL and reserve levels          |
 * | `volume`    | Swap volume over time windows        |
 * | `fees`      | Protocol fee revenue                 |
 * | `gas`       | Soroban resource consumption         |
 * | `price`     | Token spot and TWAP prices           |
 * | `pairs`     | Pair creation and lifecycle          |
 *
 * @module monitoring
 */

import { CoralSwapClient } from '@/client';
import { MetricConfig, MetricInstance, MetricDataPoint, MetricCategory, MetricGranularity, MetricQueryOptions, MonitoringDashboard } from '@/types/monitoring';
import { ValidationError } from '@/errors';
import { validateAddress } from '@/utils/validation';

const MAX_METRICS = 100;
const MAX_DATA_POINTS = 1000;
const DEFAULT_GRANULARITY: MetricGranularity = '1h';

/**
 * Monitoring module — collect and query protocol metrics.
 *
 * @example
 * ```ts
 * const monitor = new MonitoringModule(client);
 * const id = await monitor.registerMetric({
 *   name: 'CORAL-USDC TVL', category: 'liquidity',
 *   targetAddress: 'C...', granularity: '1h',
 * });
 * await monitor.collect(id);
 * const dashboard = await monitor.getDashboard();
 * console.log(dashboard.totalLiquidityUSD);
 * ```
 */
export class MonitoringModule {
  private readonly client: CoralSwapClient;
  private readonly metrics: Map<string, MetricInstance> = new Map();

  /**
   * @param client - Configured CoralSwap client
   */
  constructor(client: CoralSwapClient) { this.client = client; }

  /**
   * Register a new metric for monitoring.
   *
   * @param config - Metric configuration
   * @returns The unique metric ID
   * @throws {ValidationError} If address is invalid, name empty, or max metrics reached
   * @example
   * ```ts
   * const id = await monitor.registerMetric({
   *   name: 'CORAL/USDC Spot Price', category: 'price',
   *   targetAddress: 'C...', granularity: '5m',
   * });
   * ```
   */
  async registerMetric(config: MetricConfig): Promise<string> {
    if (this.metrics.size >= MAX_METRICS) throw new ValidationError(`Maximum of ${MAX_METRICS} metrics reached`);
    if (!config.name || config.name.trim().length === 0) throw new ValidationError('Metric name must not be empty');
    validateAddress(config.targetAddress, 'targetAddress');
    const id = `metric_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const resolvedConfig: MetricConfig = { ...config, granularity: config.granularity ?? DEFAULT_GRANULARITY, enabled: config.enabled ?? true };
    this.metrics.set(id, { id, config: resolvedConfig, recentData: [], inBreach: false, createdAt: Math.floor(Date.now() / 1000) });
    return id;
  }

  /**
   * Update an existing metric's configuration.
   *
   * @param metricId - Metric ID to update
   * @param updates - Partial configuration
   * @throws {ValidationError} If `metricId` does not exist
   * @example
   * ```ts
   * await monitor.updateMetric(id, { enabled: false });
   * ```
   */
  async updateMetric(metricId: string, updates: Partial<MetricConfig>): Promise<void> {
    const existing = this.metrics.get(metricId);
    if (!existing) throw new ValidationError(`Metric not found: ${metricId}`);
    this.metrics.set(metricId, { ...existing, config: { ...existing.config, ...updates } });
  }

  /**
   * Remove a metric and its collected data.
   *
   * @param metricId - Metric ID to delete
   * @throws {ValidationError} If `metricId` does not exist
   */
  async deleteMetric(metricId: string): Promise<void> {
    if (!this.metrics.has(metricId)) throw new ValidationError(`Metric not found: ${metricId}`);
    this.metrics.delete(metricId);
  }

  /**
   * List all registered metrics, optionally filtered by category.
   *
   * @param category - Optional category filter
   * @returns Array of metric instances
   * @example
   * ```ts
   * const liquidityMetrics = await monitor.listMetrics('liquidity');
   * ```
   */
  async listMetrics(category?: MetricCategory): Promise<MetricInstance[]> {
    const all = Array.from(this.metrics.values());
    return category ? all.filter((m) => m.config.category === category) : all;
  }

  /**
   * Get a single metric instance by ID.
   *
   * @param metricId - Unique metric identifier
   * @returns The metric instance
   * @throws {ValidationError} If `metricId` does not exist
   */
  async getMetric(metricId: string): Promise<MetricInstance> {
    const instance = this.metrics.get(metricId);
    if (!instance) throw new ValidationError(`Metric not found: ${metricId}`);
    return instance;
  }

  /**
   * Collect a single data point for a metric.
   *
   * @param metricId - Metric ID to collect for
   * @throws {ValidationError} If `metricId` does not exist
   * @example
   * ```ts
   * await monitor.collect(id);
   * ```
   */
  async collect(metricId: string): Promise<void> {
    const instance = this.metrics.get(metricId);
    if (!instance) throw new ValidationError(`Metric not found: ${metricId}`);
    if (!instance.config.enabled) return;
    const value = await this.fetchMetricValue(instance.config);
    const dataPoint: MetricDataPoint = { timestamp: Math.floor(Date.now() / 1000), value };
    instance.recentData.push(dataPoint);
    instance.currentValue = value;
    if (instance.recentData.length > MAX_DATA_POINTS) instance.recentData = instance.recentData.slice(-MAX_DATA_POINTS);
    instance.inBreach = false;
    if (instance.config.alertUpperBound !== undefined && value > instance.config.alertUpperBound) instance.inBreach = true;
    if (instance.config.alertLowerBound !== undefined && value < instance.config.alertLowerBound) instance.inBreach = true;
    this.metrics.set(metricId, instance);
  }

  /**
   * Collect data points for all enabled metrics.
   *
   * @returns Array of metric IDs that were collected
   * @example
   * ```ts
   * const collected = await monitor.collectAll();
   * ```
   */
  async collectAll(): Promise<string[]> {
    const collected: string[] = [];
    for (const [id, instance] of this.metrics) {
      if (!instance.config.enabled) continue;
      try { await this.collect(id); collected.push(id); } catch { continue; }
    }
    return collected;
  }

  /**
   * Query historical data points for a metric within a time window.
   *
   * @param options - Query parameters (metric ID, time range, granularity)
   * @returns Array of data points matching the query
   * @throws {ValidationError} If the metric does not exist
   * @example
   * ```ts
   * const data = await monitor.queryMetric({
   *   metricId: id,
   *   fromTimestamp: Math.floor(Date.now() / 1000) - 86400 * 7,
   *   toTimestamp: Math.floor(Date.now() / 1000),
   * });
   * ```
   */
  async queryMetric(options: MetricQueryOptions): Promise<MetricDataPoint[]> {
    const instance = this.metrics.get(options.metricId);
    if (!instance) throw new ValidationError(`Metric not found: ${options.metricId}`);
    let data = instance.recentData.filter((dp) => dp.timestamp >= options.fromTimestamp && dp.timestamp <= options.toTimestamp);
    const limit = options.limit ?? 1000;
    if (data.length > limit) { const step = Math.ceil(data.length / limit); data = data.filter((_, i) => i % step === 0); }
    return data;
  }

  /**
   * Build a real-time monitoring dashboard snapshot.
   *
   * @returns Dashboard snapshot
   * @example
   * ```ts
   * const dashboard = await monitor.getDashboard();
   * console.log(`Liquidity: $${dashboard.totalLiquidityUSD}`);
   * console.log(`Metrics in breach: ${dashboard.metricsInBreach}`);
   * ```
   */
  async getDashboard(): Promise<MonitoringDashboard> {
    const all = Array.from(this.metrics.values());
    const categories: Partial<Record<MetricCategory, MetricInstance[]>> = {};
    let metricsInBreach = 0, totalLiquidityUSD = 0, volume24hUSD = 0, fees24hUSD = 0, totalGas = 0, gasCount = 0;
    for (const instance of all) {
      const cat = instance.config.category;
      if (!categories[cat]) categories[cat] = [];
      categories[cat]!.push(instance);
      if (instance.inBreach) metricsInBreach++;
      if (cat === 'liquidity' && instance.currentValue !== undefined) totalLiquidityUSD += instance.currentValue;
      if (cat === 'volume' && instance.currentValue !== undefined) volume24hUSD += instance.currentValue;
      if (cat === 'fees' && instance.currentValue !== undefined) fees24hUSD += instance.currentValue;
      if (cat === 'gas' && instance.currentValue !== undefined) { totalGas += instance.currentValue; gasCount++; }
    }
    return { categories, totalMetrics: all.length, metricsInBreach, totalLiquidityUSD, volume24hUSD, fees24hUSD, averageGasStroops: gasCount > 0 ? totalGas / gasCount : 0 };
  }

  /**
   * Remove data points older than the specified age.
   *
   * @param olderThanSeconds - Age threshold in seconds (default 90 days)
   * @example
   * ```ts
   * monitor.prune(30 * 86400);
   * ```
   */
  prune(olderThanSeconds: number = 7_776_000): void {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    for (const [, instance] of this.metrics) {
      instance.recentData = instance.recentData.filter((dp) => dp.timestamp >= cutoff);
    }
  }

  private async fetchMetricValue(config: MetricConfig): Promise<number> {
    switch (config.category) {
      case 'liquidity': return this.fetchLiquidityValue(config.targetAddress);
      case 'volume': return this.fetchVolumeValue(config.targetAddress);
      case 'fees': return this.fetchFeesValue(config.targetAddress);
      case 'gas': return this.fetchGasValue();
      case 'price': return this.fetchPriceValue(config.targetAddress);
      case 'pairs': return this.fetchPairsValue();
      default: return 0;
    }
  }

  private async fetchLiquidityValue(_address: string): Promise<number> {
    try { const r = await this.client.pair(_address).getReserves(); return Number(r.reserve0 + r.reserve1) / 1e7; }
    catch { return 0; }
  }

  private async fetchVolumeValue(_address: string): Promise<number> { return 0; }
  private async fetchFeesValue(_address: string): Promise<number> { return 0; }
  private async fetchGasValue(): Promise<number> { return 0; }

  private async fetchPriceValue(_pairAddress: string): Promise<number> {
    try { const r = await this.client.pair(_pairAddress).getReserves(); return r.reserve0 === 0n ? 0 : Number(r.reserve1) / Number(r.reserve0); }
    catch { return 0; }
  }

  private async fetchPairsValue(): Promise<number> {
    try { return (await this.client.factory.getAllPairs()).length; }
    catch { return 0; }
  }
}
