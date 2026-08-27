# Crypto Portfolio Tracker

Multi-wallet, multi-chain crypto portfolio tracker (Base + Robinhood Chain) with live balances and prices.

## Features
- **Live on-chain balances** — Base + Robinhood Chain (chainId 4663)
- **Live prices** — via DexScreener API (60s cache)
- **Labeled wallets** — Brian (`0x0088…40e5`) and myomoto (`0xddd4…9233`)
- **Chain-separated view** — see each chain's value + wallet breakdown
- Dark-theme web dashboard

## Architecture
- **Backend**: Node.js + Express + ethers — fetches balances/prices, serves `/api/portfolio`
- **Frontend**: static HTML/CSS/JS dashboard in `/public`

## Run locally
```bash
npm install
npm start        # serves on http://localhost:8787
```

## API
`GET /api/portfolio` → `{ generatedAt, totalUsd, byChain: [{ chain, valueUsd, wallets: [{ wallet, valueUsd, tokens: [{symbol, amount, price, valueUsd}] }] }] }`

## Wallets & Tokens
| Wallet | Label | Chain | Tokens |
|---|---|---|---|
| `0x0088…40e5` | Brian | base | STONKEX, BASEJUICE, QUOTRON |
| `0x0088…40e5` | Brian | robinhood | QUOTRON |
| `0xddd4…9233` | myomoto | — | (empty on tracked tokens) |

## Deploying
The server can be deployed to any Node host (Render, Railway, Fly.io). It needs outbound access to the Base RPC + DexScreener only — no API keys required.

## Note
Wallet addresses are hardcoded in `server/index.js`. Token addresses for new chains can be added to the `TOKENS` config.
