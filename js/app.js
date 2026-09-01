import { createClient } from '@supabase/supabase-js';

let totalItems = 100;
let itemsPerPage = 4;
let itemPrefix = '#';
let totalPages = Math.ceil(totalItems / itemsPerPage);

const DEFAULT_SB_URL = 'https://kowsnqqznjgpfsumgsir.supabase.co';
const DEFAULT_SB_KEY = 'sb_publishable_7UW1aict4fPrLAdrPCLvaQ_4j0acB_J';

let currentPage = 1;
let reservations = {};
let supabase = null;
let syncEnabled = false;
let renderTimeout = null;
let isAppEnabled = false;
let adminClickCount = 0;
let enabledPages = new Set();
let pageTimers = {}; // pageNum -> startTime
let timerInterval = null;
let serverClockOffsetMs = 0;
let hasServerClock = false;

const TIMER_OFFSET = 10000;
const TIMER_DURATION = 3000;

function getEl(id) {
  return document.getElementById(id);
}

function getAuthoritativeNow() {
  if (syncEnabled && hasServerClock) return Date.now() + serverClockOffsetMs;
  return Date.now();
}

async function syncServerClock() {
  if (!syncEnabled || !supabase) return false;

  const requestStartedAt = Date.now();
  const { data, error } = await supabase.rpc('server_time_ms');
  const responseReceivedAt = Date.now();

  if (error) {
    console.error('Server clock sync failed:', error);
    return false;
  }

  const serverTime = Number(data);
  if (!Number.isFinite(serverTime)) {
    console.error('Server clock sync returned an invalid value:', data);
    return false;
  }

  // Estimate the browser time at the midpoint of the request. This removes
  // local clock skew while keeping network-latency error to roughly half RTT.
  const browserMidpoint = (requestStartedAt + responseReceivedAt) / 2;
  serverClockOffsetMs = serverTime - browserMidpoint;
  hasServerClock = true;
  return true;
}

// --- Storage Logic ---

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { console.warn("LocalStorage error", e); }
}

async function init() {
  setupAdminTrigger();
  loadSupabaseConfig();
  
  const savedTotalItems = safeGet('total_items');
  if (savedTotalItems) {
    totalItems = parseInt(savedTotalItems);
  }
  const totalInput = getEl('total-items');
  if (totalInput) totalInput.value = totalItems;

  const savedItemPrefix = safeGet('item_prefix');
  if (savedItemPrefix !== null) {
    itemPrefix = savedItemPrefix;
  }
  const prefixInput = getEl('item-prefix');
  if (prefixInput) prefixInput.value = itemPrefix;

  const savedItemsPerPage = safeGet('items_per_page');
  if (savedItemsPerPage) {
    itemsPerPage = parseInt(savedItemsPerPage);
    const selector = getEl('items-per-page');
    if (selector) selector.value = itemsPerPage;
  }
  
  totalPages = Math.ceil(totalItems / itemsPerPage);
  const pagesInput = getEl('total-pages');
  if (pagesInput) pagesInput.value = totalPages;
  
  const savedIGN = safeGet('guild_ign') || '';
  const globalInput = getEl('global-ign');
  if (globalInput) globalInput.value = savedIGN;
  
  if (syncEnabled) {
    await connectSupabase();
  } else {
    loadLocalData();
    updateSyncStatus('local');
  }
  
  renderItems();
  renderSummary();
}


function loadLocalData() {
  try {
    const saved = safeGet('guild_claims');
    reservations = saved ? JSON.parse(saved) : {};
    
    // Identify timers in local data
    pageTimers = {};
    for (const key in reservations) {
      const id = parseInt(key);
      if (id >= TIMER_OFFSET) {
        pageTimers[id - TIMER_OFFSET] = parseInt(reservations[key]);
        delete reservations[key];
      } else if (id === 999) {
        delete reservations[key];
      }
    }

    const now = getAuthoritativeNow();
    for (const pageNum in pageTimers) {
      if (now - pageTimers[pageNum] >= TIMER_DURATION) {
        enabledPages.add(parseInt(pageNum));
      } else {
        startGlobalTimer();
      }
    }
  } catch (e) {
    reservations = {};
  }
}

