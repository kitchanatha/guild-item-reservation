import { createClient } from '@supabase/supabase-js';

const TOTAL_ITEMS = 100;
const ITEMS_PER_PAGE = 4;
const TOTAL_PAGES = Math.ceil(TOTAL_ITEMS / ITEMS_PER_PAGE);

let currentPage = 1;
let reservations = {};
let supabase = null;
let syncEnabled = false;

function getEl(id) {
  return document.getElementById(id);
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

function loadSupabaseConfig() {
  const url = safeGet('sb_url');
  const key = safeGet('sb_key');
  syncEnabled = !!(url && key);
  
  const urlInp = getEl('supabase-url');
  const keyInp = getEl('supabase-key');
  if (urlInp) urlInp.value = url || '';
  if (keyInp) keyInp.value = key || '';
}

window.saveSupabaseConfig = async function() {
  const url = getEl('supabase-url').value.trim();
  const key = getEl('supabase-key').value.trim();
  
  safeSet('sb_url', url);
  safeSet('sb_key', key);
  
  alert("Settings saved. Reconnecting...");
  location.reload();
};

async function connectSupabase() {
  const url = safeGet('sb_url');
  const key = safeGet('sb_key');
  
  try {
    supabase = createClient(url, key);
    
    // Initial fetch
    const { data, error } = await supabase
      .from('reservations')
      .select('*');
      
    if (error) throw error;
    
    // Convert array to object mapping
    reservations = {};
    data.forEach(row => {
      reservations[row.item_id] = row.ign;
    });
    
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
    reservations[payload.new.item_id] = payload.new.ign;
  } else if (payload.eventType === 'DELETE') {
    delete reservations[payload.old.item_id];
  }
  renderItems();
  renderSummary();
}

async function persistReservation(itemId, ign) {
  if (syncEnabled && supabase) {
    const { error } = await supabase
      .from('reservations')
      .upsert({ item_id: itemId, ign: ign });
    if (error) alert("Sync failed: " + error.message);
  } else {
    reservations[itemId] = ign;
    safeSet('guild_claims', JSON.stringify(reservations));
  }
}

async function deleteReservation(itemId) {
  if (syncEnabled && supabase) {
    const { error } = await supabase
      .from('reservations')
      .delete()
      .eq('item_id', itemId);
    if (error) alert("Sync failed: " + error.message);
  } else {
    delete reservations[itemId];
    safeSet('guild_claims', JSON.stringify(reservations));
  }
}

async function clearAllReservations() {
  if (syncEnabled && supabase) {
    // Supabase delete all (requires a filter, so we use not null on item_id)
    const { error } = await supabase
      .from('reservations')
      .delete()
      .neq('item_id', 0); 
    if (error) alert("Sync failed: " + error.message);
  } else {
    reservations = {};
    localStorage.removeItem('guild_claims');
  }
}

// --- UI Logic ---

function setupAdminTrigger() {
  let adminClickCount = 0;
  const trigger = getEl('admin-trigger');
  if (trigger) {
    trigger.addEventListener('click', () => {
      adminClickCount++;
      if (adminClickCount >= 5) {
        getEl('admin-actions')?.classList.toggle('hidden');
        adminClickCount = 0;
      }
    });
  }
}

function renderItems() {
  const container = getEl('items-container');
  if (!container) return;
  container.innerHTML = '';
  
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, TOTAL_ITEMS);
  
  for (let i = startIndex; i < endIndex; i++) {
    const itemId = i + 1;
    const claimedBy = reservations[itemId];
    const isReserved = !!claimedBy;
    
    const itemElement = document.createElement('div');
    itemElement.className = `item-card ${isReserved ? 'reserved' : ''}`;
    itemElement.onclick = () => isReserved ? unreserveItem(itemId) : claimItem(itemId);
    
    const statusDiv = document.createElement('div');
    statusDiv.className = 'item-status';
    statusDiv.textContent = isReserved ? '🔴 ' + claimedBy : '🟢 Available';
    
    itemElement.innerHTML = `<div class="item-id">#${itemId}</div>`;
    itemElement.appendChild(statusDiv);
    container.appendChild(itemElement);
  }

  const indicator = getEl('page-indicator');
  if (indicator) indicator.textContent = `Page ${currentPage} of ${TOTAL_PAGES}`;
}

window.changePage = function(delta) {
  const newPage = currentPage + delta;
  if (newPage >= 1 && newPage <= TOTAL_PAGES) {
    currentPage = newPage;
    renderItems();
  }
};

window.saveGlobalIGN = function() {
  const input = getEl('global-ign');
  if (input) safeSet('guild_ign', input.value.trim());
};

window.claimItem = async function(itemId) {
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
  
  await persistReservation(itemId, ign);
  if (!syncEnabled) {
    renderItems();
    renderSummary();
  }
};

window.unreserveItem = async function(itemId) {
  if (confirm(`Are you sure you want to unreserve Item #${itemId}?`)) {
    await deleteReservation(itemId);
    if (!syncEnabled) {
      renderItems();
      renderSummary();
    }
  }
};

window.resetReservations = async function() {
  if (confirm("⚠️ WARNING: This will clear ALL reservations. Are you sure?")) {
    await clearAllReservations();
    if (!syncEnabled) {
      renderItems();
      renderSummary();
      alert("All reservations have been reset.");
    }
  }
};

window.exportData = function() {
  const data = JSON.stringify(reservations, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reservations_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

window.importData = function() {
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
};

function renderSummary() {
  const container = getEl('summary-container');
  if (!container) return;
  
  const playerGroups = {};
  Object.keys(reservations).forEach(itemId => {
    const ign = reservations[itemId];
    if (!playerGroups[ign]) playerGroups[ign] = [];
    const id = parseInt(itemId);
    const pageNum = Math.ceil(id / ITEMS_PER_PAGE);
    const itemNum = ((id - 1) % ITEMS_PER_PAGE) + 1;
    playerGroups[ign].push({ id, pageNum, itemNum });
  });

  const players = Object.keys(playerGroups).sort();
  container.innerHTML = '';
  
  const title = document.createElement('h2');
  title.textContent = '📊 Reservation Summary';
  container.appendChild(title);
  
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
      li.textContent = `Item #${item.id} (Page ${item.pageNum}, Item #${item.itemNum})`;
      ul.appendChild(li);
    });
    card.appendChild(ul);
    grid.appendChild(card);
  });
  container.appendChild(grid);

  const discordBtn = document.createElement('button');
  discordBtn.className = 'discord-btn';
  discordBtn.innerHTML = '📋 Copy for Discord';
  discordBtn.onclick = () => {
    let text = "**📊 littleHome Item Reservation Summary**\n";
    players.forEach(player => {
      const items = playerGroups[player];
      text += `\n👤 **${player}** (${items.length} items):\n`;
      text += items.map(item => `- Item #${item.id} (P${item.pageNum}, #${item.itemNum})`).join('\n') + "\n";
    });
    navigator.clipboard.writeText(text).then(() => alert("Summary copied to clipboard!"));
  };
  container.appendChild(discordBtn);
}

init();
