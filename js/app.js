const TOTAL_ITEMS = 100;
const ITEMS_PER_PAGE = 4;
const TOTAL_PAGES = Math.ceil(TOTAL_ITEMS / ITEMS_PER_PAGE);

let currentPage = 1;
let reservations = JSON.parse(localStorage.getItem('guildReservations')) || {};

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
    const isReserved = !!reservations[itemId];
    
    const itemElement = document.createElement('div');
    itemElement.className = `item-card ${isReserved ? 'reserved' : ''}`;
    itemElement.innerHTML = `
      <h3>Item #${itemId}</h3>
      <p>Status: <span class="status-text">${isReserved ? 'Reserved' : 'Available'}</span></p>
      <button onclick="toggleReservation(${itemId})">
        ${isReserved ? 'Unreserve' : 'Reserve'}
      </button>
    `;
    itemsContainer.appendChild(itemElement);
  }
}

function renderPagination() {
  paginationContainer.innerHTML = '';
  
  // Previous button
  const prevBtn = document.createElement('button');
  prevBtn.innerText = 'Prev';
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => goToPage(currentPage - 1);
  paginationContainer.appendChild(prevBtn);

  // Page numbers (showing current and a few around it for brevity if we wanted, 
  // but the user asked for 25 pages specifically, let's see how it looks)
  // For 25 pages, we might want to show all or use dots. 
  // Given "simple website", I'll show current page info and buttons.
  
  const pageInfo = document.createElement('span');
  pageInfo.className = 'page-info';
  pageInfo.innerText = ` Page ${currentPage} of ${TOTAL_PAGES} `;
  paginationContainer.appendChild(pageInfo);

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.innerText = 'Next';
  nextBtn.disabled = currentPage === TOTAL_PAGES;
  nextBtn.onclick = () => goToPage(currentPage + 1);
  paginationContainer.appendChild(nextBtn);
}

function goToPage(page) {
  if (page < 1 || page > TOTAL_PAGES) return;
  currentPage = page;
  renderItems();
  renderPagination();
}

window.toggleReservation = function(itemId) {
  if (reservations[itemId]) {
    delete reservations[itemId];
  } else {
    reservations[itemId] = {
      timestamp: new Date().toISOString(),
      user: 'Member' // Mock user
    };
  }
  localStorage.setItem('guildReservations', JSON.stringify(reservations));
  renderItems();
};

init();
