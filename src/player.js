// =============================================================================
// PlayerVolumeControl
// Owns all audio playback and volume management.
// setupSocketListeners() is called externally after construction so it can
// receive the localPaused getter from the outer scope.
// =============================================================================

class PlayerVolumeControl {
  constructor(socket) {
    this.socket = socket;

    this.volumes = {
      master: 0.7,
      bgm: 1.0,
      ambience: 1.0,
      sfx: 1.0
    };

    this.audioElements = {
      bgm: null,
      ambience: null,
      sfx: new Map()
    };

    this.loadPreferences();
    this.setupUI();

    // NOTE: setupSocketListeners() is called externally after construction
    // so it can receive the localPaused getter from the outer scope
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  loadPreferences() {
    const saved = localStorage.getItem('soundboard_player_volumes');
    if (saved) {
      try {
        this.volumes = { ...this.volumes, ...JSON.parse(saved) };
      } catch (e) {
        console.error('Failed to load volume preferences:', e);
      }
    }
  }

  savePreferences() {
    localStorage.setItem('soundboard_player_volumes', JSON.stringify(this.volumes));
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  setupUI() {
    document.getElementById('volume-master').value   = this.volumes.master   * 100;
    document.getElementById('volume-bgm').value      = this.volumes.bgm      * 100;
    document.getElementById('volume-ambience').value = this.volumes.ambience  * 100;
    document.getElementById('volume-sfx').value      = this.volumes.sfx      * 100;

    this.updateVolumeDisplays();

    document.getElementById('volume-master').addEventListener('input',   (e) => this.setVolume('master',   e.target.value / 100));
    document.getElementById('volume-bgm').addEventListener('input',      (e) => this.setVolume('bgm',      e.target.value / 100));
    document.getElementById('volume-ambience').addEventListener('input', (e) => this.setVolume('ambience', e.target.value / 100));
    document.getElementById('volume-sfx').addEventListener('input',      (e) => this.setVolume('sfx',      e.target.value / 100));
    document.getElementById('reset-volumes').addEventListener('click',   ()  => this.resetVolumes());
  }

  updateVolumeDisplays() {
    document.getElementById('master-value').textContent   = Math.round(this.volumes.master   * 100) + '%';
    document.getElementById('bgm-value').textContent      = Math.round(this.volumes.bgm      * 100) + '%';
    document.getElementById('ambience-value').textContent = Math.round(this.volumes.ambience  * 100) + '%';
    document.getElementById('sfx-value').textContent      = Math.round(this.volumes.sfx      * 100) + '%';
  }

  // ---------------------------------------------------------------------------
  // Volume helpers
  // ---------------------------------------------------------------------------

  setVolume(channel, value) {
    this.volumes[channel] = value;
    this.updateVolumeDisplays();
    this.savePreferences();
    if (channel === 'master') {
      this.applyAllVolumes();
    } else {
      this.applyVolume(channel);
    }
    this.socket.emit(`player:volume:${channel}`, value);
  }

  resetVolumes() {
    this.volumes = { master: 0.7, bgm: 1.0, ambience: 1.0, sfx: 1.0 };
    document.getElementById('volume-master').value   = 70;
    document.getElementById('volume-bgm').value      = 100;
    document.getElementById('volume-ambience').value = 100;
    document.getElementById('volume-sfx').value      = 100;
    this.updateVolumeDisplays();
    this.savePreferences();
    this.applyAllVolumes();
  }

  calculateVolume(channel, dmVolume) {
    return this.volumes.master * this.volumes[channel] * dmVolume;
  }

  applyVolume(channel) {
    const audio = this.audioElements[channel];
    if (!audio) return;
    const dmVolume = parseFloat(audio.dataset.dmVolume || '1.0');
    audio.volume = this.calculateVolume(channel, dmVolume);
  }

  applyAllVolumes() {
    ['bgm', 'ambience'].forEach(ch => this.applyVolume(ch));
    this.audioElements.sfx.forEach(audio => {
      const dmVolume = parseFloat(audio.dataset.dmVolume || '1.0');
      audio.volume = this.calculateVolume('sfx', dmVolume);
    });
  }

  // ---------------------------------------------------------------------------
  // Socket listeners
  // isLocalPaused — getter function () => bool, passed in from outer scope so
  // the class can check pause state without owning it.
  // ---------------------------------------------------------------------------

  setupSocketListeners(isLocalPaused = () => false) {

    // Helper: load and play a channel from a state/event data object
    const loadChannel = (channel, data, defaultVol) => {
      if (!this.audioElements[channel]) {
        this.audioElements[channel] = document.getElementById(`${channel}-audio`);
      }
      const el = this.audioElements[channel];
      if (!el || !data.track) return;
      const dmVolume = data.volume !== undefined ? data.volume : defaultVol;
      el.src             = data.track.url || data.track;
      el.dataset.dmVolume = dmVolume;
      el.volume          = this.calculateVolume(channel, dmVolume);
      el.loop            = data.loop !== undefined ? data.loop : true;
      if (data.currentTime !== undefined) el.currentTime = data.currentTime;
      el.play().catch(e => {
        console.error(`${channel} play error:`, e);
        document.addEventListener('click', () => el.play().catch(() => {}), { once: true });
      });
    };

    // BGM — skip audio if locally paused; UI updates still fire via setupNowPlayingListeners
    this.socket.on('bgm:play', (data) => {
      console.log('BGM Play:', data);
      if (!isLocalPaused()) loadChannel('bgm', data, 0.5);
    });

    this.socket.on('bgm:pause', () => {
      // GM pause always applies regardless of local pause state
      if (this.audioElements.bgm) this.audioElements.bgm.pause();
    });

    this.socket.on('bgm:stop', () => {
      const el = this.audioElements.bgm;
      if (el) { el.pause(); el.currentTime = 0; el.src = ''; }
    });

    this.socket.on('bgm:volume', (dmVolume) => {
      if (this.audioElements.bgm) {
        this.audioElements.bgm.dataset.dmVolume = dmVolume;
        if (!isLocalPaused()) this.audioElements.bgm.volume = this.calculateVolume('bgm', dmVolume);
      }
    });

    this.socket.on('bgm:seek', (time) => {
      if (this.audioElements.bgm && !isLocalPaused()) this.audioElements.bgm.currentTime = time;
    });

    // Ambience
    this.socket.on('ambience:play', (data) => {
      console.log('Ambience Play:', data);
      if (!isLocalPaused()) loadChannel('ambience', data, 0.3);
    });

    this.socket.on('ambience:pause', () => {
      if (this.audioElements.ambience) this.audioElements.ambience.pause();
    });

    this.socket.on('ambience:stop', () => {
      const el = this.audioElements.ambience;
      if (el) { el.pause(); el.currentTime = 0; el.src = ''; }
    });

    this.socket.on('ambience:volume', (dmVolume) => {
      if (this.audioElements.ambience) {
        this.audioElements.ambience.dataset.dmVolume = dmVolume;
        if (!isLocalPaused()) this.audioElements.ambience.volume = this.calculateVolume('ambience', dmVolume);
      }
    });

    // SFX — always plays regardless of local pause (one-shot, not looping)
    this.socket.on('sfx:play', (data) => {
      if (!data || !data.url) { console.error('SFX missing url:', data); return; }
      const audio    = new Audio(data.url);
      const dmVolume = data.volume !== undefined ? data.volume : 1.0;
      audio.dataset.dmVolume = dmVolume;
      audio.volume           = this.calculateVolume('sfx', dmVolume);
      const id = Date.now() + Math.random();
      this.audioElements.sfx.set(id, audio);
      audio.addEventListener('ended', () => this.audioElements.sfx.delete(id));
      audio.play().catch(e => console.error('SFX play error:', e));
    });

    // Master stop — always applies
    this.socket.on('master:stop', () => {
      ['bgm', 'ambience'].forEach(ch => {
        const el = this.audioElements[ch];
        if (el) { el.pause(); el.currentTime = 0; el.src = ''; }
      });
      this.audioElements.sfx.forEach(a => { a.pause(); a.currentTime = 0; });
      this.audioElements.sfx.clear();
    });

    // State sync for new/reconnecting clients — skip if locally paused
    this.socket.on('state:sync', (state) => {
      console.log('State sync:', state);
      if (isLocalPaused()) return;
      if (state.bgm     && state.bgm.playing     && state.bgm.track)     loadChannel('bgm',     state.bgm,     0.5);
      if (state.ambience && state.ambience.playing && state.ambience.track) loadChannel('ambience', state.ambience, 0.3);
    });
  }
}


// =============================================================================
// App — login, local pause, socket wiring, now-playing UI
// =============================================================================

const socket = io();
let playerVolumeControl = null;
let playerName          = '';
let localPaused         = false;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function submitLogin() {
  const input = document.getElementById('player-name-input');
  const name  = input.value.trim();
  if (!name) {
    document.getElementById('login-error').textContent = 'Please enter a name to continue.';
    input.focus();
    return;
  }
  playerName = name;
  localStorage.setItem('soundboard_player_name', name);
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('header-player-name').textContent = name;
  if (typeof setAvatarInitial === 'function') setAvatarInitial(name);

  // If socket already connected register immediately, otherwise connect handler fires
  if (socket.connected) {
    registerAndInit();
  }
}

function registerAndInit() {
  socket.emit('register', { role: 'player', name: playerName });
  if (!playerVolumeControl) {
    playerVolumeControl = new PlayerVolumeControl(socket);
    playerVolumeControl.setupSocketListeners(() => localPaused);
    setupNowPlayingListeners();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('soundboard_player_name');
  const input = document.getElementById('player-name-input');
  if (saved) input.value = saved;
  input.focus();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
});

// ---------------------------------------------------------------------------
// Socket connection lifecycle
// ---------------------------------------------------------------------------

socket.on('connect', () => {
  console.log('Connected to soundboard server');
  document.getElementById('connection-status').classList.remove('disconnected');
  document.getElementById('connection-text').textContent = 'Connected to GM';

  if (playerName) {
    registerAndInit();
  }
  // If no name yet the login overlay is still showing — registerAndInit fires from submitLogin()
});

socket.on('disconnect', () => {
  console.log('Disconnected from soundboard server');
  document.getElementById('connection-status').classList.add('disconnected');
  document.getElementById('connection-text').textContent = 'Disconnected';
});

// ---------------------------------------------------------------------------
// Local pause / resume
// ---------------------------------------------------------------------------

function toggleLocalPause() {
  localPaused ? resumeLocal() : pauseLocal();
}

function pauseLocal() {
  localPaused = true;
  socket.emit('player:local:pause');

  // Freeze audio elements directly
  const bgm = document.getElementById('bgm-audio');
  const amb = document.getElementById('ambience-audio');
  if (bgm) bgm.pause();
  if (amb) amb.pause();

  // Update new UI
  document.getElementById('local-pause-btn').textContent = 'Resume & resync';
  document.getElementById('local-pause-btn').classList.add('paused');
  document.getElementById('desync-banner').classList.add('visible');
  document.getElementById('force-rejoin-banner').classList.remove('visible');
  if (typeof syncPauseCardUI === 'function') syncPauseCardUI(true);
  updateNowPlaying();
}

function resumeLocal() {
  localPaused = false;
  socket.emit('player:local:resume');
  // Actual audio snap happens when server responds with player:rejoin:state
  document.getElementById('local-pause-btn').textContent = 'Pause my audio';
  document.getElementById('local-pause-btn').classList.remove('paused');
  document.getElementById('desync-banner').classList.remove('visible');
  if (typeof syncPauseCardUI === 'function') syncPauseCardUI(false);
  updateNowPlaying();
}

function applyRejoinState(state) {
  if (!playerVolumeControl) return;

  if (state.bgm && state.bgm.playing && state.bgm.track) {
    const bgm = playerVolumeControl.audioElements.bgm || document.getElementById('bgm-audio');
    if (bgm) {
      bgm.src             = state.bgm.track.url || state.bgm.track;
      bgm.currentTime     = state.bgm.currentTime || 0;
      bgm.dataset.dmVolume = state.bgm.volume;
      bgm.volume          = playerVolumeControl.calculateVolume('bgm', state.bgm.volume);
      bgm.play().catch(e => console.error('BGM rejoin error:', e));
    }
  }

  if (state.ambience && state.ambience.playing && state.ambience.track) {
    const amb = playerVolumeControl.audioElements.ambience || document.getElementById('ambience-audio');
    if (amb) {
      amb.src             = state.ambience.track.url || state.ambience.track;
      amb.currentTime     = state.ambience.currentTime || 0;
      amb.dataset.dmVolume = state.ambience.volume;
      amb.volume          = playerVolumeControl.calculateVolume('ambience', state.ambience.volume);
      amb.play().catch(e => console.error('Ambience rejoin error:', e));
    }
  }
}

// Server responds to player:local:resume with authoritative state
socket.on('player:rejoin:state', (state) => {
  console.log('Rejoin state received:', state);
  applyRejoinState(state);
});

// GM changed tracks while player was paused — force back to live
socket.on('player:force:rejoin', (state) => {
  console.log('Force rejoin triggered by track change');
  localPaused = false;
  document.getElementById('local-pause-btn').textContent = 'Pause my audio';
  document.getElementById('local-pause-btn').classList.remove('paused');
  document.getElementById('desync-banner').classList.remove('visible');
  document.getElementById('force-rejoin-banner').classList.add('visible');
  setTimeout(() => document.getElementById('force-rejoin-banner').classList.remove('visible'), 4000);
  if (typeof syncPauseCardUI === 'function') syncPauseCardUI(false);
  applyRejoinState(state);
});

// ---------------------------------------------------------------------------
// Now Playing UI — UI only, no audio side effects
// All audio is handled exclusively by PlayerVolumeControl.setupSocketListeners()
// ---------------------------------------------------------------------------

const currentlyPlaying = { bgm: null, ambience: null };

function setupNowPlayingListeners() {
  socket.on('bgm:play',     (data) => { currentlyPlaying.bgm = data; updateNowPlaying(); });
  socket.on('bgm:stop',     ()     => { currentlyPlaying.bgm = null; updateNowPlaying(); });
  socket.on('bgm:pause',    ()     => { if (currentlyPlaying.bgm) currentlyPlaying.bgm.playing = false; updateNowPlaying(); });

  socket.on('ambience:play',  (data) => { currentlyPlaying.ambience = data; updateNowPlaying(); });
  socket.on('ambience:stop',  ()     => { currentlyPlaying.ambience = null; updateNowPlaying(); });
  socket.on('ambience:pause', ()     => { if (currentlyPlaying.ambience) currentlyPlaying.ambience.playing = false; updateNowPlaying(); });

  socket.on('master:stop', () => {
    currentlyPlaying.bgm = null;
    currentlyPlaying.ambience = null;
    updateNowPlaying();
  });

  socket.on('state:sync', (state) => {
    currentlyPlaying.bgm      = state.bgm     && state.bgm.playing     ? state.bgm     : null;
    currentlyPlaying.ambience = state.ambience && state.ambience.playing ? state.ambience : null;
    updateNowPlaying();
  });
}

function updateNowPlaying() {
  const container = document.getElementById('now-playing-content');
  const { bgm, ambience } = currentlyPlaying;

  // Update the always-visible now-playing strip
  if (typeof updateNowPlayingStrip === 'function') {
    updateNowPlayingStrip(bgm, ambience, localPaused);
  }

  // Update the detail sub-label
  const detailSub = document.getElementById('np-detail-sub');
  if (detailSub) {
    detailSub.textContent = localPaused ? 'Locally paused' : 'GM-controlled';
    detailSub.style.color = localPaused ? 'var(--amber, #ba7517)' : '';
  }

  if (!bgm && !ambience) {
    container.innerHTML = `<div class="nothing-playing">Waiting for your GM to start audio&hellip;</div>`;
    return;
  }

  let html = '';

  if (bgm && bgm.track) {
    const name   = bgm.track.name || bgm.track.filename || 'Unknown track';
    const volume = bgm.volume !== undefined ? bgm.volume : 0.5;
    const dotClass = localPaused ? 'paused-local' : 'playing';
    const nameClass = localPaused ? 'dim' : '';
    html += `
      <div class="track-row">
        <div class="track-dot ${dotClass}"></div>
        <div class="track-info">
          <div class="track-name ${nameClass}">${name}</div>
          <div class="track-type">Background music${localPaused ? ' \u00b7 paused on your end' : ' \u00b7 looping'}</div>
        </div>
        <span class="track-gm-vol">GM ${Math.round(volume * 100)}%</span>
      </div>`;
  }

  if (ambience && ambience.track) {
    const name   = ambience.track.name || ambience.track.filename || 'Unknown track';
    const volume = ambience.volume !== undefined ? ambience.volume : 0.3;
    const dotClass = localPaused ? 'paused-local' : 'playing';
    const nameClass = localPaused ? 'dim' : '';
    html += `
      <div class="track-row">
        <div class="track-dot ${dotClass}"></div>
        <div class="track-info">
          <div class="track-name ${nameClass}">${name}</div>
          <div class="track-type">Ambience${localPaused ? ' \u00b7 paused on your end' : ' \u00b7 looping'}</div>
        </div>
        <span class="track-gm-vol">GM ${Math.round(volume * 100)}%</span>
      </div>`;
  }

  container.innerHTML = html;
}