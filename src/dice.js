// =============================================================================
// dice.js — Eldoria Soundboard Dice Roller
// Handles: pool builder, PF2e modifiers, 3D animation via dice-box,
//          socket emit/receive, live feed, per-character history.
// Loaded after player.js — `socket` and `playerName` are already defined.
// =============================================================================

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const dice = {
  // Current pool: [{ sides: 20, count: 1 }, ...]
  pool: [],

  // Modifiers
  modifiers: { prof: 0, item: 0, status: 0, circ: 0 },

  // Roll settings
  label:      '',
  dc:         null,
  visibility: 'public',

  // Feed entries (session)
  feed: [],

  // History entries per character
  history: {},

  // 3D box instance
  box: null,
  boxReady: false,
  boxInitialising: false,
};

// ---------------------------------------------------------------------------
// Dice-box 3D setup
// dice-box is an ES module — load it dynamically so it doesn't block render
// ---------------------------------------------------------------------------

async function initDiceBox() {
  if (dice.boxReady || dice.boxInitialising) return;
  dice.boxInitialising = true;

  try {
    const { default: DiceBox } = await import('/assets/dice-box/dice-box.es.min.js');

    dice.box = new DiceBox('#dice-3d-tray', {
      assetPath:   '/assets/dice-box/',
      theme:       'default',
      offscreen:   true,
      scale:       6,
      gravity:     1,
      mass:        1,
      friction:    0.8,
      restitution: 0.2,
      angularDamping: 0.4,
      linearDamping:  0.4,
      settleTimeout:  3000,
      startingHeight: 8,
      throwForce:     4,
      spinForce:      5,
      lightIntensity: 1,
    });

    await dice.box.init();
    dice.boxReady = true;
    console.log('[dice] DiceBox ready');
  } catch (e) {
    console.warn('[dice] DiceBox failed to init, falling back to text-only mode:', e);
    dice.boxReady = false;
  }
  dice.boxInitialising = false;
}

// ---------------------------------------------------------------------------
// Pool management
// ---------------------------------------------------------------------------

function addDie(sides) {
  const existing = dice.pool.find(p => p.sides === sides);
  if (existing) {
    existing.count++;
  } else {
    dice.pool.push({ sides, count: 1 });
  }
  renderPool();
  updateRollBtn();
}

function setDieCount(sides, delta) {
  const entry = dice.pool.find(p => p.sides === sides);
  if (!entry) return;
  entry.count = Math.max(0, entry.count + delta);
  if (entry.count === 0) dice.pool = dice.pool.filter(p => p.sides !== sides);
  renderPool();
  updateRollBtn();
}

function removeDie(sides) {
  dice.pool = dice.pool.filter(p => p.sides !== sides);
  renderPool();
  updateRollBtn();
}

function clearPool() {
  dice.pool = [];
  renderPool();
  updateRollBtn();
}

// ---------------------------------------------------------------------------
// Modifier management
// ---------------------------------------------------------------------------

function setModifier(type, value) {
  dice.modifiers[type] = Number(value) || 0;
  updateModTotal();
  updateRollBtn();
}

function getModTotal() {
  return Object.values(dice.modifiers).reduce((s, v) => s + v, 0);
}

function updateModTotal() {
  const el = document.getElementById('dice-mod-total');
  if (el) {
    const t = getModTotal();
    el.textContent = (t >= 0 ? '+' : '') + t;
    el.style.color = t > 0 ? 'var(--green)' : t < 0 ? 'var(--red)' : 'var(--text2)';
  }
}

// ---------------------------------------------------------------------------
// Roll
// ---------------------------------------------------------------------------

