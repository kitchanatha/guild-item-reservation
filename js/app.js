const TOTAL_ITEMS = 100;
const ITEMS_PER_PAGE = 4;
const TOTAL_PAGES = Math.ceil(TOTAL_ITEMS / ITEMS_PER_PAGE);

let currentPage = 1;

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("LocalStorage not available");
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    // ignore
  }
}

let reservations = {};
try {
  const saved = safeGet('guild_claims');
  reservations = saved ? JSON.parse(saved) : {};
} catch (e) {
  console.error("Error loading reservations:", e);
  reservations = {};
}
let adminClickCount = 0;

function getEl(id) {
  return document.getElementById(id);
}

function init() {
  setupAdminTrigger();
  const savedIGN = safeGet('guild_ign') || '';
  const globalInput = getEl('global-ign');
  if (globalInput) globalInput.value = savedIGN;
  
  renderItems();
  renderSummary();
}

function setupAdminTrigger() {
  const trigger = getEl('admin-trigger');
  if (trigger) {
    const handleTrigger = (e) => {
      adminClickCount++;
      if (adminClickCount >= 5) {
        const actions = getEl('admin-actions');
        if (actions) {
          actions.classList.toggle('hidden');
        }
        adminClickCount = 0;
      }
    };
    
    trigger.addEventListener('click', handleTrigger);
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

function changePage(delta) {
  const newPage = currentPage + delta;
  if (newPage >= 1 && newPage <= TOTAL_PAGES) {
    currentPage = newPage;
    renderItems();
  }
}
window.changePage = changePage;

function saveGlobalIGN() {
  const input = getEl('global-ign');
  if (input) {
    safeSet('guild_ign', input.value.trim());
  }
}
window.saveGlobalIGN = saveGlobalIGN;

function claimItem(itemId) {
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
  
  reservations[itemId] = ign;
  safeSet('guild_claims', JSON.stringify(reservations));
  renderItems();
  renderSummary();
}
window.claimItem = claimItem;

function unreserveItem(itemId) {
  if (confirm(`Are you sure you want to unreserve Item #${itemId}?`)) {
    delete reservations[itemId];
    safeSet('guild_claims', JSON.stringify(reservations));
    renderItems();
    renderSummary();
  }
}
window.unreserveItem = unreserveItem;

function resetReservations() {
  if (confirm("⚠️ WARNING: This will clear ALL reservations. Are you sure?")) {
    reservations = {};
    safeRemove('guild_claims');
    renderItems();
    renderSummary();
    alert("All reservations have been reset.");
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
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (typeof imported === 'object' && imported !== null) {
          reservations = imported;
          safeSet('guild_claims', JSON.stringify(reservations));
          renderItems();
          renderSummary();
          alert("Data imported successfully!");
        }
      } catch (err) {
        alert("Invalid JSON file!");
      }
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
