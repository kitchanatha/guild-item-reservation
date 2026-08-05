const TOTAL_ITEMS = 100;
const ITEMS_PER_PAGE = 4;
const TOTAL_PAGES = Math.ceil(TOTAL_ITEMS / ITEMS_PER_PAGE);

let currentPage = 1;
let reservations = JSON.parse(localStorage.getItem('guild_claims')) || {};

const itemsContainer = document.getElementById('items-container');
const paginationContainer = document.getElementById('pagination');

function init() {
  renderItems();
  renderPagination();
}

function renderItems() {
  itemsContainer.innerHTML = '';
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, TOTAL_ITEMS);

  for (let i = startIndex; i < endIndex; i++) {
    const itemId = i + 1;
    const claimedBy = reservations[itemId];
    const isReserved = !!claimedBy;
    
    const itemElement = document.createElement('div');
    itemElement.className = `item-card ${isReserved ? 'reserved' : ''}`;
    itemElement.innerHTML = `
      <h3>Item #${itemId}</h3>
      <p>Status: <span class="status-text">${isReserved ? '🔴 CLAIMED BY ' + claimedBy : '🟢 AVAILABLE'}</span></p>
      ${!isReserved ? `
        <input type="text" id="input_${itemId}" placeholder="Enter IGN">
        <button onclick="claimItem(${itemId})">Claim (FCFS)</button>
      ` : `
        <button class="unreserve-btn" onclick="unreserveItem(${itemId})">Unreserve</button>
      `}
    `;
    itemsContainer.appendChild(itemElement);
  }
}

function renderPagination() {
  paginationContainer.innerHTML = '';
  
  // Page info
  const pageInfo = document.createElement('div');
  pageInfo.className = 'page-info';
  pageInfo.innerText = `Page ${currentPage} of ${TOTAL_PAGES}`;
  paginationContainer.appendChild(pageInfo);

  const navContainer = document.createElement('div');
  navContainer.className = 'pagination-nav';
  
  // Previous button
  const prevBtn = document.createElement('button');
  prevBtn.innerText = 'Prev';
  prevBtn.className = 'page-btn';
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => goToPage(currentPage - 1);
  navContainer.appendChild(prevBtn);

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.innerText = 'Next';
  nextBtn.className = 'page-btn';
  nextBtn.disabled = currentPage === TOTAL_PAGES;
  nextBtn.onclick = () => goToPage(currentPage + 1);
  navContainer.appendChild(nextBtn);

  paginationContainer.appendChild(navContainer);
}

function goToPage(page) {
  if (page < 1 || page > TOTAL_PAGES) return;
  currentPage = page;
  renderItems();
  renderPagination();
}

window.claimItem = function(itemId) {
  const input = document.getElementById(`input_${itemId}`);
  const ign = input.value.trim();
  if (!ign) return alert("Please enter your IGN!");
  
  reservations[itemId] = ign;
  localStorage.setItem('guild_claims', JSON.stringify(reservations));
  renderItems();
};

window.unreserveItem = function(itemId) {
  if (confirm("Are you sure you want to unreserve this item?")) {
    delete reservations[itemId];
    localStorage.setItem('guild_claims', JSON.stringify(reservations));
    renderItems();
  }
};

init();
