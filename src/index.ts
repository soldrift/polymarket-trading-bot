import { config, validateConfig, reloadConfig, getMissingFields } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { logger } from './logger.js';

class PolymarketCopyBot {
  private monitor: TradeMonitor;
  private wsMonitor?: WebSocketMonitor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private isRunning: boolean = false;
  private processedTrades: Set<string> = new Set();
  private botStartTime: number = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    totalVolume: 0,
  };

  constructor() {
    this.monitor = new TradeMonitor();
    this.executor = new TradeExecutor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
  }
  
  async initialize(): Promise<void> {
    logger.info('🤖 Polymarket Copy Trading Bot');
    logger.info('================================');
    logger.info(`Target wallet: ${config.targetWallet}`);
    logger.info(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    logger.info(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    logger.info(`Order type: ${config.trading.orderType}`);
    logger.info(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    if (config.risk.maxSessionNotional > 0 || config.risk.maxPerMarketNotional > 0) {
      logger.info(`Risk caps: session=${config.risk.maxSessionNotional || '∞'} USDC, per-market=${config.risk.maxPerMarketNotional || '∞'} USDC`);
    }
    logger.info(`Auth mode: EOA (signature type 0)`);
    logger.info('================================');

    validateConfig();

    this.botStartTime = Date.now();
    logger.info(`⏰ Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    logger.info('   (Only trades after this time will be copied)');

    await this.monitor.initialize();
    await this.executor.initialize();
    await this.reconcilePositions();

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const wsAuth = this.executor.getWsAuth();
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        await this.wsMonitor.initialize(this.handleNewTrade.bind(this), channel, wsAuth);
        logger.info(`✅ WebSocket monitor initialized (${channel} channel)`);

        if (channel === 'market' && config.monitoring.wsAssetIds.length > 0) {
          for (const assetId of config.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
        }

        if (channel === 'user' && config.monitoring.wsMarketIds.length > 0) {
          for (const marketId of config.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
        }
      } catch (error) {
        logger.warn('⚠️  WebSocket initialization failed, falling back to REST API only');
        logger.warn(`   Error: ${error}`);
        this.wsMonitor = undefined;
      }
    }
  }
  
  async start(): Promise<void> {
    this.isRunning = true;
    const monitoringMethods = [];
    if (this.wsMonitor) monitoringMethods.push('WebSocket');
    monitoringMethods.push('REST API');

    logger.info(`🚀 Bot started! Monitoring via: ${monitoringMethods.join(' + ')}`);

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error) {
        logger.error(`Error in monitoring loop: ${error}`);
      }

      await this.sleep(config.monitoring.pollInterval);
    }
  }
  
  private async handleNewTrade(trade: Trade): Promise<void> {
    if (trade.timestamp && trade.timestamp < this.botStartTime) {
      return;
    }

    const tradeKeys = this.getTradeKeys(trade);
    if (tradeKeys.some((key) => this.processedTrades.has(key))) {
      return;
    }

    for (const key of tradeKeys) {
      this.processedTrades.add(key);
    }
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    logger.info('='.repeat(50));
    logger.info(`🎯 NEW TRADE DETECTED`);
    logger.info(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    logger.info(`   Market: ${trade.market}`);
    logger.info(`   Side: ${trade.side} ${trade.outcome}`);
    logger.info(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    logger.info(`   Token ID: ${trade.tokenId}`);
    logger.info('='.repeat(50));

    if (trade.side === 'SELL') {
      logger.warn('⚠️  Skipping SELL trade (BUY-only safeguard enabled)');
      return;
    }

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }

    const copyNotional = this.executor.calculateCopySize(trade.size);
    const riskCheck = this.risk.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      logger.warn(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      return;
    }

    try {
      const result = await this.executor.executeCopyTrade(trade, copyNotional);
      this.risk.recordFill({
        trade,
        notional: result.copyNotional,
        shares: result.copyShares,
        price: result.price,
        side: result.side,
      });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      logger.info(`✅ Successfully copied trade!`);
      logger.info(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
    } catch (error: any) {
      this.stats.tradesFailed++;
      logger.error(`❌ Failed to copy trade`);
      if (error?.message) {
        logger.error(`   Reason: ${error.message}`);
      }
      logger.info(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
    }
  }

  private async reconcilePositions(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        logger.info('🧾 Positions: none found (fresh session)');
        return;
      }

      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      const totalNotional = this.positions.getTotalNotional();
      logger.info(`🧾 Positions loaded: ${loaded} (skipped ${skipped}), total notional ≈ ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      logger.warn(`🧾 Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }
  
  stop(): void {
    this.isRunning = false;

    if (this.wsMonitor) {
      this.wsMonitor.close();
    }

    logger.info('🛑 Bot stopped');
    this.printStats();
  }
  
  printStats(): void {
    logger.info('📊 Session Statistics:');
    logger.info(`   Trades detected: ${this.stats.tradesDetected}`);
    logger.info(`   Trades copied: ${this.stats.tradesCopied}`);
    logger.info(`   Trades failed: ${this.stats.tradesFailed}`);
    logger.info(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];

    if (trade.txHash) {
      keys.push(trade.txHash);
    }

    const fallbackKey = `${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`;
    keys.push(fallbackKey);

    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) {
      return;
    }

    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}

const RETRY_DELAY_MS = 10_000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let bot: PolymarketCopyBot | null = null;

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    bot?.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot?.stop();
    process.exit(0);
  });

  while (true) {
    reloadConfig();
    const missing = getMissingFields();

    if (missing.length > 0) {
      logger.warn(`⚙️  Missing required config: ${missing.join(', ')}`);
      logger.warn(`   Create a .env file based on .env.example and set the missing values.`);
      logger.warn(`   Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    try {
      bot = new PolymarketCopyBot();
      await bot.initialize();
      await bot.start();
    } catch (error: any) {
      logger.error(`Bot encountered an error: ${error?.message || error}`);
      logger.info(`Restarting in ${RETRY_DELAY_MS / 1000}s...`);
      bot?.stop();
      bot = null;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

main();
