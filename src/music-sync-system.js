// Real-Time Music Sync System
// This ensures ALL clients stay perfectly synchronized during playback

class MusicSyncSystem {
  constructor(socket, role = 'player') {
    this.socket = socket;
    this.role = role; // 'dm' or 'player'
    
    // Audio elements
    this.audioElements = {
      bgm: null,
      ambience: null
    };
    
    // Sync state
    this.syncState = {
      bgm: {
        isPlaying: false,
        lastSyncTime: 0,
        targetTime: 0,
        syncedAt: 0
      },
      ambience: {
        isPlaying: false,
        lastSyncTime: 0,
        targetTime: 0,
        syncedAt: 0
      }
    };
    
    // Sync intervals
    this.syncIntervals = {
      dm: null,      // DM broadcasts position every 3 seconds
      player: null   // Players check drift every 1 second
    };
    
    // Sync tolerance (seconds)
    this.SYNC_TOLERANCE = 0.5;  // Resync if drift > 0.5s
    this.BROADCAST_INTERVAL = 3000;  // DM broadcasts every 3s
    this.CHECK_INTERVAL = 1000;      // Players check every 1s
  }
  
  // Initialize with audio elements
  init(bgmElement, ambienceElement) {
    this.audioElements.bgm = bgmElement;
    this.audioElements.ambience = ambienceElement;
    
    // Setup socket listeners
    this.setupSocketListeners();
    
    // Start appropriate sync based on role
    if (this.role === 'dm') {
      this.startDMSync();
    } else {
      this.startPlayerSync();
    }
  }
  
  // Setup socket event listeners
  setupSocketListeners() {
    // Listen for sync broadcasts (all clients)
    this.socket.on('sync:broadcast', (data) => {
      this.handleSyncBroadcast(data);
    });
    
    // Listen for initial state sync on connection (players only)
    this.socket.on('state:sync', (state) => {
      if (this.role === 'dm') return; // DM doesn't need state sync
      
      console.log('[Sync] Received state:sync on connection');
      
      // Treat state:sync like a sync broadcast with zero latency
      const syncData = {
        timestamp: Date.now(),
        bgm: state.bgm,
        ambience: state.ambience
      };
      
      this.handleSyncBroadcast(syncData);
    });
    
    // Listen for manual sync requests
    this.socket.on('sync:request', () => {
      if (this.role === 'dm') {
        this.broadcastSync();
      }
    });
  }
  
  // DM: Start broadcasting current position
  startDMSync() {
    console.log('[Sync] Starting DM broadcast mode');
    
    // Broadcast every 3 seconds
    this.syncIntervals.dm = setInterval(() => {
      this.broadcastSync();
    }, this.BROADCAST_INTERVAL);
  }
  
  // DM: Broadcast current playback position
  broadcastSync() {
    const syncData = {
      timestamp: Date.now(),
      bgm: this.getBGMState(),
      ambience: this.getAmbienceState()
    };
    
    console.log('[Sync] Broadcasting:', syncData);
    this.socket.emit('sync:broadcast', syncData);
  }
  
  // Get current BGM state
  getBGMState() {
    if (!this.audioElements.bgm) return null;
    
    const audio = this.audioElements.bgm;
    return {
      isPlaying: !audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      loop: audio.loop,
      volume: audio.volume,
      src: audio.src
    };
  }
  
  // Get current Ambience state
  getAmbienceState() {
    if (!this.audioElements.ambience) return null;
    
    const audio = this.audioElements.ambience;
    return {
      isPlaying: !audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      loop: audio.loop,
      volume: audio.volume,
      src: audio.src
    };
  }
  
  // Player: Start checking for drift
  startPlayerSync() {
    console.log('[Sync] Starting player sync mode');
    
    // Check drift every second
    this.syncIntervals.player = setInterval(() => {
      this.checkDrift();
    }, this.CHECK_INTERVAL);
  }
  
  // Handle sync broadcast from DM
  handleSyncBroadcast(data) {
    if (this.role === 'dm') return; // DM doesn't sync to itself
    
    const now = Date.now();
    const latency = now - data.timestamp;
    
    console.log(`[Sync] Received broadcast (latency: ${latency}ms)`);
    
    // Sync BGM
    if (data.bgm) {
      this.syncAudio('bgm', data.bgm, latency);
    }
    
    // Sync Ambience
    if (data.ambience) {
      this.syncAudio('ambience', data.ambience, latency);
    }
  }
  
