import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8787;

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

const priceCache = new Map();
const PRICE_TTL = 60_000;

async function getPrice(chain, tokenAddress, symbol) {
  const key = `${chain}:${symbol}`;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pairs = data.pairs || [];
    const onChain = pairs.filter(p => (p.chainId || '').toLowerCase() === chain.toLowerCase());
    const pool = onChain.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
      || pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const price = pool ? parseFloat(pool.priceUsd) : 0;
    priceCache.set(key, { price, ts: Date.now() });
    return price;
  } catch { return 0; }
}

function getProvider(chain) {
  return new ethers.JsonRpcProvider(CHAIN_RPC[chain]);
}

async function getBalances() {
  const results = [];
  for (const wallet of WALLETS) {
    for (const [chain, tokens] of Object.entries(TOKENS)) {
      let provider;
      try { provider = getProvider(chain); } catch { continue; }
      let nativeBal = '0';
      try { nativeBal = ethers.formatEther(await provider.getBalance(wallet.address)); } catch {}
      const holding = { wallet: wallet.label, chain, native: parseFloat(nativeBal), tokens: [] };
      for (const tok of tokens) {
        try {
          const c = new ethers.Contract(tok.address, ERC20_ABI, provider);
          const bal = await c.balanceOf(wallet.address);
          const dec = await c.decimals();
          const amount = parseFloat(ethers.formatUnits(bal, dec));
          if (amount <= 0) continue;
          const price = await getPrice(chain, tok.address, tok.symbol);
          holding.tokens.push({ symbol: tok.symbol, amount, price, valueUsd: amount * price });
        } catch {}
      }
      if (holding.native > 0 || holding.tokens.length > 0) results.push(holding);
    }
  }
  return results;
}

app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/portfolio', async (req, res) => {
  try {
    const data = await getBalances();
    const byChain = {};
    let total = 0;
    for (const h of data) {
      const key = h.chain;
      if (!byChain[key]) byChain[key] = { chain: key, valueUsd: 0, wallets: [] };
      const walletValue = h.native + h.tokens.reduce((s, t) => s + t.valueUsd, 0);
      byChain[key].valueUsd += walletValue;
      byChain[key].wallets.push({ wallet: h.wallet, valueUsd: walletValue, native: h.native, tokens: h.tokens });
      total += walletValue;
    }
    res.json({ generatedAt: new Date().toISOString(), totalUsd: total, byChain: Object.values(byChain), raw: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Portfolio tracker running on http://localhost:${PORT}`);
});