function updateSyncStatus(mode, msg = '') {
  const statusEl = getEl('sync-status');
  if (!statusEl) return;
  
  statusEl.className = 'sync-status';
  if (mode === 'online') {
    statusEl.classList.add('status-online');
    statusEl.textContent = '● Mode: Cloud Sync (Online)';
  } else if (mode === 'error') {
    statusEl.classList.add('status-error');
    statusEl.textContent = `● Mode: Sync Error (${msg})`;
  } else {
    statusEl.classList.add('status-local');
    statusEl.textContent = '● Mode: Local Storage';
  }
}

// --- Supabase Integration ---

function getSupabaseConfig() {
  const url = safeGet('sb_url');
  const key = safeGet('sb_key');
  return {
    url: url !== null ? url : DEFAULT_SB_URL,
    key: key !== null ? key : DEFAULT_SB_KEY
  };
}

function loadSupabaseConfig() {
  const { url, key } = getSupabaseConfig();
  syncEnabled = !!(url && key);
  
  const urlInp = getEl('supabase-url');
  const keyInp = getEl('supabase-key');
  if (urlInp) urlInp.value = url || '';
  if (keyInp) keyInp.value = key || '';
}

async function saveSupabaseConfig() {
  const url = getEl('supabase-url').value.trim();
  const key = getEl('supabase-key').value.trim();
  
  safeSet('sb_url', url);
  safeSet('sb_key', key);
  
  alert("Settings saved. Reconnecting...");
  location.reload();
}
window.saveSupabaseConfig = saveSupabaseConfig;

async function connectSupabase() {
  const { url, key } = getSupabaseConfig();
  
  try {
    supabase = createClient(url, key);

    const clockSynced = await syncServerClock();
    if (!clockSynced) {
      throw new Error('Server timer functions are not installed. Run supabase-timer.sql in Supabase SQL Editor.');
    }
    
    // Initial fetch
    const { data, error } = await supabase
      .from('reservations')
      .select('*');
      
    if (error) throw error;
    
    // Convert array to object mapping
    reservations = {};
    pageTimers = {};
    data.forEach(row => {
      if (row.item_id === 0) {
        applyRemoteConfig(row.ign);
      } else if (row.item_id >= TIMER_OFFSET) {
        pageTimers[row.item_id - TIMER_OFFSET] = parseInt(row.ign);
      } else if (row.item_id !== 999) {
        reservations[row.item_id] = row.ign;
      }
    });

    // Check expired timers
    const now = getAuthoritativeNow();
    for (const pageNum in pageTimers) {
      if (now - pageTimers[pageNum] >= TIMER_DURATION) {
        enabledPages.add(parseInt(pageNum));
      } else {
        startGlobalTimer();
      }
    }

    updateSyncStatus('online');
    
    // Real-time subscription
    supabase
      .channel('schema-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, payload => {
        handleRemoteChange(payload);
      })
      .subscribe();
      
  } catch (err) {
    console.error("Supabase connection failed:", err);
    updateSyncStatus('error', err.message);
    loadLocalData();
  }
}