async function rollDice() {
  if (dice.pool.length === 0) return;

  const label      = document.getElementById('dice-label')?.value?.trim() || '';
  const dcRaw      = document.getElementById('dice-dc')?.value?.trim();
  const dc         = dcRaw ? Number(dcRaw) : null;
  const visibility = document.querySelector('.dice-vis-btn.active')?.dataset.vis || 'public';
  const roller     = (typeof playerName !== 'undefined' ? playerName : null) || 'Unknown';

  dice.label      = label;
  dice.dc         = dc;
  dice.visibility = visibility;

  // Show tray as rolling
  setTrayState('rolling');

  // Launch 3D animation client-side (cosmetic only, result comes from server)
  if (dice.boxReady && dice.box) {
    const notation = dice.pool.map(p => `${p.count}d${p.sides}`).join('+');
    try {
      // Clear previous roll
      await dice.box.clearDice();
      // Roll cosmetically — we ignore these results; server is authoritative
      dice.box.roll(notation).catch(() => {});
    } catch (e) {
      console.warn('[dice] 3D roll failed:', e);
    }
  }

  // Emit to server — server rolls authoritatively and broadcasts result
  socket.emit('dice:roll', {
    pool:       dice.pool,
    modifiers:  dice.modifiers,
    label,
    dc,
    visibility,
    roller,
  });
}

// ---------------------------------------------------------------------------
// Socket: receive result
// ---------------------------------------------------------------------------

socket.on('dice:result', (record) => {
  // Add to feed
  dice.feed.unshift(record);
  if (dice.feed.length > 100) dice.feed.pop();

  // Update history for this roller
  if (!dice.history[record.roller]) dice.history[record.roller] = [];
  if (!record.redacted) {
    dice.history[record.roller].unshift(record);
    if (dice.history[record.roller].length > 200) dice.history[record.roller].pop();
  }

  // If this is our own roll (by socket match or roller name), show result in tray
  const myName = typeof playerName !== 'undefined' ? playerName : null;
  const isOurs = record.roller === myName && !record.redacted;
  if (isOurs) {
    showTrayResult(record);
    // Keep the 3D dice visible until next roll
  } else if (dice.pool.length === 0) {
    setTrayState('idle');
  }

  renderFeed();
  renderHistory();
});

// Request session feed on connect
socket.on('connect', () => {
  socket.emit('dice:feed:request');
});

socket.on('dice:feed', (feed) => {
  dice.feed = feed;
  renderFeed();
});

// ---------------------------------------------------------------------------
// Tray state
// ---------------------------------------------------------------------------

function setTrayState(state) {
  const tray = document.getElementById('dice-tray');
  if (!tray) return;
  tray.dataset.state = state;

  const dosEl    = document.getElementById('dice-dos-label');
  const totalEl  = document.getElementById('dice-total');
  const formulaEl = document.getElementById('dice-formula');
  const natEl    = document.getElementById('dice-nat-pill');

  if (state === 'idle') {
    if (dosEl)    { dosEl.textContent = ''; dosEl.className = 'dice-dos-label'; }
    if (totalEl)  totalEl.textContent = '—';
    if (formulaEl) formulaEl.textContent = 'Select dice and roll';
    if (natEl)    natEl.textContent = '';
  } else if (state === 'rolling') {
    if (dosEl)    { dosEl.textContent = 'Rolling…'; dosEl.className = 'dice-dos-label rolling'; }
    if (totalEl)  totalEl.textContent = '…';
    if (formulaEl) formulaEl.textContent = '';
    if (natEl)    natEl.textContent = '';
  }
}

function showTrayResult(record) {
  const tray = document.getElementById('dice-tray');
  if (!tray) return;
  tray.dataset.state = 'result';

  const dosEl     = document.getElementById('dice-dos-label');
  const totalEl   = document.getElementById('dice-total');
  const formulaEl = document.getElementById('dice-formula');
  const natEl     = document.getElementById('dice-nat-pill');

  // Degree of success label + colour
  if (dosEl) {
    const dos = record.degreeOfSuccess;
    dosEl.textContent = dos || '';
    dosEl.className = 'dice-dos-label ' + (dos ? dosClass(dos) : '');
  }

  // Total
  if (totalEl) {
    totalEl.textContent = record.total;
    totalEl.className = 'dice-total ' + (record.isNat20 ? 'nat20' : record.isNat1 ? 'nat1' : '');
  }

  // Formula breakdown
  if (formulaEl) {
    const parts = record.diceResults.map(d => `d${d.sides}(${d.value})`).join(' + ');
    const mod   = record.modTotal !== 0 ? (record.modTotal > 0 ? ' + ' : ' ') + record.modTotal : '';
    const dcStr = record.dc ? ` · DC ${record.dc}` : '';
    formulaEl.textContent = parts + mod + dcStr;
  }

  // Nat pill
  if (natEl) {
    if (record.isNat20)    { natEl.textContent = 'nat 20'; natEl.className = 'dice-nat-pill nat20'; }
    else if (record.isNat1) { natEl.textContent = 'nat 1';  natEl.className = 'dice-nat-pill nat1'; }
    else                    { natEl.textContent = ''; natEl.className = 'dice-nat-pill'; }
  }
}