  // Sync audio element to received state
  syncAudio(channel, state, latency) {
    const audio = this.audioElements[channel];
    if (!audio) {
      console.log(`[Sync] ${channel.toUpperCase()} audio element not found`);
      return;
    }
    
    // Check if this channel is actually playing
    if (!state || !state.isPlaying) {
      console.log(`[Sync] ${channel.toUpperCase()} not playing, skipping`);
      return;
    }
    
    // Get the source URL - try multiple places
    const srcUrl = state.src || (state.track && state.track.url) || null;
    
    if (!srcUrl) {
      console.log(`[Sync] ${channel.toUpperCase()} has no source URL, skipping`);
      return;
    }
    
    // Set source if it's different
    if (audio.src !== srcUrl) {
      console.log(`[Sync] ${channel.toUpperCase()} setting source: ${srcUrl}`);
      audio.src = srcUrl;
    }
    
    // Set loop
    if (state.loop !== undefined) {
      audio.loop = state.loop;
    }
    
    // Calculate target time (accounting for network latency)
    const latencySeconds = latency / 1000;
    const targetTime = state.currentTime + latencySeconds;
    
    // Store sync state
    this.syncState[channel] = {
      isPlaying: state.isPlaying,
      lastSyncTime: Date.now(),
      targetTime: targetTime,
      syncedAt: Date.now()
    };
    
    // Apply volume from PlayerVolumeControl if it exists
    if (window.playerVolumeControl && audio.dataset.dmVolume) {
      const dmVolume = parseFloat(audio.dataset.dmVolume);
      audio.volume = window.playerVolumeControl.calculateVolume(channel, dmVolume);
    } else if (state.volume !== undefined) {
      audio.volume = state.volume;
      audio.dataset.dmVolume = state.volume;
    }
    
    // If playing state changed
    if (state.isPlaying && audio.paused) {
      console.log(`[Sync] ${channel.toUpperCase()} starting playback at ${targetTime.toFixed(2)}s`);
      audio.currentTime = targetTime;
      audio.play().catch(e => {
        console.error(`[Sync] Play error:`, e);
        // Retry on user interaction
        document.addEventListener('click', () => {
          audio.currentTime = targetTime;
          audio.play().catch(err => console.log('[Sync] Still blocked:', err));
        }, { once: true });
      });
    } else if (!state.isPlaying && !audio.paused) {
      console.log(`[Sync] ${channel.toUpperCase()} pausing`);
      audio.pause();
    }
    
    // If already playing, check for drift
    if (state.isPlaying && !audio.paused) {
      const currentDrift = Math.abs(audio.currentTime - targetTime);
      
      if (currentDrift > this.SYNC_TOLERANCE) {
        console.log(`[Sync] ${channel.toUpperCase()} drift detected: ${currentDrift.toFixed(2)}s, resyncing to ${targetTime.toFixed(2)}s`);
        audio.currentTime = targetTime;
      }
    }
  }
  
  // Player: Check for drift and correct
  checkDrift() {
    if (this.role === 'dm') return;
    
    ['bgm', 'ambience'].forEach(channel => {
      const audio = this.audioElements[channel];
      const state = this.syncState[channel];
      
      if (!audio || !state.isPlaying) return;
      
      // Calculate expected position
      const timeSinceSync = (Date.now() - state.syncedAt) / 1000;
      const expectedTime = state.targetTime + timeSinceSync;
      const actualTime = audio.currentTime;
      const drift = Math.abs(expectedTime - actualTime);
      
      // If drift exceeds tolerance, correct it
      if (drift > this.SYNC_TOLERANCE) {
        console.log(`[Sync] ${channel.toUpperCase()} drift correction: ${drift.toFixed(2)}s`);
        audio.currentTime = expectedTime;
      }
    });
  }
  
  // Request immediate sync (for players)
  requestSync() {
    console.log('[Sync] Requesting sync from DM');
    this.socket.emit('sync:request');
  }
  
  // Stop all syncing
  stop() {
    console.log('[Sync] Stopping sync system');
    
    if (this.syncIntervals.dm) {
      clearInterval(this.syncIntervals.dm);
      this.syncIntervals.dm = null;
    }
    
    if (this.syncIntervals.player) {
      clearInterval(this.syncIntervals.player);
      this.syncIntervals.player = null;
    }
  }
  
  // Get sync statistics (for debugging)
  getStats() {
    const stats = {};
    
    ['bgm', 'ambience'].forEach(channel => {
      const audio = this.audioElements[channel];
      const state = this.syncState[channel];
      
      if (audio && state.isPlaying) {
        const timeSinceSync = (Date.now() - state.syncedAt) / 1000;
        const expectedTime = state.targetTime + timeSinceSync;
        const drift = audio.currentTime - expectedTime;
        
        stats[channel] = {
          currentTime: audio.currentTime.toFixed(2),
          expectedTime: expectedTime.toFixed(2),
          drift: drift.toFixed(3),
          timeSinceSync: timeSinceSync.toFixed(1)
        };
      }
    });
    
    return stats;
  }
  
  // Cleanup
  destroy() {
    this.stop();
    this.audioElements = { bgm: null, ambience: null };
    this.syncState = {
      bgm: { isPlaying: false, lastSyncTime: 0, targetTime: 0, syncedAt: 0 },
      ambience: { isPlaying: false, lastSyncTime: 0, targetTime: 0, syncedAt: 0 }
    };
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MusicSyncSystem;
}