const BOSSES = [
  { id: 'tandallon', dbId: -101, name: 'Flame of Extinction Tandallon', region: 'Lava Lakefront', interval: 480 },
  { id: 'panderre', dbId: -102, name: 'Brutal Dictator Awakened Panderre', region: 'Eerie Rock Sanctuary Region 3 North', interval: 480 },
  { id: 'knight', dbId: -103, name: 'Terror Across the Battlefield Ruined Knight', region: 'Battlefield of Counterattack', interval: 720 },
  { id: 'balthazard', dbId: -104, name: 'Hound of the Great Fortress Balthazard', region: 'Blazing Valley', interval: 720 },
  { id: 'melville', dbId: -105, name: 'Tyrannical Ravager Melville', region: 'Eerie Rock Sanctuary Region 3 South', interval: 720 },
  { id: 'hotura', dbId: -106, name: 'Violent Marauder Hotura', region: 'Ice Cavern Cave 1 Center', interval: 720 },
];

let bossDeaths = {}; // bossId -> timestamp (ms)
let notifiedBosses = new Set();

export function initBosses() {
  const saved = localStorage.getItem('boss_deaths');
  if (saved) {
    try {
      bossDeaths = JSON.parse(saved);
    } catch (e) {
      bossDeaths = {};
    }
  }

  // Hook for remote changes
  window.onBossTimerChange = (dbId, ign) => {
    const boss = BOSSES.find(b => b.dbId === dbId);
    if (boss) {
      if (ign === null) {
        delete bossDeaths[boss.id];
      } else {
        const timestamp = parseInt(ign);
        if (!isNaN(timestamp)) {
          bossDeaths[boss.id] = timestamp;
        }
      }
      localStorage.setItem('boss_deaths', JSON.stringify(bossDeaths));
      notifiedBosses.delete(boss.id);
      updateBossTimers();
    }
  };
  
  renderBosses();
  setInterval(updateBossTimers, 1000);
  updateBossTimers();
}

function renderBosses() {
  const container = document.getElementById('boss-container');
  if (!container) return;
  
  container.innerHTML = '';
  BOSSES.forEach(boss => {
    const card = document.createElement('div');
    card.className = 'boss-card';
    card.id = `boss-${boss.id}`;
    
    card.innerHTML = `
      <div class="boss-info">
        <div class="boss-name">${boss.name}</div>
        <div class="boss-region">📍 ${boss.region}</div>
      </div>
      <div class="boss-interval">
        <label>Interval (h):</label>
        <input type="number" step="0.5" value="${boss.interval / 60}" onchange="updateBossInterval('${boss.id}', this.value)" style="width: 50px; background: #121212; color: #fff; border: 1px solid #333; text-align: center; border-radius: 4px;">
      </div>
      <div class="boss-spawn-time" id="timer-${boss.id}">--:--:--</div>
      <button class="set-death-btn" onclick="setBossDeath('${boss.id}')">☠️ Set Death</button>
    `;
    container.appendChild(card);
  });
}

window.updateBossInterval = (id, hours) => {
  const boss = BOSSES.find(b => b.id === id);
  if (boss) {
    boss.interval = parseFloat(hours) * 60;
    updateBossTimers();
  }
};

window.setBossDeath = async (id) => {
  const boss = BOSSES.find(b => b.id === id);
  if (!boss) return;

  const now = Date.now();
  bossDeaths[id] = now;
  localStorage.setItem('boss_deaths', JSON.stringify(bossDeaths));
  notifiedBosses.delete(id);
  
  // Sync to Supabase if available
  if (window.supabaseClient) {
    try {
      await window.supabaseClient
        .from('reservations')
        .upsert({ item_id: boss.dbId, ign: now.toString() });
    } catch (e) {
      console.warn("Boss sync failed", e);
    }
  }

  updateBossTimers();
};

window.resetBossTimers = async () => {
  if (confirm("⚠️ WARNING: This will clear ALL boss timers. Are you sure?")) {
    bossDeaths = {};
    localStorage.removeItem('boss_deaths');
    notifiedBosses.clear();

    if (window.supabaseClient) {
      for (const boss of BOSSES) {
        await window.supabaseClient
          .from('reservations')
          .delete()
          .eq('item_id', boss.dbId);
      }
    }

    updateBossTimers();
    alert("Boss timers have been reset.");
  }
};

function updateBossTimers() {
  const now = Date.now();
  BOSSES.forEach(boss => {
    const deathTime = bossDeaths[boss.id];
    const timerEl = document.getElementById(`timer-${boss.id}`);
    if (!timerEl) return;
    
    if (!deathTime) {
      timerEl.textContent = 'Unknown';
      timerEl.className = 'boss-spawn-time unknown';
      return;
    }
    
    const nextSpawn = deathTime + (boss.interval * 60 * 1000);
    const timeLeft = nextSpawn - now;
    
    if (timeLeft <= 0) {
      timerEl.textContent = 'SPAWNED!';
      timerEl.className = 'boss-spawn-time soon';
    } else {
      const hours = Math.floor(timeLeft / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
      timerEl.textContent = `${hours}h ${minutes}m ${seconds}s`;
      
      if (timeLeft < 10 * 60 * 1000) { // 10 minutes
        timerEl.className = 'boss-spawn-time soon';
        checkNotification(boss, timeLeft);
      } else {
        timerEl.className = 'boss-spawn-time';
      }
    }
  });
}

function checkNotification(boss, timeLeft) {
  if (timeLeft < 5 * 60 * 1000 && !notifiedBosses.has(boss.id)) {
    if (Notification.permission === 'granted') {
      try {
        new Notification(`Boss Spawn Soon: ${boss.name}`, {
          body: `Spawning in ${boss.region} in less than 5 minutes!`,
          icon: 'icon.png'
        });
        notifiedBosses.add(boss.id);
      } catch (e) {
        console.error("Notification error", e);
      }
    }
  }
}

window.requestNotificationPermission = () => {
  Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
      alert('Notifications enabled!');
    } else {
      alert('Notifications blocked or dismissed.');
    }
  });
};

window.switchTab = (tab) => {
  const resSection = document.getElementById('reservation-section');
  const bossSection = document.getElementById('boss-section');
  const resBtn = document.getElementById('tab-btn-reservation');
  const bossBtn = document.getElementById('tab-btn-boss');
  
  if (tab === 'reservation') {
    resSection?.classList.remove('hidden');
    bossSection?.classList.add('hidden');
    resBtn?.classList.add('active');
    bossBtn?.classList.remove('active');
  } else {
    resSection?.classList.add('hidden');
    bossSection?.classList.remove('hidden');
    resBtn?.classList.remove('active');
    bossBtn?.classList.add('active');
  }
};