function dosClass(dos) {
  if (dos === 'Critical success') return 'dos-cs';
  if (dos === 'Success')          return 'dos-s';
  if (dos === 'Failure')          return 'dos-f';
  if (dos === 'Critical failure') return 'dos-cf';
  return '';
}

// ---------------------------------------------------------------------------
// Render: pool
// ---------------------------------------------------------------------------

function renderPool() {
  const container = document.getElementById('dice-pool-list');
  if (!container) return;

  if (dice.pool.length === 0) {
    container.innerHTML = '<div class="dice-pool-empty">Click a die above to add it to your pool</div>';
    return;
  }

  container.innerHTML = dice.pool.map(({ sides, count }) => `
    <div class="dice-pool-row">
      <span class="dice-pool-label">${count}d${sides}</span>
      <div class="dice-pool-controls">
        <button class="dice-qty-btn" onclick="setDieCount(${sides}, -1)">−</button>
        <span class="dice-qty-val">${count}</span>
        <button class="dice-qty-btn" onclick="setDieCount(${sides}, 1)">+</button>
      </div>
      <button class="dice-remove-btn" onclick="removeDie(${sides})" title="Remove">✕</button>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Render: feed
// ---------------------------------------------------------------------------

function renderFeed() {
  const container = document.getElementById('dice-feed-list');
  if (!container) return;

  if (dice.feed.length === 0) {
    container.innerHTML = '<div class="dice-feed-empty">No rolls yet this session</div>';
    return;
  }

  container.innerHTML = dice.feed.map(r => {
    const timeStr = formatTime(r.timestamp);
    if (r.redacted) {
      return `
        <div class="dice-feed-entry redacted">
          <div class="dice-feed-row1">
            <span class="dice-feed-name">${esc(r.roller)}</span>
            <span class="dice-feed-label">rolled privately</span>
            <span class="dice-feed-time">${timeStr}</span>
          </div>
          <div class="dice-feed-private">Result hidden</div>
        </div>`;
    }
    const nat = r.isNat20 ? `<span class="dice-nat-pill nat20 small">nat 20</span>`
              : r.isNat1  ? `<span class="dice-nat-pill nat1 small">nat 1</span>` : '';
    const dos = r.degreeOfSuccess
              ? `<span class="dice-dos-pill ${dosClass(r.degreeOfSuccess)}">${r.degreeOfSuccess}</span>` : '';
    const totalClass = r.isNat20 ? 'nat20' : r.isNat1 ? 'nat1' : '';
    const vis = r.visibility === 'private' ? ' <span class="dice-priv-tag">private</span>' : '';
    const lbl = r.label ? ` · ${esc(r.label)}` : '';
    const formula = r.diceResults
      ? r.diceResults.map(d => `${d.value}`).join('+') +
        (r.modTotal !== 0 ? (r.modTotal > 0 ? '+' : '') + r.modTotal : '')
      : '';

    return `
      <div class="dice-feed-entry">
        <div class="dice-feed-row1">
          <span class="dice-feed-name">${esc(r.roller)}</span>
          <span class="dice-feed-label">${esc(r.label || poolStr(r.pool))}${vis}</span>
          <span class="dice-feed-time">${timeStr}</span>
        </div>
        <div class="dice-feed-row2">
          <span class="dice-feed-total ${totalClass}">${r.total}</span>
          <span class="dice-feed-formula">${formula}</span>
          ${nat}${dos}
        </div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Render: history
// ---------------------------------------------------------------------------

function renderHistory() {
  const container = document.getElementById('dice-history-list');
  const selector  = document.getElementById('dice-history-selector');
  if (!container) return;

  // Build character chips
  const characters = Object.keys(dice.history);
  if (selector) {
    const active = selector.querySelector('.dice-hist-chip.active')?.dataset.char || characters[0];
    selector.innerHTML = characters.map(c => `
      <button class="dice-hist-chip ${c === active ? 'active' : ''}"
              data-char="${esc(c)}"
              onclick="selectHistoryChar('${esc(c)}')">${esc(c)}</button>
    `).join('');
  }

  const activeChar = selector?.querySelector('.dice-hist-chip.active')?.dataset.char || characters[0];
  const rolls = dice.history[activeChar] || [];

  if (rolls.length === 0) {
    container.innerHTML = '<div class="dice-feed-empty">No rolls yet</div>';
    return;
  }

  container.innerHTML = rolls.map(r => {
    const nat = r.isNat20 ? '<span class="dice-nat-pill nat20 small">nat 20</span>'
              : r.isNat1  ? '<span class="dice-nat-pill nat1 small">nat 1</span>' : '';
    const formula = r.diceResults
      ? r.pool.map(p => `${p.count}d${p.sides}`).join('+') +
        (r.modTotal !== 0 ? (r.modTotal > 0 ? '+' : '') + r.modTotal : '')
      : '';
    return `
      <div class="dice-hist-row">
        <span class="dice-hist-label">${esc(r.label || poolStr(r.pool))}</span>
        <span class="dice-hist-total ${r.isNat20 ? 'nat20' : r.isNat1 ? 'nat1' : ''}">${r.total}</span>
        <span class="dice-hist-formula">${formula}</span>
        <span class="dice-hist-time">${formatTime(r.timestamp)}</span>
      </div>`;
  }).join('');
}

function selectHistoryChar(char) {
  document.querySelectorAll('.dice-hist-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.char === char);
  });
  renderHistory();
}

// ---------------------------------------------------------------------------
// Roll button label
// ---------------------------------------------------------------------------

function updateRollBtn() {
  const btn = document.getElementById('dice-roll-btn');
  if (!btn) return;
  if (dice.pool.length === 0) {
    btn.textContent = 'Select dice above';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const poolStr2 = dice.pool.map(p => `${p.count}d${p.sides}`).join(' + ');
  const mod = getModTotal();
  const modStr = mod !== 0 ? (mod > 0 ? ' + ' : ' ') + mod : '';
  btn.textContent = `Roll ${poolStr2}${modStr}`;
}

// ---------------------------------------------------------------------------
// Visibility toggle
// ---------------------------------------------------------------------------

function setVisibility(vis) {
  dice.visibility = vis;
  document.querySelectorAll('.dice-vis-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.vis === vis);
  });
}

// ---------------------------------------------------------------------------
// Feed / history tab toggle (mobile)
// ---------------------------------------------------------------------------

function switchDicePanel(panel) {
  document.querySelectorAll('.dice-panel-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.panel === panel);
  });
  document.getElementById('dice-feed-panel').style.display  = panel === 'feed'    ? 'block' : 'none';
  document.getElementById('dice-history-panel').style.display = panel === 'history' ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function poolStr(pool) {
  if (!pool) return '';
  return pool.map(p => `${p.count}d${p.sides}`).join('+');
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)  return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  return Math.floor(diff / 3600000) + 'h ago';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------------------------------------------------------------------------
// Init — called when the dice tab is first opened
// ---------------------------------------------------------------------------

let diceTabInited = false;

function initDiceTab() {
  if (diceTabInited) return;
  diceTabInited = true;

  // Wire up modifier inputs
  ['prof','item','status','circ'].forEach(type => {
    const el = document.getElementById(`dice-mod-${type}`);
    if (el) el.addEventListener('input', () => setModifier(type, el.value));
  });

  // Wire label input
  const labelEl = document.getElementById('dice-label');
  if (labelEl) labelEl.addEventListener('input', updateRollBtn);

  // Init 3D box in background
  initDiceBox();

  // Render initial state
  renderPool();
  renderFeed();
  updateRollBtn();
  updateModTotal();
  setTrayState('idle');
}

// Hook into the existing switchTab function defined in player.html
const _originalSwitchTab = typeof switchTab === 'function' ? switchTab : null;
window.switchTab = function(name) {
  if (_originalSwitchTab) _originalSwitchTab(name);
  if (name === 'dice') initDiceTab();
};
