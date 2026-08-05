const TOTAL_ITEMS = 100;
const DISPLAY_ITEMS_PER_ROW = 4;
const ITEMS_PER_GAME_PAGE = 4; // Used for summary calculation

let reservations = JSON.parse(localStorage.getItem('guild_claims')) || {};
let adminClickCount = 0;

function getEl(id) {
  return document.getElementById(id);
}

function init() {
  setupAdminTrigger();
  const savedIGN = localStorage.getItem('guild_ign') || '';
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
  
  for (let i = 0; i < TOTAL_ITEMS; i++) {
    const itemId = i + 1;
    const claimedBy = reservations[itemId];
    const isReserved = !!claimedBy;
    
    const itemElement = document.createElement('div');
    itemElement.className = `item-card ${isReserved ? 'reserved' : ''}`;
    itemElement.onclick = () => isReserved ? unreserveItem(itemId) : claimItem(itemId);
    
    itemElement.innerHTML = `
      <div class="item-id">#${itemId}</div>
      <div class="item-status">${isReserved ? '🔴 ' + claimedBy : '🟢 Available'}</div>
    `;
    container.appendChild(itemElement);
  }
}

window.saveGlobalIGN = function() {
  const input = getEl('global-ign');
  if (input) {
    localStorage.setItem('guild_ign', input.value.trim());
  }
};

window.claimItem = function(itemId) {
  const input = getEl('global-ign');
  const ign = input ? input.value.trim() : '';
  
  if (!ign) {
    if (input) input.focus();
    return alert("Please enter your IGN at the top first!");
  }
  
  reservations[itemId] = ign;
  localStorage.setItem('guild_claims', JSON.stringify(reservations));
  renderItems();
  renderSummary();
};

window.unreserveItem = function(itemId) {
  if (confirm(`Are you sure you want to unreserve Item #${itemId}?`)) {
    delete reservations[itemId];
    localStorage.setItem('guild_claims', JSON.stringify(reservations));
    renderItems();
    renderSummary();
  }
};
 
window.resetReservations = function() {
  if (confirm("⚠️ WARNING: This will clear ALL reservations. Are you sure?")) {
    reservations = {};
    localStorage.removeItem('guild_claims');
    renderItems();
    renderSummary();
    alert("All reservations have been reset.");
  }
};

function renderSummary() {
  const container = getEl('summary-container');
  if (!container) return;
  
  const playerGroups = {};
  Object.keys(reservations).forEach(itemId => {
    const ign = reservations[itemId];
    if (!playerGroups[ign]) playerGroups[ign] = [];
    const id = parseInt(itemId);
    const pageNum = Math.ceil(id / ITEMS_PER_GAME_PAGE);
    const itemNum = ((id - 1) % ITEMS_PER_GAME_PAGE) + 1;
    playerGroups[ign].push({ id, pageNum, itemNum });
  });

  const players = Object.keys(playerGroups).sort();
  
  let html = '<h2>📊 Reservation Summary</h2>';
  
  if (players.length === 0) {
    html += '<p style="text-align: center; color: #888; margin-top: 20px;">No reservations yet. Claim an item to see it here!</p>';
    container.innerHTML = html;
    return;
  }

  html += '<div class="summary-grid">';
  players.forEach(player => {
    const items = playerGroups[player];
    html += `
      <div class="summary-card">
        <h3>👤 ${player} (${items.length} ${items.length === 1 ? 'item' : 'items'})</h3>
        <ul>
          ${items.map(item => `<li>Item #${item.id} (Page ${item.pageNum}, Item #${item.itemNum})</li>`).join('')}
        </ul>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}

init();