function handleRemoteChange(payload) {
  if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
    if (payload.new.item_id === 0) {
      applyRemoteConfig(payload.new.ign);
    } else if (payload.new.item_id >= TIMER_OFFSET) {
      const pageNum = payload.new.item_id - TIMER_OFFSET;
      const startTime = parseInt(payload.new.ign);
      pageTimers[pageNum] = startTime;
      if (getAuthoritativeNow() - startTime < TIMER_DURATION) {
        startGlobalTimer();
      } else {
        enabledPages.add(pageNum);
      }
    } else {
      reservations[payload.new.item_id] = payload.new.ign;
    }
  } else if (payload.eventType === 'DELETE') {
    if (payload.old.item_id >= TIMER_OFFSET) {
      const pageNum = payload.old.item_id - TIMER_OFFSET;
      delete pageTimers[pageNum];
      enabledPages.delete(pageNum);
    } else if (payload.old.item_id !== 0) {
      delete reservations[payload.old.item_id];
    }
  }
  
  // Debounce rendering for high concurrency
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    renderItems();
    renderSummary();
    renderTimeout = null;
  }, 100);
}

function applyRemoteConfig(configStr) {
  try {
    const config = JSON.parse(configStr);
    let changed = false;

    if (config.totalItems && config.totalItems !== totalItems) {
      totalItems = config.totalItems;
      safeSet('total_items', totalItems);
      const totalInput = getEl('total-items');
      if (totalInput) totalInput.value = totalItems;
      changed = true;
    }

    if (config.itemsPerPage && config.itemsPerPage !== itemsPerPage) {
      itemsPerPage = config.itemsPerPage;
      safeSet('items_per_page', itemsPerPage);
      const selector = getEl('items-per-page');
      if (selector) selector.value = itemsPerPage;
      changed = true;
    }

    if (config.itemPrefix !== undefined && config.itemPrefix !== itemPrefix) {
      itemPrefix = config.itemPrefix;
      safeSet('item_prefix', itemPrefix);
      const prefixInput = getEl('item-prefix');
      if (prefixInput) prefixInput.value = itemPrefix;
      changed = true;
    }

    if (changed) {
      totalPages = Math.ceil(totalItems / itemsPerPage);
      const pagesInput = getEl('total-pages');
      if (pagesInput) pagesInput.value = totalPages;
      
      const totalItemsInput = getEl('total-items');
      if (totalItemsInput) totalItemsInput.value = totalItems;

      renderItems();
      renderSummary();
    }
  } catch (e) {
    console.warn("Failed to parse remote config", e);
  }
}

async function persistConfig() {
  if (syncEnabled && supabase) {
    const config = { 
      totalItems, 
      itemsPerPage, 
      itemPrefix 
    };
    const { error } = await supabase
      .from('reservations')
      .upsert({ item_id: 0, ign: JSON.stringify(config) });
    if (error) console.error("Sync config failed:", error);
  }
}

async function persistReservation(itemId, ign) {
  if (syncEnabled && supabase) {
    const { error } = await supabase
      .from('reservations')
      .upsert({ item_id: itemId, ign: ign });
    if (error) {
      alert("Sync failed: " + error.message);
      return false;
    }
  }
  reservations[itemId] = ign;
  safeSet('guild_claims', JSON.stringify(reservations));
  return true;
}

async function deleteReservation(itemId) {
  if (syncEnabled && supabase) {
    const { error } = await supabase
      .from('reservations')
      .delete()
      .eq('item_id', itemId);
    if (error) {
      alert("Sync failed: " + error.message);
      return false;
    }
  }
  delete reservations[itemId];
  safeSet('guild_claims', JSON.stringify(reservations));
  return true;
}

async function clearAllReservations() {
  if (syncEnabled && supabase) {
    const { error } = await supabase
      .from('reservations')
      .delete()
      .neq('item_id', 0); 
    if (error) {
      alert("Sync failed: " + error.message);
      return false;
    }
  }
  reservations = {};
  pageTimers = {};
  enabledPages.clear();
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  localStorage.removeItem('guild_claims');
  return true;
}

// --- UI Logic ---

function setupAdminTrigger() {
  const trigger = getEl('admin-trigger');
  if (trigger) {
    trigger.addEventListener('click', () => {
      adminClickCount++;
      if (adminClickCount >= 10) {
        getEl('admin-actions')?.classList.toggle('hidden');
        getEl('config-section')?.classList.toggle('hidden');
        adminClickCount = 0;
        renderItems(); 
      }
    });
  }
}

