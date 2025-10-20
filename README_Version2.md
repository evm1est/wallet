```markdown
# MusicChain Wallet — Quick deploy + integration snippet

This repository contains a lightweight browser wallet (index.html, app.js, style.css) that can:
- create/import an encrypted wallet (stored in localStorage),
- accept ERC20 or native transfers across multiple chains (configurable),
- accept custom / unknown chain IDs (with RPC),
- expose a simple postMessage API so an external site (e.g. https://musicchain.netlify.app) can open the wallet popup and tell it where/which chain to send funds and request monitoring.  

Below is a short guide for deploying the wallet and how to integrate the site with it.

---

## Deploy the wallet (quick)
1. Host the repository static files (index.html, style.css, app.js) on any static hosting with HTTPS:
   - Netlify, Vercel, GitHub Pages, or a static server behind HTTPS are fine.
2. Ensure the final wallet URL is HTTPS and accessible, e.g.:
   - https://wallet.example.com/index.html
   - or GitHub Pages/Netlify URL for this repo.

Notes:
- The wallet uses ethers.js and JSON-RPC endpoints you supply for each chain. Custom chains require you to provide an RPC URL.
- This is a client-side wallet. The encrypted JSON is stored in localStorage (protected by the password you choose). Always use HTTPS and warn users to back up their seed phrases.

---

## Site integration (recommended flow)
Goal: from musicchain.netlify.app open the wallet popup, tell it the user's receiving address and chain, and optionally ask the wallet to monitor your payout address for incoming TXs.

1. Add the integration snippet to your site (see the file `musicchain-integration.js` in this repository).
2. Set `WALLET_URL` in that script to the deployed wallet index.html URL.

Essential flow:
- open popup → set_receive → start_monitor

Example usage on the site:
```js
// 1) Open the wallet popup
const popup = MusicChainIntegration.openWalletPopup(); // opens the wallet page at WALLET_URL

// 2) Tell the wallet what address & chain the site should send to
MusicChainIntegration.sendReceiveToWallet(popup, userReceiveAddress, chainId);

// 3) Optionally: tell the wallet to monitor your site payout address and selected chains
MusicChainIntegration.sendStartMonitor(popup, sitePayoutAddress, [137, 56]);
```

The integration helper provides:
- `openWalletPopup()` — opens the wallet popup window.
- `sendReceiveToWallet(popup, receiveAddress, chainId)` — repeatedly posts { action: 'set_receive', address, chainId } so the wallet receives it while loading.
- `sendStartMonitor(popup, siteAddress, chains)` — posts { action: 'start_monitor', siteAddress, chains } to ask the wallet to start monitoring incoming TXs from your payout address.
- `requestAddChain(popup, chainId, rpc, name)` — postMessage wrapper to add a custom chain programmatically in the wallet.

---

## postMessage formats (site → wallet)
- Set receive info:
```js
{
  action: 'set_receive',
  address: '0xabc...',   // receiver address (string)
  chainId: '137'         // chain id as string or number
}
```

- Start monitoring (wallet will select chains in its monitor UI and begin listening):
```js
{
  action: 'start_monitor',
  siteAddress: '0xSitePayoutAddress',
  chains: [137, 56]      // optional array of chainIds
}
```

- Add a chain (site can request the wallet add a custom/unknown chain before sending):
```js
{
  action: 'add_chain',
  chainId: '9999',
  rpc: 'https://rpc.example.org',
  name: 'MyCustomChain'
}
```

- Get wallet address (request):
```js
{ action: 'get_address' }
```
Wallet will reply with:
```js
{ action: 'address_response', address: '0x...' }
```

---

## postMessage formats (wallet → site)
When the wallet detects an incoming TX it will post:
```js
{
  type: 'incoming_tx',
  chainId: 137,
  tx: {
    type: 'ERC20' | 'Native' | 'SitePayment',
    from: '0x...',
    to: '0x...',
    token: '0xTokenAddress' | null,
    amount: '123.45',
    txHash: '0x...'
  }
}
```

Example site receiver for incoming notifications (secure origin check recommended):
```js
window.addEventListener('message', (ev) => {
  // validate origin in production
  // if (ev.origin !== 'https://your-wallet-host.example') return;

  const data = ev.data || {};
  if(data && data.type === 'incoming_tx') {
    console.log('Incoming tx from chain', data.chainId, data.tx);
    // update UI, mark order paid, etc.
  }
});
```

Important: In production always validate `ev.origin` to ensure messages come from your wallet host.

---

## Handling unknown / custom chains
- The wallet UI now lets users add unknown/custom chain IDs + RPC URLs via:
  - Manual input in "Chains configuration" → "Add unknown / custom chain", or
  - A postMessage from your site: `{ action: 'add_chain', chainId, rpc, name }`.
- Once a chain is added the wallet will include it in configured lists for receiving and monitoring.
- TXs that occur on chains not yet configured appear in the "Unknown / Custom Chains" activity column so the user can notice them; advise your site to call `add_chain` before sending on uncommon chains.

---

## Security & UX notes
- Always deploy the wallet over HTTPS.
- Validate postMessage origins in both site and wallet code.
- The wallet stores encrypted JSON in localStorage — the password you supply protects it. Encourage users to back up seed phrases securely.
- When adding custom RPCs/trusted chains, ensure the RPC endpoint is reliable (your site can provide an RPC for the user to add using `add_chain`).

---

## Next steps you might want
- Add this README.md to the repository (I can push it to `main` or create a branch + PR).
- Deploy the wallet static files and update `musicchain-integration.js`'s WALLET_URL to the deployed wallet URL.
- Update musicchain.netlify.app to call the flow above during checkout/payout.
```