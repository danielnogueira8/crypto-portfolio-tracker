/**
 * Snapshot script v2 — auto-discovers wallet token holdings on-chain,
 * filters dust (>= $200 value), writes public/data.json.
 *
 * More reliable token fetching: combines a KNOWN_TOKENS list (guaranteed
 * coverage of main holdings) with light on-chain auto-discovery (finds
 * recently-touched new tokens), then prices via DexScreener.
 */
import { ethers } from 'ethers';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'data.json');

const WALLETS = [
  { label: 'Brian', address: '0x008808d79cc6b3893231d8a25208ffe1718a40e5' },
  { label: 'myomoto', address: '0xddd462bb053b57d5d73c9615e11a7284cfee9233' },
];

// Known token contracts per chain (guaranteed coverage of main holdings).
// Auto-discovery below adds any NEW tokens the wallet touches.
const KNOWN_TOKENS = {
  base: [
    '0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5', // STONKEX
    '0xb200000000000000000000046390aed221043f01', // BASEJUICE
    '0x018F7D1F2B41eE02c5CB8286B0E955dde9DF49cb', // QUOTRON
  ],
  robinhood: [
    '0x5a86828Efd322bfb16d93cFeD16EE9BC14940D7F', // QUOTRON
  ],
};

const CHAINS = [
  { chain: 'base', rpc: 'https://mainnet.base.org' },
  { chain: 'robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com' },
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Light discovery window — known tokens are always checked; this only finds
// recently-touched NEW tokens. Keep it small to avoid RPC rate limits.
const SCAN_BLOCKS = 20000; // ~2-3 hours on Base

// Only show tokens worth at least this (USD)
const MIN_TOKEN_VALUE_USD = 200;

// Price cache
const priceCache = new Map();
const PRICE_TTL = 15 * 60_000; // 15 min

async function getPrice(chain, tokenAddress) {
  const key = `${chain}:${tokenAddress.toLowerCase()}`;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    const pairs = data.pairs || [];
    const onChain = pairs.filter(p => (p.chainId || '').toLowerCase() === chain.toLowerCase());
    const pool = onChain.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
      || pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const price = pool ? parseFloat(pool.priceUsd) : 0;
    priceCache.set(key, { price, ts: Date.now() });
    return price;
  } catch {
    return 0;
  }
}

// Discover tokens a wallet has interacted with (recent blocks)
async function discoverTokens(provider, walletAddress) {
  const tokens = new Set();
  try {
    const latest = await provider.getBlockNumber();
    const zp = ethers.zeroPadValue;
    const fromBlock = Math.max(latest - SCAN_BLOCKS, 0);

    const inn = await provider.getLogs({
      fromBlock, toBlock: 'latest',
      topics: [TRANSFER_TOPIC, null, zp(walletAddress, 32)],
    });
    const out = await provider.getLogs({
      fromBlock, toBlock: 'latest',
      topics: [TRANSFER_TOPIC, zp(walletAddress, 32), null],
    });
    for (const l of [...inn, ...out]) tokens.add(l.address.toLowerCase());
  } catch (e) {
    console.error(`  discover error: ${e.message?.slice(0, 80)}`);
  }
  return [...tokens];
}

// Retry a promise with exponential backoff (handles Base RPC rate limits)
async function withRetry(fn, retries = 4, baseDelay = 800) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      const delay = baseDelay * 2 ** i;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function run() {
  const byChain = {};
  let totalUsd = 0;

  for (const { chain, rpc } of CHAINS) {
    let provider;
    try {
      provider = new ethers.JsonRpcProvider(rpc);
      await provider.getNetwork();
    } catch (e) {
      console.error(`chain ${chain} unreachable: ${e.message?.slice(0, 60)}`);
      continue;
    }

    for (const wallet of WALLETS) {
      // native balance
      let native = 0;
      try {
        native = parseFloat(ethers.formatEther(await provider.getBalance(wallet.address)));
      } catch {}

      // discover new tokens + merge with known tokens for guaranteed coverage
      const discovered = await discoverTokens(provider, wallet.address);
      const known = (KNOWN_TOKENS[chain] || []).map(a => a.toLowerCase());
      const tokenAddrs = [...new Set([...known, ...discovered])];
      const walletTokens = [];
      for (const tAddr of tokenAddrs) {
        try {
          const c = new ethers.Contract(tAddr, ERC20_ABI, provider);
          const [bal, sym, dec] = await withRetry(() => Promise.all([
            c.balanceOf(wallet.address), c.symbol(), c.decimals(),
          ]));
          const amount = parseFloat(ethers.formatUnits(bal, dec));
          if (amount <= 0) continue;
          const price = await getPrice(chain, tAddr);
          const valueUsd = amount * price;
          if (valueUsd < MIN_TOKEN_VALUE_USD) continue; // dust filter
          walletTokens.push({ symbol: sym || tAddr.slice(0, 6), address: tAddr, amount, price, valueUsd });
        } catch {
          /* non-standard token or persistent failure — skip */
        }
      }

      const walletValue = native + walletTokens.reduce((s, t) => s + t.valueUsd, 0);
      if (walletTokens.length > 0) {
        if (!byChain[chain]) byChain[chain] = { chain, valueUsd: 0, wallets: [] };
        byChain[chain].valueUsd += walletValue;
        byChain[chain].wallets.push({ wallet: wallet.label, valueUsd: walletValue, native, tokens: walletTokens });
        totalUsd += walletValue;
      }
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    totalUsd,
    byChain: Object.values(byChain),
  };

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log(`Snapshot written: ${OUT} | total: ${totalUsd.toFixed(2)}`);
}

run().catch(e => { console.error('Snapshot failed:', e.message); process.exit(1); });
