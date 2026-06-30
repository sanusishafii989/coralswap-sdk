import { CoralSwapClient } from '@/client';
import {
  ValidationError,
  CoralSwapSDKError,
} from '@/errors';
import {
  AlertConfig,
  AlertCondition,
  AlertSeverity,
  AlertStatus,
  AlertFrequency,
  AlertInstance,
  AlertSummary,
  AlertConfigV2,
  AlertStatusV2,
  PriceAlertConfig,
  ILAlertConfig,
  HealthAlertConfig,
  VolumeAlertConfig,
  PriceAlert,
  ILAlert,
  HealthAlert,
  VolumeAlert,
  Alert,
} from '@/types/alerts';
import { InsufficientLiquidityError, InvalidThresholdError } from '@/errors';
import {
  validateAddress,
  validateDistinctTokens,
  validatePositiveAmount,
} from '@/utils/validation';

const PRICE_SCALE = 1_000_000_000_000_000_000n;
const PRICE_SCALE_SQRT = 1_000_000_000n;
const BPS = 10_000n;

export type AlertMetric =
  | 'reserve_ratio'
  | 'price_deviation'
  | 'volume_anomaly'
  | 'fee_accumulation'
  | 'lp_supply_change'
  | 'custom';

export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

export interface CreateAlertParams {
  name: string;
  description?: string;
  severity: AlertSeverity;
  condition: AlertCondition;
  threshold: bigint;
  frequency?: AlertFrequency;
  cooldownSeconds?: number;
  monitoredAddresses: string[];
  enabled?: boolean;
}

export interface UpdateAlertParams {
  name?: string;
  description?: string;
  severity?: AlertSeverity;
  condition?: AlertCondition;
  threshold?: bigint;
  frequency?: AlertFrequency;
  cooldownSeconds?: number;
  monitoredAddresses?: string[];
  metadata?: Record<string, string>;
}

export interface AlertEvent {
  alertId: string;
  name: string;
  severity: AlertSeverity;
  condition: AlertCondition;
  actualValue: bigint;
  targetAddress: string;
  ledger: number;
  timestamp: string;
}

interface StoredGenericAlertV2 {
  kind: 'generic';
  id: string;
  config: AlertConfigV2;
  target: string;
  triggeredAt?: number;
  createdAt: number;
}

interface StoredPriceAlertV2 {
  kind: 'price';
  id: string;
  config: PriceAlertConfig;
  target: string;
  triggeredAt?: number;
  createdAt: number;
}

interface StoredILAlertV2 {
  kind: 'il';
  id: string;
  config: ILAlertConfig;
  target: string;
  triggeredAt?: number;
  createdAt: number;
}

type StoredAlertV2 = StoredGenericAlertV2 | StoredPriceAlertV2 | StoredILAlertV2;

export class AlertModule {
  private client: CoralSwapClient;
  private listeners: Map<string, Array<(event: AlertEvent) => void>> = new Map();
  private rules: Map<string, AlertInstance> = new Map();
  private alertsV2: Map<string, StoredAlertV2> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  async create(params: CreateAlertParams): Promise<AlertInstance> {
    if (!params.name.trim()) {
      throw new ValidationError('Alert name must not be empty');
    }
    if (params.monitoredAddresses.length === 0) {
      throw new ValidationError('At least one monitored address is required');
    }
    if (params.threshold <= 0n) {
      throw new ValidationError('Threshold must be a positive value');
    }

    const now = Math.floor(Date.now() / 1000);
    const id = this.generateId();

    const instance: AlertInstance = {
      id,
      config: {
        name: params.name,
        description: params.description,
        condition: params.condition,
        threshold: params.threshold,
        severity: params.severity,
        frequency: params.frequency ?? 'interval',
        cooldownSeconds: params.cooldownSeconds ?? 900,
        monitoredAddresses: params.monitoredAddresses,
        enabled: params.enabled ?? true,
      },
      status: 'active',
      fireCount: 0,
      lastEvaluatedAt: now,
    };

    this.rules.set(id, instance);
    return instance;
  }

  async get(id: string): Promise<AlertInstance | null> {
    return this.rules.get(id) ?? null;
  }

  async list(status?: AlertStatus): Promise<AlertInstance[]> {
    const all = Array.from(this.rules.values());
    if (status) {
      return all.filter((a) => a.status === status);
    }
    return all;
  }

