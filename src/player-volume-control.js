// Player Volume Control Implementation
// Add this to your player.html or player JavaScript file

class PlayerVolumeControl {
  constructor(socket) {
    this.socket = socket;
    
    // Player volume settings (stored locally)
    this.volumes = {
      master: 0.7,      // Master volume for all audio
      bgm: 1.0,         // BGM multiplier
      ambience: 1.0,    // Ambience multiplier
      sfx: 1.0          // SFX multiplier
    };
    
    // Audio elements
    this.audioElements = {
      bgm: null,
      ambience: null,
      sfx: new Map() // SFX are one-shot, so we track multiple
    };
    
    // Load saved preferences from localStorage
    this.loadPreferences();
    
    // Setup UI controls
    this.setupUI();
    
    // Setup socket listeners
    this.setupSocketListeners();
  }
  
  // Load player preferences from localStorage
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
  
  // Save player preferences to localStorage
  savePreferences() {
    localStorage.setItem('soundboard_player_volumes', JSON.stringify(this.volumes));
  }
  
  // Setup UI controls for volume
  setupUI() {
    // Create volume control panel
    const panel = document.createElement('div');
    panel.id = 'player-volume-panel';
    panel.innerHTML = `
      <div class="volume-panel">
        <h3>🔊 Your Volume Controls</h3>
        
        <!-- Master Volume -->
        <div class="volume-control master-volume">
          <label>
            <span class="volume-label">Master Volume</span>
            <span class="volume-value" id="master-value">70%</span>
          </label>
          <input type="range" id="volume-master" min="0" max="100" value="70" step="1">
          <small>Controls all audio</small>
        </div>
        
        <!-- BGM Volume -->
        <div class="volume-control">
          <label>
            <span class="volume-label">Background Music</span>
            <span class="volume-value" id="bgm-value">100%</span>
          </label>
          <input type="range" id="volume-bgm" min="0" max="100" value="100" step="1">
          <small>Your BGM level</small>
        </div>
        
        <!-- Ambience Volume -->
        <div class="volume-control">
          <label>
            <span class="volume-label">Ambience</span>
            <span class="volume-value" id="ambience-value">100%</span>
          </label>
          <input type="range" id="volume-ambience" min="0" max="100" value="100" step="1">
          <small>Your ambience level</small>
        </div>
        
        <!-- SFX Volume -->
        <div class="volume-control">
          <label>
            <span class="volume-label">Sound Effects</span>
            <span class="volume-value" id="sfx-value">100%</span>
          </label>
          <input type="range" id="volume-sfx" min="0" max="100" value="100" step="1">
          <small>Your SFX level</small>
        </div>
        
        <button id="reset-volumes" class="btn-secondary">Reset to Defaults</button>
      </div>
    `;
    
    // Add to page (adjust selector as needed)
    const container = document.querySelector('.player-controls') || document.body;
    container.insertBefore(panel, container.firstChild);
    
    // Set initial slider values from saved preferences
    document.getElementById('volume-master').value = this.volumes.master * 100;
    document.getElementById('volume-bgm').value = this.volumes.bgm * 100;
    document.getElementById('volume-ambience').value = this.volumes.ambience * 100;
    document.getElementById('volume-sfx').value = this.volumes.sfx * 100;
    
    this.updateVolumeDisplays();
    
    // Attach event listeners
    document.getElementById('volume-master').addEventListener('input', (e) => {
      this.setVolume('master', e.target.value / 100);
    });
    
    document.getElementById('volume-bgm').addEventListener('input', (e) => {
      this.setVolume('bgm', e.target.value / 100);
    });
    
    document.getElementById('volume-ambience').addEventListener('input', (e) => {
      this.setVolume('ambience', e.target.value / 100);
    });
    
    document.getElementById('volume-sfx').addEventListener('input', (e) => {
      this.setVolume('sfx', e.target.value / 100);
    });
    
    document.getElementById('reset-volumes').addEventListener('click', () => {
      this.resetVolumes();
    });
  }
  
  // Update volume display percentages
  updateVolumeDisplays() {
    document.getElementById('master-value').textContent = Math.round(this.volumes.master * 100) + '%';
    document.getElementById('bgm-value').textContent = Math.round(this.volumes.bgm * 100) + '%';
    document.getElementById('ambience-value').textContent = Math.round(this.volumes.ambience * 100) + '%';
    document.getElementById('sfx-value').textContent = Math.round(this.volumes.sfx * 100) + '%';
  }
  
  // Set volume for a specific channel
  setVolume(channel, value) {
    this.volumes[channel] = value;
    this.updateVolumeDisplays();
    this.savePreferences();
    
    // Apply to currently playing audio
    if (channel === 'master') {
      this.applyAllVolumes();
    } else {
      this.applyVolume(channel);
    }
    
    // Optional: Send to server for logging
    this.socket.emit(`player:volume:${channel}`, value);
  }
  
  // Reset all volumes to defaults
  resetVolumes() {
    this.volumes = {
      master: 0.7,
      bgm: 1.0,
      ambience: 1.0,
      sfx: 1.0
    };
    
    document.getElementById('volume-master').value = 70;
    document.getElementById('volume-bgm').value = 100;
    document.getElementById('volume-ambience').value = 100;
    document.getElementById('volume-sfx').value = 100;
    
    this.updateVolumeDisplays();
    this.savePreferences();
    this.applyAllVolumes();
  }
  
  // Calculate final volume for a channel
  calculateVolume(channel, dmVolume) {
    return this.volumes.master * this.volumes[channel] * dmVolume;
  }
  