function renderItems() {
  const container = getEl('items-container');
  if (!container) return;
  container.innerHTML = '';
  
  updateTimerButton();

  const isPageEnabled = enabledPages.has(currentPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
  
  for (let i = startIndex; i < endIndex; i++) {
    const itemId = i + 1;
    const claimedBy = reservations[itemId];
    const isReserved = !!claimedBy;
    const isAdminOpen = !getEl('admin-actions')?.classList.contains('hidden');
    
    const itemElement = document.createElement('div');
    itemElement.className = `item-card ${isReserved ? 'reserved' : ''} ${isReserved && isAdminOpen ? 'admin-mode' : ''} ${!isPageEnabled ? 'disabled' : ''}`;
    itemElement.onclick = () => {
      if (!isPageEnabled) return;
      if (!isReserved) {
        claimItem(itemId, itemElement);
      } else if (isAdminOpen) {
        unreserveItem(itemId);
      }
    };
    
    const statusDiv = document.createElement('div');
    statusDiv.className = 'item-status';
    statusDiv.textContent = isReserved ? '🔴 ' + claimedBy : '🟢 Available';
    
    const displayId = (i - startIndex) + 1;
    itemElement.innerHTML = `<div class="item-id">${itemPrefix}${displayId}</div>`;
    itemElement.appendChild(statusDiv);

    if (isReserved && isAdminOpen) {
      const unreserveBtn = document.createElement('button');
      unreserveBtn.className = 'unreserve-btn';
      unreserveBtn.textContent = '🔓 Unclaim';
      unreserveBtn.onclick = (e) => {
        e.stopPropagation();
        unreserveItem(itemId);
      };
      itemElement.appendChild(unreserveBtn);
    }

    container.appendChild(itemElement);
  }

  const currentEl = getEl('current-page-val');
  if (currentEl) currentEl.textContent = currentPage;
  
  const totalPagesVal = getEl('total-pages-val');
  if (totalPagesVal) totalPagesVal.textContent = totalPages;

  const totalItemsInput = getEl('total-items');
  if (totalItemsInput && document.activeElement !== totalItemsInput) totalItemsInput.value = totalItems;

  const pagesInput = getEl('total-pages');
  if (pagesInput && document.activeElement !== pagesInput) pagesInput.value = totalPages;
}

function changePage(delta) {
  const newPage = currentPage + delta;
  if (newPage >= 1 && newPage <= totalPages) {
    currentPage = newPage;
    renderItems();
  }
}
window.changePage = changePage;

function updateItemsPerPage() {
  const selector = getEl('items-per-page');
  if (selector) {
    itemsPerPage = parseInt(selector.value);
    safeSet('items_per_page', itemsPerPage);
    totalPages = Math.ceil(totalItems / itemsPerPage);
    currentPage = 1; // Reset to page 1 to avoid out of bounds

    const pagesInput = getEl('total-pages');
    if (pagesInput) pagesInput.value = totalPages;
    
    renderItems();
    renderSummary(); // Summary needs re-rendering as it shows page numbers

    persistConfig();
  }
}
window.updateItemsPerPage = updateItemsPerPage;

async function updateItemPrefix() {
  const input = getEl('item-prefix');
  if (input) {
    itemPrefix = input.value;
    safeSet('item_prefix', itemPrefix);
    
    renderItems();
    renderSummary();

    await persistConfig();
  }
}
window.updateItemPrefix = updateItemPrefix;

async function updateTotalItems() {
  const input = getEl('total-items');
  if (input) {
    const val = parseInt(input.value);
    if (isNaN(val) || val < 1) return;
    
    totalItems = val;
    safeSet('total_items', totalItems);
    totalPages = Math.ceil(totalItems / itemsPerPage);
    currentPage = 1; // Reset to avoid being out of bounds
    
    const pagesInput = getEl('total-pages');
    if (pagesInput && document.activeElement !== pagesInput) pagesInput.value = totalPages;
    
    renderItems();
    renderSummary();

    await persistConfig();
  }
}
window.updateTotalItems = updateTotalItems;

async function updateTotalPages() {
  const input = getEl('total-pages');
  if (input) {
    const val = parseInt(input.value);
    if (isNaN(val) || val < 1) return;
    
    totalPages = val;
    totalItems = totalPages * itemsPerPage;
    safeSet('total_items', totalItems);
    currentPage = 1; // Reset to avoid being out of bounds
    
    const totalItemsInput = getEl('total-items');
    if (totalItemsInput && document.activeElement !== totalItemsInput) totalItemsInput.value = totalItems;
    
    renderItems();
    renderSummary();

    await persistConfig();
  }
}
window.updateTotalPages = updateTotalPages;


function saveGlobalIGN() {
  const input = getEl('global-ign');
  if (input) safeSet('guild_ign', input.value.trim());
}
window.saveGlobalIGN = saveGlobalIGN;

function showConfirmModal(itemId, itemCard) {
  const modal = getEl('confirm-modal');
  const msgEl = getEl('confirm-msg');
  const confirmBtn = getEl('modal-confirm');
  const cancelBtn = getEl('modal-cancel');
  
  const displayId = ((itemId - 1) % itemsPerPage) + 1;
  msgEl.innerHTML = `Do you want to claim<br><strong>Page ${currentPage}, ${itemPrefix}${displayId}</strong>?`;
  
  modal.classList.remove('hidden');
  
  // Anti-macro: Disable confirm button for a short duration
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Wait...';
  let countdown = 1;
  const interval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(interval);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Claim';
    }
  }, 1000);

  const cleanup = () => {
    clearInterval(interval);
    modal.classList.add('hidden');
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };

  confirmBtn.onclick = () => {
    cleanup();
    executeClaim(itemId, itemCard);
  };

  cancelBtn.onclick = () => {
    cleanup();
  };
}