  async update(id: string, params: UpdateAlertParams): Promise<AlertInstance> {
    const existing = this.rules.get(id);
    if (!existing) {
      throw new CoralSwapSDKError(
        'ALERT_NOT_FOUND',
        `Alert ${id} not found`,
        { alertId: id },
      );
    }

    const config: AlertConfig = {
      ...existing.config,
      ...(params.name !== undefined && { name: params.name }),
      ...(params.description !== undefined && { description: params.description }),
      ...(params.severity !== undefined && { severity: params.severity }),
      ...(params.condition !== undefined && { condition: params.condition }),
      ...(params.threshold !== undefined && { threshold: params.threshold }),
      ...(params.frequency !== undefined && { frequency: params.frequency }),
      ...(params.cooldownSeconds !== undefined && { cooldownSeconds: params.cooldownSeconds }),
      ...(params.monitoredAddresses !== undefined && {
        monitoredAddresses: params.monitoredAddresses,
      }),
    };

    const updated: AlertInstance = {
      ...existing,
      config,
    };

    this.rules.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  async acknowledge(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'acknowledged', ['fired']);
  }

  async resolve(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'resolved', ['fired', 'acknowledged']);
  }

  async pause(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'paused', ['active', 'fired', 'acknowledged']);
  }

  async resume(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'active', ['paused']);
  }

  async archive(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'archived', [
      'active', 'fired', 'acknowledged', 'resolved', 'paused',
    ]);
  }

  async getSummary(): Promise<AlertSummary> {
    const all = Array.from(this.rules.values());
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;

    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let firedLast24h = 0;

    for (const alert of all) {
      const sev = alert.config.severity;
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;

      const st = alert.status;
      byStatus[st] = (byStatus[st] ?? 0) + 1;

      if (
        alert.status === 'fired' &&
        alert.lastFiredAt &&
        alert.lastFiredAt >= oneDayAgo
      ) {
        firedLast24h++;
      }
    }

    return {
      total: all.length,
      bySeverity: bySeverity as AlertSummary['bySeverity'],
      byStatus: byStatus as AlertSummary['byStatus'],
      firedLast24h,
    };
  }

  on(event: 'fired', handler: (event: AlertEvent) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);

    return () => {
      const handlers = this.listeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  protected emit(event: AlertEvent): void {
    const handlers = this.listeners.get('fired');
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Swallow listener errors to avoid breaking the chain
        }
      }
    }
  }

  // V2 API methods

  async createAlert(config: AlertConfigV2): Promise<string> {
    this.validateAlertConfigV2(config);
    const id = generateIdV2();
    this.alertsV2.set(id, {
      kind: 'generic',
      id,
      config,
      target: config.target,
      createdAt: Date.now(),
    });
    return id;
  }

  async createPriceAlert(config: PriceAlertConfig): Promise<string> {
    this.validatePriceAlertConfig(config);
    const id = generateIdV2();
    this.alertsV2.set(id, {
      kind: 'price',
      id,
      config,
      target: config.pairAddress,
      createdAt: Date.now(),
    });
    return id;
  }

  async createILAlert(config: ILAlertConfig): Promise<string> {
    this.validateILAlertConfig(config);
    const id = generateIdV2();
    this.alertsV2.set(id, {
      kind: 'il',
      id,
      config,
      target: config.pairAddress,
      createdAt: Date.now(),
    });
    return id;
  }

  async checkAlerts(address: string): Promise<Alert[]> {
    const results: Alert[] = [];
    const targetAlerts = Array.from(this.alertsV2.values())
      .filter(a => a.target === address && a.triggeredAt === undefined);

    for (const stored of targetAlerts) {
      const alert = await this.checkStoredAlert(stored);
      if (alert.triggered) {
        stored.triggeredAt = Date.now();
        results.push(alert);
      }
    }

    return results;
  }

  deleteAlert(alertId: string): void {
    if (!this.alertsV2.has(alertId)) {
      throw new ValidationError(`Alert not found: ${alertId}`);
    }
    this.alertsV2.delete(alertId);
  }

  async checkPriceAlert(
    config: PriceAlertConfig,
    id: string,
  ): Promise<PriceAlert> {
    this.validatePriceAlertConfig(config);

    const currentPrice = await this.getPoolPrice(
      config.pairAddress,
      config.tokenIn,
      config.tokenOut,
    );

    const triggered = config.direction === 'above'
      ? currentPrice >= config.thresholdPrice
      : currentPrice <= config.thresholdPrice;
    const status: AlertStatusV2 = triggered ? 'triggered' : 'active';

    return { id, type: 'price', config, currentPrice, status, triggered };
  }

  async checkILAlert(
    config: ILAlertConfig,
    id: string,
  ): Promise<ILAlert> {
    this.validateILAlertConfig(config);

    const pair = this.client.pair(config.pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    this.validatePairTokens(tokens, config.tokenA, config.tokenB);

    const isAToken0 = tokens.token0 === config.tokenA;
    const reserveA = isAToken0 ? reserve0 : reserve1;
    const reserveB = isAToken0 ? reserve1 : reserve0;

    if (reserveA === 0n || reserveB === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const currentPrice = (reserveB * PRICE_SCALE) / reserveA;
    const priceRatio = this.computePriceRatio(currentPrice, config.referencePrice);
    const currentILBps = this.computeImpermanentLossBps(priceRatio);

    const triggered = currentILBps >= config.maxImpermanentLossBps;
    const status: AlertStatusV2 = triggered ? 'triggered' : 'active';

    return {
      id,
      type: 'il',
      config,
      currentILBps,
      currentPrice,
      status,
      triggered,
    };
  }

  async checkHealthAlert(
    config: HealthAlertConfig,
    id: string,
  ): Promise<HealthAlert> {
    validateAddress(config.pairAddress, 'pairAddress');

    const pair = this.client.pair(config.pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const currentHealthScore = this.computeHealthScore(reserve0, reserve1);
    const status: AlertStatusV2 = 'active';
    const triggered = false;

    return { id, type: 'health', config, currentHealthScore, status, triggered };
  }

  async checkVolumeAlert(
    config: VolumeAlertConfig,
    id: string,
  ): Promise<VolumeAlert> {
    validateAddress(config.pairAddress, 'pairAddress');

    const pair = this.client.pair(config.pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const currentVolume = reserve0 + reserve1;
    const status: AlertStatusV2 = 'active';
    const triggered = false;

    return { id, type: 'volume', config, currentVolume, status, triggered };
  }

  private async checkStoredAlert(stored: StoredAlertV2): Promise<Alert> {
    switch (stored.kind) {
      case 'price':
        return this.checkPriceAlert(stored.config, stored.id);
      case 'il':
        return this.checkILAlert(stored.config, stored.id);
      case 'generic':
        return this.checkGenericStoredAlert(stored);
    }
  }

  private async checkGenericStoredAlert(
    stored: StoredGenericAlertV2,
  ): Promise<Alert> {
    switch (stored.config.type) {
      case 'price':
        return this.checkPriceFromStored(stored);
      case 'il':
        return this.checkILFromStored(stored);
      case 'health':
        return this.checkHealthFromStored(stored);
      case 'volume':
        return this.checkVolumeFromStored(stored);
    }
  }

  private async checkPriceFromStored(
    stored: StoredGenericAlertV2,
  ): Promise<PriceAlert> {
    const { target, threshold, direction } = stored.config;
    const pair = this.client.pair(target);
    const tokens = await pair.getTokens();

    const priceConfig: PriceAlertConfig = {
      tokenIn: tokens.token0,
      tokenOut: tokens.token1,
      pairAddress: target,
      thresholdPrice: BigInt(Math.round(threshold * 1_000_000_000_000_000)) * 1000n,
      direction,
    };

    return this.checkPriceAlert(priceConfig, stored.id);
  }

  private async checkILFromStored(stored: StoredGenericAlertV2): Promise<ILAlert> {
    const { target, threshold } = stored.config;
    const pair = this.client.pair(target);
    const tokens = await pair.getTokens();

    const { reserve0, reserve1 } = await pair.getReserves();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const referencePrice = (reserve1 * PRICE_SCALE) / reserve0;

    const ilConfig: ILAlertConfig = {
      tokenA: tokens.token0,
      tokenB: tokens.token1,
      pairAddress: target,
      referencePrice,
      maxImpermanentLossBps: Math.round(threshold),
    };

    return this.checkILAlert(ilConfig, stored.id);
  }

  private async checkHealthFromStored(
    stored: StoredGenericAlertV2,
  ): Promise<HealthAlert> {
    const { target } = stored.config;
    const config: HealthAlertConfig = { pairAddress: target };
    return this.checkHealthAlert(config, stored.id);
  }

  private async checkVolumeFromStored(
    stored: StoredGenericAlertV2,
  ): Promise<VolumeAlert> {
    const { target } = stored.config;
    const config: VolumeAlertConfig = { pairAddress: target };
    return this.checkVolumeAlert(config, stored.id);
  }

  private validateAlertConfigV2(config: AlertConfigV2): void {
    validateAddress(config.target, 'target');

    if (config.type === 'il') {
      this.validateBps(config.threshold, 'threshold');
    } else if (config.type === 'health') {
      this.validateBps(config.threshold, 'threshold');
    } else if (config.type === 'price') {
      if (config.threshold <= 0) {
        throw new InvalidThresholdError(config.type, config.threshold, 0, Infinity);
      }
    } else if (config.type === 'volume') {
      if (config.threshold <= 0) {
        throw new InvalidThresholdError(config.type, config.threshold, 0, Infinity);
      }
    }

    this.validateDirection(config.direction);
  }

  private validatePriceAlertConfig(config: PriceAlertConfig): void {
    validateAddress(config.tokenIn, 'tokenIn');
    validateAddress(config.tokenOut, 'tokenOut');
    validateAddress(config.pairAddress, 'pairAddress');
    validateDistinctTokens(config.tokenIn, config.tokenOut);
    validatePositiveAmount(config.thresholdPrice, 'thresholdPrice');
    this.validateDirection(config.direction);
  }

  private validateILAlertConfig(config: ILAlertConfig): void {
    validateAddress(config.tokenA, 'tokenA');
    validateAddress(config.tokenB, 'tokenB');
    validateAddress(config.pairAddress, 'pairAddress');
    validateDistinctTokens(config.tokenA, config.tokenB);
    validatePositiveAmount(config.referencePrice, 'referencePrice');
    this.validateBps(config.maxImpermanentLossBps, 'maxImpermanentLossBps');
  }

  private async getPoolPrice(
    pairAddress: string,
    tokenIn: string,
    tokenOut: string,
  ): Promise<bigint> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError('Pool has no liquidity');
    }

    const isTokenInToken0 = tokens.token0 === tokenIn;
    this.validatePairTokens(tokens, tokenIn, tokenOut);

    const reserveIn = isTokenInToken0 ? reserve0 : reserve1;
    const reserveOut = isTokenInToken0 ? reserve1 : reserve0;

    return (reserveOut * PRICE_SCALE) / reserveIn;
  }

  private computePriceRatio(
    currentPrice: bigint,
    referencePrice: bigint,
  ): bigint {
    return (currentPrice * PRICE_SCALE) / referencePrice;
  }

  private computeImpermanentLossBps(priceRatio: bigint): number {
    if (priceRatio <= 0n) return 0;

    const sqrtRatio = this.sqrt(priceRatio);
    const numerator = 2n * sqrtRatio * PRICE_SCALE_SQRT * BPS;
    const denominator = PRICE_SCALE + priceRatio;

    if (denominator === 0n) return 0;

    const poolFractionBps = numerator / denominator;
    const lossBps = poolFractionBps >= BPS ? 0 : Number(BPS - poolFractionBps);
    return lossBps;
  }

  private computeHealthScore(reserve0: bigint, reserve1: bigint): number {
    if (reserve0 === 0n || reserve1 === 0n) return 0;

    const smaller = reserve0 < reserve1 ? reserve0 : reserve1;
    const larger = reserve0 < reserve1 ? reserve1 : reserve0;

    return Number((smaller * BPS) / larger);
  }

  private validatePairTokens(
    tokens: { token0: string; token1: string },
    tokenA: string,
    tokenB: string,
  ): void {
    const hasA = tokens.token0 === tokenA || tokens.token1 === tokenA;
    const hasB = tokens.token0 === tokenB || tokens.token1 === tokenB;

    if (!hasA || !hasB) {
      throw new ValidationError('tokens do not match pair tokens', {
        tokenA,
        tokenB,
        token0: tokens.token0,
        token1: tokens.token1,
      });
    }
  }

  private validateDirection(direction: string): void {
    if (direction !== 'above' && direction !== 'below') {
      throw new ValidationError('direction must be above or below', { direction });
    }
  }

  private validateBps(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > Number(BPS)) {
      throw new ValidationError(`${name} must be an integer between 0 and 10000`, {
        [name]: value,
      });
    }
  }

  private sqrt(value: bigint): bigint {
    if (value < 0n) return 0n;
    if (value === 0n) return 0n;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + value / x) / 2n;
    }
    return x;
  }

  private generateId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private async transitionStatus(
    id: string,
    target: AlertStatus,
    allowedFrom: AlertStatus[],
  ): Promise<AlertInstance> {
    const instance = this.rules.get(id);
    if (!instance) {
      throw new CoralSwapSDKError(
        'ALERT_NOT_FOUND',
        `Alert ${id} not found`,
        { alertId: id },
      );
    }
    if (!allowedFrom.includes(instance.status)) {
      throw new CoralSwapSDKError(
        'INVALID_ALERT_TRANSITION',
        `Cannot transition alert ${id} from ${instance.status} to ${target}`,
        {
          alertId: id,
          currentStatus: instance.status,
          targetStatus: target,
        },
      );
    }

    const updated: AlertInstance = {
      ...instance,
      status: target,
    };

    if (target === 'fired') {
      updated.lastFiredAt = Math.floor(Date.now() / 1000);
      updated.fireCount = instance.fireCount + 1;
    }

    this.rules.set(id, updated);
    return updated;
  }
}

function generateIdV2(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
