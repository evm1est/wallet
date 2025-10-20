// MusicChain Multi-Chain Wallet - app.js
// Requires ethers (v5) loaded globally as ethers
// This script implements:
// - wallet creation/import/encrypt/decrypt (local encrypted JSON)
// - dynamic multi-chain configuration by user input (chainId or chainId:rpc)
// - providers created per configured chain
// - monitoring ERC20 Transfer events and native txs to the wallet across all configured chains
// - integration with https://musicchain.netlify.app via postMessage + window.opener
// - exposes window.MusicChainWallet API for the site to fetch address/links and request monitoring
(() => {
  const { ethers } = window;

  // default known chains (id, name, rpc fallback, explorer, native)
  const DEFAULT_CHAINS = {
    1:  { id:1,  name:'Ethereum Mainnet', rpc:'https://cloudflare-eth.com', explorer:'https://etherscan.io/tx/', native:'ETH' },
    5:  { id:5,  name:'Goerli (test)', rpc:'https://rpc.ankr.com/eth_goerli', explorer:'https://goerli.etherscan.io/tx/', native:'ETH' },
    56: { id:56, name:'BSC Mainnet', rpc:'https://bsc-dataseed.binance.org/', explorer:'https://bscscan.com/tx/', native:'BNB' },
    137:{ id:137,name:'Polygon', rpc:'https://polygon-rpc.com', explorer:'https://polygonscan.com/tx/', native:'MATIC' }
  };

  const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
  ];

  // DOM references
  const ui = {
    createWalletBtn: document.getElementById('create-wallet'),
    signupPassword: document.getElementById('signup-password'),
    mnemonic: document.getElementById('mnemonic'),
    importInput: document.getElementById('import-key'),
    importPwd: document.getElementById('import-password'),
    importBtn: document.getElementById('import-wallet'),
    encryptedJsonTextarea: document.getElementById('encrypted-json'),
    decryptPassword: document.getElementById('decrypt-password'),
    unlockBtn: document.getElementById('unlock-wallet'),
    downloadJsonBtn: document.getElementById('download-json'),
    dashboard: document.getElementById('dashboard'),
    address: document.getElementById('address'),
    copyAddressBtn: document.getElementById('copy-address'),
    showQrBtn: document.getElementById('show-qr'),
    chainSelect: document.getElementById('chain-select'),
    nativeBalance: document.getElementById('native-balance'),
    logoutBtn: document.getElementById('logout'),
    exportJsonBtn: document.getElementById('export-json'),
    receiveChain: document.getElementById('receive-chain'),
    receiveAddress: document.getElementById('receive-address'),
    receiveLink: document.getElementById('receive-link'),
    copyReceiveLink: document.getElementById('copy-receive-link'),
    siteAddress: document.getElementById('site-address'),
    monitorChains: document.getElementById('monitor-chains'),
    monitorTokens: document.getElementById('monitor-tokens'),
    startMonitor: document.getElementById('start-monitor'),
    stopMonitor: document.getElementById('stop-monitor'),
    activity: document.getElementById('activity'),
    sendTo: document.getElementById('send-to'),
    sendChain: document.getElementById('send-chain'),
    sendToken: document.getElementById('send-token'),
    sendAmount: document.getElementById('send-amount'),
    sendTxBtn: document.getElementById('send-tx'),
    chainsInput: document.getElementById('chains-input'),
    applyChainsBtn: document.getElementById('apply-chains'),
    receiveChainSelect: document.getElementById('receive-chain'),
    monitorChainsSelect: document.getElementById('monitor-chains'),
    sendChainSelect: document.getElementById('send-chain'),
    chainSelectMain: document.getElementById('chain-select')
  };

  // State
  let wallet = null;
  let encryptedJson = null;
  let configuredChains = {}; // chainId -> {id, name, rpc, explorer, native}
  let providers = {}; // chainId -> provider
  let monitors = {}; // chainId -> {pollHandle, tokenListeners[]}
  let seenTxs = new Set();

  // Helpers
  function saveEncryptedToLocalStorage(json){
    localStorage.setItem('musicchain:encrypted', json);
    ui.encryptedJsonTextarea.value = json;
    encryptedJson = json;
  }
  function getStoredEncrypted(){ return localStorage.getItem('musicchain:encrypted') || ''; }
  function copyToClipboard(text){ if(!text) return alert('Nothing to copy'); navigator.clipboard?.writeText(text).then(()=>alert('Copied')); }
  function short(addr){ if(!addr) return ''; return addr.slice(0,6)+'…'+addr.slice(-4); }

  function parseChainsInput(raw){
    // Accept newline or comma separated items. Each item: chainId or chainId:rpc
    const parts = raw.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
    const result = {};
    for(const p of parts){
      const [left, ...rest] = p.split(':');
      const chainIdStr = left.trim();
      if(!/^\d+$/.test(chainIdStr)) continue;
      const chainId = Number(chainIdStr);
      const rpc = rest.length ? rest.join(':').trim() : (DEFAULT_CHAINS[chainId] ? DEFAULT_CHAINS[chainId].rpc : null);
      const meta = DEFAULT_CHAINS[chainId] || { id:chainId, name:`Chain ${chainId}`, rpc: rpc || null, explorer: '', native: '' };
      meta.rpc = rpc || meta.rpc || null;
      result[chainId] = {...meta};
    }
    return result;
  }

  function ensureProvider(chainId){
    if(providers[chainId]) return providers[chainId];
    const cfg = configuredChains[chainId];
    if(!cfg || !cfg.rpc) throw new Error('No RPC configured for chain ' + chainId);
    const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
    providers[chainId] = provider;
    return provider;
  }

  function applyChainsToUI(){
    // clear selects
    [ui.chainSelectMain, ui.receiveChainSelect, ui.monitorChainsSelect, ui.sendChainSelect].forEach(sel=>{
      while(sel.firstChild) sel.removeChild(sel.firstChild);
    });
    Object.values(configuredChains).forEach(cfg=>{
      const opts = [
        ui.chainSelectMain,
        ui.receiveChainSelect,
        ui.sendChainSelect
      ];
      opts.forEach(sel=>{
        const o = document.createElement('option');
        o.value = cfg.id;
        o.textContent = `${cfg.name} (${cfg.id})`;
        sel.appendChild(o);
      });
      // monitor multi-select
      const o2 = document.createElement('option');
      o2.value = cfg.id;
      o2.textContent = `${cfg.name} (${cfg.id})`;
      ui.monitorChainsSelect.appendChild(o2);
    });
    // default selections
    if(Object.keys(configuredChains).length){
      ui.chainSelectMain.value = Object.keys(configuredChains)[0];
      ui.receiveChainSelect.value = Object.keys(configuredChains)[0];
      ui.sendChainSelect.value = Object.keys(configuredChains)[0];
      updateReceiveAddress();
      updateBalanceForSelectedChain();
    }
  }

  // Wallet management
  async function createNewWallet(){
    const pwd = ui.signupPassword.value;
    if(!pwd) return alert('Provide a password to encrypt the wallet locally.');
    const newWallet = ethers.Wallet.createRandom();
    wallet = newWallet;
    ui.mnemonic.classList.remove('hidden');
    ui.mnemonic.textContent = 'MNEMONIC (save this safely):\n' + newWallet.mnemonic.phrase;
    const encrypted = await newWallet.encrypt(pwd);
    saveEncryptedToLocalStorage(encrypted);
    showDashboard();
    populateAddressUI();
  }

  async function importKey(){
    const raw = ui.importInput.value.trim();
    const pwd = ui.importPwd.value || prompt('Enter a password to encrypt the imported wallet locally (required)');
    if(!raw || !pwd) return alert('Provide mnemonic or private key and a password.');
    try {
      let w;
      if(raw.split(' ').length >= 12){
        w = ethers.Wallet.fromMnemonic(raw);
      } else {
        w = new ethers.Wallet(raw);
      }
      wallet = w;
      const encrypted = await wallet.encrypt(pwd);
      saveEncryptedToLocalStorage(encrypted);
      ui.mnemonic.classList.remove('hidden');
      ui.mnemonic.textContent = 'IMPORTED ADDRESS: ' + wallet.address + '\n(Backup your seed/private key securely)';
      showDashboard();
      populateAddressUI();
    } catch (err){
      console.error(err);
      alert('Import failed: ' + (err.message || err));
    }
  }

  async function unlockEncryptedJson(){
    const json = ui.encryptedJsonTextarea.value.trim();
    const pwd = ui.decryptPassword.value;
    if(!json || !pwd) return alert('Provide encrypted JSON and password');
    try {
      const w = await ethers.Wallet.fromEncryptedJson(json, pwd);
      wallet = w;
      encryptedJson = json;
      saveEncryptedToLocalStorage(json);
      ui.mnemonic.classList.remove('hidden');
      ui.mnemonic.textContent = 'Unlocked address: ' + wallet.address;
      showDashboard();
      populateAddressUI();
    } catch (err){
      console.error(err);
      alert('Failed to decrypt: ' + (err.message || err));
    }
  }

  function exportEncryptedJson(){
    if(!getStoredEncrypted()) return alert('No encrypted wallet stored');
    const json = getStoredEncrypted();
    const blob = new Blob([json], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `musicchain-wallet-${wallet ? wallet.address : 'wallet'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function logout(){
    wallet = null;
    ui.dashboard.classList.add('hidden');
    ui.mnemonic.classList.add('hidden');
    ui.mnemonic.textContent = '';
    ui.activity.innerHTML = '';
    stopMonitoring();
    alert('Logged out. Encrypted JSON remains in local storage.');
  }

  function showDashboard(){ ui.dashboard.classList.remove('hidden'); }

  function populateAddressUI(){
    if(!wallet) return;
    ui.address.textContent = wallet.address;
    updateReceiveAddress();
    updateBalanceForSelectedChain();
  }

  // Receive link creation
  function updateReceiveAddress(){
    const chainId = ui.receiveChainSelect.value || Object.keys(configuredChains)[0];
    ui.receiveAddress.textContent = wallet ? wallet.address : 'Unlock wallet to see address';
    const link = new URL('https://musicchain.netlify.app/');
    link.searchParams.set('receive_to', wallet ? wallet.address : '');
    link.searchParams.set('chain', chainId);
    ui.receiveLink.value = link.toString();
  }

  async function updateBalanceForSelectedChain(){
    if(!wallet) return;
    const chainId = ui.chainSelectMain.value;
    const cfg = configuredChains[chainId];
    if(!cfg) { ui.nativeBalance.textContent = '—'; return; }
    try {
      const provider = ensureProvider(chainId);
      const bal = await provider.getBalance(wallet.address);
      ui.nativeBalance.textContent = ethers.utils.formatEther(bal) + ' ' + (cfg.native || '');
    } catch (err){
      console.warn('Balance fetch failed', err);
      ui.nativeBalance.textContent = 'Error';
    }
  }

  // Monitoring logic
  function recordActivity(chainId, info){
    // de-duplicate by txHash
    if(info.txHash && seenTxs.has(info.txHash)) return;
    if(info.txHash) seenTxs.add(info.txHash);
    const cfg = configuredChains[chainId] || { name:`Chain ${chainId}`, explorer:'' };
    const li = document.createElement('li');
    const when = new Date().toLocaleString();
    li.innerHTML = `<strong>${info.type || 'Transfer'}</strong> — ${when}<div>Chain: ${cfg.name}</div>
      <div>From: ${short(info.from)} → To: ${short(info.to)}</div>
      <div>Token: ${info.token || cfg.native || 'NATIVE'} — Amount: ${info.amount || '—'}</div>
      ${info.txHash ? `<div>TX: <a class="txhash" href="${cfg.explorer}${info.txHash}" target="_blank">${info.txHash}</a></div>` : ''}
      `;
    ui.activity.prepend(li);

    // Notify parent site (musicchain) about the incoming tx if it exists as a known origin or opener
    const msg = { type:'incoming_tx', chainId, tx: info };
    // attempt to postMessage to the known site origin
    try {
      // primary: notify window.opener if it exists
      if(window.opener && !window.opener.closed){
        window.opener.postMessage(msg, '*');
      }
      // also post to top-level parent
      window.parent.postMessage(msg, '*');
      // and to a known origin
      const targetOrigin = 'https://musicchain.netlify.app';
      window.postMessage(msg, targetOrigin);
    } catch(e){}
  }

  async function subscribeTokenTransfer(chainId, tokenAddr){
    try {
      const provider = ensureProvider(chainId);
      const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
      // historical scan (last ~5000 blocks) and attach listener
      const block = await provider.getBlockNumber();
      const fromBlock = Math.max(0, block - 5000);
      try {
        const logs = await provider.getLogs({
          fromBlock,
          toBlock: block,
          address: tokenAddr,
          topics: [ethers.utils.id("Transfer(address,address,uint256)"), null, ethers.utils.hexZeroPad(wallet.address,32)]
        });
        for(const log of logs){
          try {
            const parsed = contract.interface.parseLog(log);
            const from = parsed.args.from;
            const to = parsed.args.to;
            const value = parsed.args.value;
            const decimals = await contract.decimals().catch(()=>18);
            const amt = ethers.utils.formatUnits(value, decimals);
            recordActivity(chainId, { type:'ERC20', token:tokenAddr, from, to, amount:amt, txHash:log.transactionHash });
          } catch(e){}
        }
      } catch(e){ /* ignore history errors */ }

      // live event listener
      const listener = (from, to, value, event) => {
        (async ()=>{
          const decimals = await contract.decimals().catch(()=>18);
          const amt = ethers.utils.formatUnits(value, decimals);
          recordActivity(chainId, { type:'ERC20', token:tokenAddr, from, to, amount:amt, txHash:event.transactionHash });
        })();
      };
      contract.on(contract.filters.Transfer(null, wallet.address), listener);
      // store unsubscribe
      if(!monitors[chainId]) monitors[chainId] = { tokenListeners: [], pollHandle: null };
      monitors[chainId].tokenListeners.push(()=>contract.off(contract.filters.Transfer(null, wallet.address), listener));
    } catch(err){
      console.warn('subscribeTokenTransfer failed', err);
    }
  }

  function startMonitoring(){
    if(!wallet) return alert('Unlock your wallet first to monitor incoming transfers.');
    const selectedOptions = Array.from(ui.monitorChainsSelect.selectedOptions).map(o=>o.value);
    if(selectedOptions.length === 0) return alert('Select at least one chain to monitor.');
    const tokensRaw = ui.monitorTokens.value.trim();
    const tokens = tokensRaw ? tokensRaw.split(',').map(t=>t.trim()).filter(Boolean) : null;
    const siteAddr = ui.siteAddress.value.trim() || null;

    selectedOptions.forEach(chainId => {
      if(monitors[chainId]) return; // already monitoring
      const provider = ensureProvider(chainId);

      monitors[chainId] = { tokenListeners: [], pollHandle: null };

      // If tokens specified, subscribe to them
      if(tokens && tokens.length){
        tokens.forEach(tok => subscribeTokenTransfer(chainId, tok));
      } else {
        // scan logs for Transfer events to this address (discover tokens) and subscribe dynamically
        (async ()=>{
          try {
            const block = await provider.getBlockNumber();
            const fromBlock = Math.max(0, block - 5000);
            const topic = ethers.utils.id('Transfer(address,address,uint256)');
            const toTopic = ethers.utils.hexZeroPad(wallet.address,32);
            const logs = await provider.getLogs({ fromBlock, toBlock:block, topics:[topic, null, toTopic] });
            const seenContracts = new Set(logs.map(l => l.address));
            seenContracts.forEach(addr => subscribeTokenTransfer(chainId, addr));
          } catch(e){
            // some RPCs block getLogs; ignore
          }
        })();
      }

      // Poll latest blocks to find native txs and site-originated txs
      (async ()=>{
        let polledBlock = null;
        const poll = setInterval(async ()=>{
          try {
            const block = await provider.getBlockWithTransactions('latest');
            if(polledBlock === null) polledBlock = block.number - 1;
            if(block.number <= polledBlock) return;
            for(let b = polledBlock+1; b <= block.number; b++){
              try {
                const full = await provider.getBlockWithTransactions(b);
                for(const tx of full.transactions){
                  // native incoming
                  if(tx.to && tx.to.toLowerCase() === wallet.address.toLowerCase()){
                    recordActivity(chainId, { type:'Native', from:tx.from, to:tx.to, amount:ethers.utils.formatEther(tx.value), txHash:tx.hash });
                  }
                  // site-originated (if provided)
                  if(siteAddr && tx.from && tx.from.toLowerCase() === siteAddr.toLowerCase() && tx.to && tx.to.toLowerCase() === wallet.address.toLowerCase()){
                    recordActivity(chainId, { type:'SitePayment', from:tx.from, to:tx.to, amount:ethers.utils.formatEther(tx.value), txHash:tx.hash });
                  }
                }
              } catch(e){}
            }
            polledBlock = block.number;
          } catch(e){}
        }, 7000);
        monitors[chainId].pollHandle = poll;
      })();
    });

    ui.stopMonitor.classList.remove('hidden');
    ui.startMonitor.classList.add('hidden');
    alert('Monitoring started on selected chains. Activity will appear here.');
  }

  function stopMonitoring(){
    Object.keys(monitors).forEach(chainId => {
      const mon = monitors[chainId];
      if(!mon) return;
      if(mon.tokenListeners) mon.tokenListeners.forEach(off => {
        try { off(); } catch(e){}
      });
      if(mon.pollHandle) clearInterval(mon.pollHandle);
      delete monitors[chainId];
    });
    ui.stopMonitor.classList.add('hidden');
    ui.startMonitor.classList.remove('hidden');
  }

  // Sending (optional)
  async function sendTx(){
    if(!wallet) return alert('Unlock wallet to send transactions.');
    const to = ui.sendTo.value.trim();
    const chainId = ui.sendChainSelect.value;
    const token = ui.sendToken.value.trim();
    const amount = ui.sendAmount.value.trim();
    if(!to || !chainId || !amount) return alert('Provide to address, chain and amount.');
    try {
      const provider = ensureProvider(chainId);
      const signer = wallet.connect(provider);
      if(!token){
        const tx = await signer.sendTransaction({ to, value: ethers.utils.parseEther(amount) });
        alert('Sent native tx: ' + tx.hash);
      } else {
        const contract = new ethers.Contract(token, ERC20_ABI, signer);
        const decimals = await contract.decimals();
        const scaled = ethers.utils.parseUnits(amount, decimals);
        const tx = await contract.transfer(to, scaled);
        alert('ERC20 transfer tx hash: ' + tx.hash);
      }
    } catch(err){
      console.error(err);
      alert('Send failed: ' + (err.message||err));
    }
  }

  // QR & UI helpers
  function showQR(){
    if(!wallet) return alert('Unlock wallet first');
    const receiveLink = ui.receiveLink.value;
    const url = 'https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=' + encodeURIComponent(receiveLink);
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-card"><button class="close">✕</button><img src="${url}" style="width:100%;max-width:300px;border-radius:8px"/></div>`;
    document.body.appendChild(modal);
    modal.querySelector('.close').addEventListener('click', ()=>document.body.removeChild(modal));
  }

  // PostMessage integration with musicchain.netlify.app
  window.addEventListener('message', (ev) => {
    // Accept messages from the site or any trusted origin. For security, validate origin in production.
    const data = ev.data || {};
    if(!data || typeof data !== 'object') return;
    // Example actions:
    // { action: 'set_receive', address: '0x..', chainId: '137' }
    // { action: 'start_monitor', siteAddress: '0x..', chains: [137,56] }
    if(data.action === 'set_receive'){
      if(data.address) ui.receiveAddress.textContent = data.address;
      if(data.chainId) ui.receiveChainSelect.value = String(data.chainId);
      updateReceiveAddress();
    } else if(data.action === 'start_monitor'){
      if(data.siteAddress) ui.siteAddress.value = data.siteAddress;
      if(Array.isArray(data.chains) && data.chains.length){
        // select those chains in monitor select
        Array.from(ui.monitorChainsSelect.options).forEach(opt=>{
          opt.selected = data.chains.includes(Number(opt.value));
        });
      }
      startMonitoring();
    } else if(data.action === 'get_address'){
      const reply = { action:'address_response', address: wallet ? wallet.address : null };
      ev.source.postMessage(reply, ev.origin || '*');
    }
  });

  // Expose API for embedding site
  window.MusicChainWallet = {
    getConfiguredChains: () => Object.values(configuredChains),
    getAddress: () => wallet ? wallet.address : null,
    getReceiveLink: () => ui.receiveLink.value || null,
    startMonitoringFromSite: (siteAddress, chainIds) => {
      if(siteAddress) ui.siteAddress.value = siteAddress;
      if(Array.isArray(chainIds)){
        Array.from(ui.monitorChainsSelect.options).forEach(opt=>{
          opt.selected = chainIds.includes(Number(opt.value));
        });
      } else {
        // select all if not specified
        Array.from(ui.monitorChainsSelect.options).forEach(opt=>opt.selected = true);
      }
      startMonitoring();
    }
  };

  // Wire UI
  function initUI(){
    // populate default configuredChains initially with DEFAULT_CHAINS
    configuredChains = {...DEFAULT_CHAINS};
    applyChainsToUI();

    // menu toggle
    document.getElementById('menu-toggle').addEventListener('click', ()=>document.getElementById('nav-links').classList.toggle('open'));

    ui.createWalletBtn.addEventListener('click', createNewWallet);
    ui.importBtn.addEventListener('click', importKey);
    ui.unlockBtn.addEventListener('click', unlockEncryptedJson);
    ui.downloadJsonBtn.addEventListener('click', exportEncryptedJson);
    ui.copyAddressBtn.addEventListener('click', ()=>copyToClipboard(wallet ? wallet.address : ''));
    ui.showQrBtn.addEventListener('click', showQR);
    ui.chainSelectMain.addEventListener('change', updateBalanceForSelectedChain);
    ui.receiveChainSelect.addEventListener('change', updateReceiveAddress);
    ui.copyReceiveLink.addEventListener('click', ()=>copyToClipboard(ui.receiveLink.value));
    ui.startMonitor.addEventListener('click', startMonitoring);
    ui.stopMonitor.addEventListener('click', stopMonitoring);
    ui.logoutBtn.addEventListener('click', logout);
    ui.exportJsonBtn.addEventListener('click', exportEncryptedJson);
    ui.sendTxBtn.addEventListener('click', sendTx);
    ui.applyChainsBtn.addEventListener('click', ()=>{
      const raw = ui.chainsInput.value.trim();
      if(!raw) return alert('Enter chain IDs (and optional RPCs).');
      const parsed = parseChainsInput(raw);
      // merge parsed into configuredChains (override defaults)
      configuredChains = {...configuredChains, ...parsed};
      // clear providers for removed chains
      providers = {};
      applyChainsToUI();
      alert('Chains applied. You can now select them for monitoring and receiving.');
    });

    // load encrypted json if found
    const stored = getStoredEncrypted();
    if(stored) ui.encryptedJsonTextarea.value = stored;
  }

  // Init
  initUI();

  // Auto-select first chain in selects
  const firstChain = Object.keys(configuredChains)[0];
  if(firstChain){
    ui.chainSelectMain.value = firstChain;
    ui.receiveChainSelect.value = firstChain;
    ui.sendChainSelect.value = firstChain;
  }
  updateReceiveAddress();

  // Expose a method to let the site open the wallet in a popup and send commands via window.opener
  console.info('MusicChain Multi-Chain Wallet ready. Use window.MusicChainWallet API or postMessage to integrate.');

})();