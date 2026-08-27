/**
 * Snapshot script — fetches wallet balances + prices and writes public/data.json
 * Used by the GitHub Actions scheduled workflow (no server needed).
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

const TOKENS = {
  base: [
    { address: '0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5', symbol: 'STONKEX' },
    { address: '0xb200000000000000000000046390aed221043f01', symbol: 'BASEJUICE' },
    { address: '0x018F7D1F2B41eE02c5CB8286B0E955dde9DF49cb', symbol: 'QUOTRON' },
  ],
  robinhood: [
    { address: '0x5a86828Efd322bfb16d93cFeD16EE9BC14940D7F', symbol: 'QUOTRON' },
  ],
};

const CHAIN_RPC = {
  base: 'https://mainnet.base.org',
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function getPrice(chain, tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    const pairs = data.pairs || [];
    const onChain = pairs.filter(p => (p.chainId || '').toLowerCase() === chain.toLowerCase());
    const pool = onChain.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
      || pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return pool ? parseFloat(pool.priceUsd) : 0;
  } catch {
    return 0;
  }
}

async function run() {
  const byChain = {};
  let totalUsd = 0;

  for (const wallet of WALLETS) {
    for (const [chain, tokens] of Object.entries(TOKENS)) {
      let provider;
      try {
        provider = new ethers.JsonRpcProvider(CHAIN_RPC[chain]);
        await provider.getNetwork();
      } catch {
        continue;
      }

      let native = 0;
      try {
        native = parseFloat(ethers.formatEther(await provider.getBalance(wallet.address)));
      } catch {}

      const walletTokens = [];
      for (const tok of tokens) {
        try {
          const c = new ethers.Contract(tok.address, ERC20_ABI, provider);
          const [bal, dec] = await Promise.all([c.balanceOf(wallet.address), c.decimals()]);
          const amount = parseFloat(ethers.formatUnits(bal, dec));
          if (amount <= 0) continue;
          const price = await getPrice(chain, tok.address);
          walletTokens.push({ symbol: tok.symbol, amount, price, valueUsd: amount * price });
        } catch {}
      }

      const walletValue = native + walletTokens.reduce((s, t) => s + t.valueUsd, 0);
      if (native > 0 || walletTokens.length > 0) {
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
  console.log('Snapshot written:', OUT, '| total:', totalUsd);
}

run().catch(e => { console.error('Snapshot failed:', e.message); process.exit(1); });