async function claimItem(itemId, itemCard) {
  const input = getEl('global-ign');
  const ign = input ? input.value.trim() : '';
  
  if (!ign) {
    if (input) {
      input.focus();
      input.style.borderColor = '#ff5252';
      setTimeout(() => input.style.borderColor = '#333', 500);
    }
    return alert("Please enter your IGN at the top first!");
  }

  // Prevent double-claiming if already known locally
  if (reservations[itemId]) {
    return alert("This item is already reserved!");
  }

  showConfirmModal(itemId, itemCard);
}
window.claimItem = claimItem;

async function executeClaim(itemId, itemCard) {
  const input = getEl('global-ign');
  const ign = input ? input.value.trim() : '';
  
  // Visual feedback
  if (itemCard) itemCard.style.opacity = '0.5';

  let success = false;
  if (syncEnabled && supabase) {
    // The database is authoritative for both the 3-second gate and first claim.
    // A manipulated/fast client clock can no longer claim before the shared deadline.
    const { data, error } = await supabase.rpc('claim_item_after_timer', {
      p_item_id: itemId,
      p_ign: ign
    });

    if (error) {
      alert("Sync failed: " + error.message);
    } else if (data === 'claimed') {
      success = true;
      reservations[itemId] = ign;
      safeSet('guild_claims', JSON.stringify(reservations));
    } else if (data === 'already_claimed') {
      alert("Too slow! Someone else just claimed this item.");
    } else if (data === 'too_early') {
      await syncServerClock();
      alert("The shared 3-second countdown has not finished yet.");
    } else if (data === 'timer_not_started') {
      alert("This page has not been enabled yet.");
    } else {
      alert("Claim failed: " + data);
    }
  } else {
    // Local-only mode has no shared users, so the browser clock is sufficient.
    success = await persistReservation(itemId, ign);
  }

  if (itemCard) itemCard.style.opacity = '1';
  
  if (success) {
    renderItems();
    renderSummary();
  }
}