  // Apply volume to a specific channel
  applyVolume(channel) {
    const audio = this.audioElements[channel];
    if (!audio) return;
    
    // Get the DM's volume from the audio element's dataset
    const dmVolume = parseFloat(audio.dataset.dmVolume || '1.0');
    audio.volume = this.calculateVolume(channel, dmVolume);
  }
  
  // Apply all volumes
  applyAllVolumes() {
    ['bgm', 'ambience'].forEach(channel => this.applyVolume(channel));
    
    // Apply to all active SFX
    this.audioElements.sfx.forEach(audio => {
      const dmVolume = parseFloat(audio.dataset.dmVolume || '1.0');
      audio.volume = this.calculateVolume('sfx', dmVolume);
    });
  }
  
  // Setup socket listeners
  setupSocketListeners() {
    // BGM events
    this.socket.on('bgm:play', (data) => {
      if (!this.audioElements.bgm) {
        this.audioElements.bgm = document.getElementById('bgm-audio');
      }
      
      if (this.audioElements.bgm) {
        const dmVolume = data.volume || 0.5;
        this.audioElements.bgm.dataset.dmVolume = dmVolume;
        this.audioElements.bgm.volume = this.calculateVolume('bgm', dmVolume);
      }
    });
    
    this.socket.on('bgm:volume', (dmVolume) => {
      if (this.audioElements.bgm) {
        this.audioElements.bgm.dataset.dmVolume = dmVolume;
        this.audioElements.bgm.volume = this.calculateVolume('bgm', dmVolume);
      }
    });
    
    // Ambience events
    this.socket.on('ambience:play', (data) => {
      if (!this.audioElements.ambience) {
        this.audioElements.ambience = document.getElementById('ambience-audio');
      }
      
      if (this.audioElements.ambience) {
        const dmVolume = data.volume || 0.3;
        this.audioElements.ambience.dataset.dmVolume = dmVolume;
        this.audioElements.ambience.volume = this.calculateVolume('ambience', dmVolume);
      }
    });
    
    this.socket.on('ambience:volume', (dmVolume) => {
      if (this.audioElements.ambience) {
        this.audioElements.ambience.dataset.dmVolume = dmVolume;
        this.audioElements.ambience.volume = this.calculateVolume('ambience', dmVolume);
      }
    });
    
    // SFX events
    this.socket.on('sfx:play', (data) => {
      // Create new audio element for this SFX
      const audio = new Audio(data.url);
      const dmVolume = data.volume || 1.0;
      
      audio.dataset.dmVolume = dmVolume;
      audio.volume = this.calculateVolume('sfx', dmVolume);
      
      // Track it
      const id = Date.now() + Math.random();
      this.audioElements.sfx.set(id, audio);
      
      // Remove from tracking when done
      audio.addEventListener('ended', () => {
        this.audioElements.sfx.delete(id);
      });
      
      audio.play().catch(e => console.error('SFX play error:', e));
    });
    
    // State sync for new connections
    this.socket.on('state:sync', (state) => {
      // Apply volumes to existing audio when reconnecting
      if (state.bgm.playing && this.audioElements.bgm) {
        this.audioElements.bgm.dataset.dmVolume = state.bgm.volume;
        this.applyVolume('bgm');
      }
      
      if (state.ambience.playing && this.audioElements.ambience) {
        this.audioElements.ambience.dataset.dmVolume = state.ambience.volume;
        this.applyVolume('ambience');
      }
    });
  }
}

// CSS for volume panel (add to your stylesheet)
const volumePanelStyles = `
.volume-panel {
  background: rgba(30, 30, 30, 0.95);
  border: 2px solid rgba(255, 180, 50, 0.5);
  border-radius: 10px;
  padding: 20px;
  margin: 20px 0;
  backdrop-filter: blur(10px);
}

.volume-panel h3 {
  margin: 0 0 20px 0;
  color: #ffb432;
  text-align: center;
  font-size: 1.3em;
}

.volume-control {
  margin-bottom: 20px;
  padding: 15px;
  background: rgba(50, 50, 50, 0.5);
  border-radius: 8px;
}

.volume-control.master-volume {
  background: rgba(255, 180, 50, 0.1);
  border: 1px solid rgba(255, 180, 50, 0.3);
}

.volume-control label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  font-weight: bold;
  color: #fff;
}

.volume-label {
  font-size: 1em;
}

.volume-value {
  color: #ffb432;
  font-size: 1.1em;
  min-width: 50px;
  text-align: right;
}

.volume-control input[type="range"] {
  width: 100%;
  height: 8px;
  border-radius: 5px;
  background: rgba(100, 100, 100, 0.5);
  outline: none;
  -webkit-appearance: none;
}

.volume-control input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #ffb432;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(255, 180, 50, 0.5);
}

.volume-control input[type="range"]::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #ffb432;
  cursor: pointer;
  border: none;
  box-shadow: 0 0 10px rgba(255, 180, 50, 0.5);
}

.volume-control input[type="range"]:hover::-webkit-slider-thumb {
  background: #ffc84d;
  box-shadow: 0 0 15px rgba(255, 180, 50, 0.8);
}

.volume-control small {
  display: block;
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.85em;
  margin-top: 5px;
}

#reset-volumes {
  width: 100%;
  margin-top: 10px;
  padding: 10px;
  background: rgba(100, 100, 100, 0.3);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.3s;
}

#reset-volumes:hover {
  background: rgba(100, 100, 100, 0.5);
  border-color: #ffb432;
}
`;

// Initialize when socket is ready
// Add this to your existing player.html JavaScript:
/*
const socket = io();

socket.on('connect', () => {
  socket.emit('register', 'player');
  
  // Initialize player volume control
  window.playerVolumeControl = new PlayerVolumeControl(socket);
});
*/

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlayerVolumeControl, volumePanelStyles };
}