async function unreserveItem(itemId) {
  const claimedBy = reservations[itemId];
  const pageNum = Math.ceil(itemId / itemsPerPage);
  const itemNum = ((itemId - 1) % itemsPerPage) + 1;
  const msg = `Are you sure you want to unreserve this item?\n\n📍 Location: Page ${pageNum}, ${itemPrefix}${itemNum}\n👤 Claimed by: ${claimedBy || 'Unknown'}`;
  
  if (confirm(msg)) {
    const success = await deleteReservation(itemId);
    if (success) {
      renderItems();
      renderSummary();
    }
  }
}
window.unreserveItem = unreserveItem;

async function resetReservations() {
  if (confirm("⚠️ WARNING: This will clear ALL reservations. Are you sure?")) {
    const success = await clearAllReservations();
    if (success) {
      renderItems();
      renderSummary();
      alert("All reservations have been reset.");
    }
  }
}
window.resetReservations = resetReservations;

function exportData() {
  const data = JSON.stringify(reservations, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reservations_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
window.exportData = exportData;

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (typeof imported === 'object' && imported !== null) {
          if (syncEnabled && supabase) {
             // Mass import to supabase
             for (const id in imported) {
               await persistReservation(id, imported[id]);
             }
             alert("Data imported to Cloud!");
          } else {
            reservations = imported;
            safeSet('guild_claims', JSON.stringify(reservations));
            renderItems();
            renderSummary();
            alert("Data imported locally!");
          }
        }
      } catch (err) { alert("Invalid JSON file!"); }
    };
    reader.readAsText(file);
  };
  input.click();
}
window.importData = importData;

function renderSummary() {
  const container = getEl('summary-container');
  if (!container) return;
  
  const playerGroups = {};
  Object.keys(reservations).forEach(itemId => {
    if (itemId === "0" || parseInt(itemId) >= TIMER_OFFSET) return; // Skip config and timers
    const ign = reservations[itemId];
    if (!ign) return;
    if (!playerGroups[ign]) playerGroups[ign] = [];
    
    const id = parseInt(itemId);
    const pageNum = Math.ceil(id / itemsPerPage);
    const itemNum = ((id - 1) % itemsPerPage) + 1;
    playerGroups[ign].push({ id, pageNum, itemNum, label: `Page ${pageNum}, ${itemPrefix}${itemNum}` });
  });

  const players = Object.keys(playerGroups).sort();
  container.innerHTML = '';
  
  const title = document.createElement('h2');
  title.textContent = '📊 Reservation Summary';
  container.appendChild(title);

  const gridReserved = Object.keys(reservations).filter(k => {
    const id = parseInt(k);
    return id !== 0 && id < TIMER_OFFSET;
  }).length;
  const stats = document.createElement('p');
  stats.className = 'summary-stats';
  let progressText = `Items: ${gridReserved} / ${totalItems} claimed (${Math.round((gridReserved/totalItems)*100)}%)`;
  stats.textContent = progressText;
  container.appendChild(stats);
  
  if (players.length === 0) {
    const p = document.createElement('p');
    p.style.textAlign = 'center';
    p.style.color = '#888';
    p.style.marginTop = '20px';
    p.textContent = 'No reservations yet. Claim an item to see it here!';
    container.appendChild(p);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'summary-grid';
  players.forEach(player => {
    const items = playerGroups[player];
    const card = document.createElement('div');
    card.className = 'summary-card';
    const h3 = document.createElement('h3');
    h3.textContent = `👤 ${player} (${items.length} ${items.length === 1 ? 'item' : 'items'})`;
    card.appendChild(h3);
    const ul = document.createElement('ul');
    items.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item.label;
      ul.appendChild(li);
    });
    card.appendChild(ul);
    grid.appendChild(card);
  });
  container.appendChild(grid);

  const discordBtn = document.createElement('button');
  discordBtn.className = 'discord-btn';
  discordBtn.innerHTML = '📋 Copy for Discord';
  discordBtn.disabled = false; // Always enabled for summary
  discordBtn.onclick = () => {
    let text = "**📊 littleHome Item Reservation Summary**\n";
    players.forEach(player => {
      const items = playerGroups[player];
      text += `\n👤 **${player}** (${items.length} items):\n`;
      text += items.map(item => `- ${item.label}`).join('\n') + "\n";
    });
    navigator.clipboard.writeText(text).then(() => alert("Summary copied to clipboard!"));
  };
  container.appendChild(discordBtn);
}

function setAllButtonsState(disabled) {
  isAppEnabled = !disabled;
  const elements = document.querySelectorAll('button, input, select');
  elements.forEach(el => {
    if (el.id !== 'enable-timer-btn') {
      el.disabled = disabled;
    }
  });
  
  const trigger = getEl('admin-trigger');
  if (trigger) {
    if (disabled) trigger.classList.add('disabled');
    else trigger.classList.remove('disabled');
  }
  
  // Refresh items to apply/remove disabled visual state if needed
  renderItems();
}

async function startEnableTimer() {
  const btn = getEl('enable-timer-btn');
  if (!btn || btn.disabled) return;
  
  const pageToEnable = currentPage;
  btn.disabled = true;
  btn.textContent = '⏳ Starting shared timer...';

  let startTime;
  if (syncEnabled && supabase) {
    // PostgreSQL creates the timestamp. Every user receives exactly the same
    // start value, independent of the clock on the admin's device.
    const { data, error } = await supabase.rpc('start_page_timer', {
      p_page: pageToEnable
    });

    if (error) {
      console.error("Sync timer failed:", error);
      alert("Could not start the shared timer: " + error.message);
      updateTimerButton();
      return;
    }

    startTime = Number(data);
    if (!Number.isFinite(startTime)) {
      alert("Could not start the shared timer: invalid server timestamp.");
      updateTimerButton();
      return;
    }

    // Refresh the offset around timer start to minimize clock drift/skew.
    await syncServerClock();
  } else {
    startTime = Date.now();
  }

  pageTimers[pageToEnable] = startTime;
  startGlobalTimer();
  renderItems();
}

function startGlobalTimer() {
  if (timerInterval) return;
  
  timerInterval = setInterval(() => {
    const now = getAuthoritativeNow();
    let stillRunning = false;
    
    for (const pageNum in pageTimers) {
      if (enabledPages.has(parseInt(pageNum))) continue;
      
      const elapsed = now - pageTimers[pageNum];
      if (elapsed >= TIMER_DURATION) {
        enabledPages.add(parseInt(pageNum));
        if (currentPage === parseInt(pageNum)) renderItems();
      } else {
        stillRunning = true;
      }
    }
    
    if (stillRunning) {
      updateTimerButton();
    } else {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }, 100);
}

function updateTimerButton() {
  const btn = getEl('enable-timer-btn');
  if (!btn) return;

  const isPageEnabled = enabledPages.has(currentPage);
  const startTime = pageTimers[currentPage];

  if (isPageEnabled) {
    btn.classList.add('hidden');
    return;
  }

  if (startTime) {
    const elapsed = getAuthoritativeNow() - startTime;
    const timeLeft = Math.ceil((TIMER_DURATION - elapsed) / 1000);
    if (timeLeft > 0) {
      btn.classList.remove('hidden');
      btn.disabled = true;
      btn.textContent = `⏳ Enabling in ${timeLeft}s...`;
      return;
    }
  }

  btn.classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = `🚀 Click to Enable Page ${currentPage} Items (Wait 3s)`;
}
window.startEnableTimer = startEnableTimer;

init();
