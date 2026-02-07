// Player Side Debug Monitor
// Add this to your player.html after socket initialization

console.log('🔍 PLAYER Debug Monitor Initialized');

// Monitor state every 5 seconds
setInterval(() => {
  const bgmAudio = document.getElementById('bgm-audio');
  const ambienceAudio = document.getElementById('ambience-audio');
  
  console.log('========================================');
  console.log('👤 PLAYER STATE CHECK @ ' + new Date().toLocaleTimeString());
  console.log('========================================');
  
  if (bgmAudio) {
    console.log('🎵 BGM Audio:');
    console.log('  - Source:', bgmAudio.src || 'None');
    console.log('  - Paused:', bgmAudio.paused);
    console.log('  - Current Time:', bgmAudio.currentTime.toFixed(2) + 's');
    console.log('  - Duration:', bgmAudio.duration.toFixed(2) + 's');
    console.log('  - Volume:', bgmAudio.volume.toFixed(2));
    console.log('  - DM Volume:', bgmAudio.dataset.dmVolume);
    console.log('  - Loop:', bgmAudio.loop);
  } else {
    console.log('🎵 BGM Audio: Element not found');
  }
  
  if (ambienceAudio) {
    console.log('🌊 Ambience Audio:');
    console.log('  - Source:', ambienceAudio.src || 'None');
    console.log('  - Paused:', ambienceAudio.paused);
    console.log('  - Current Time:', ambienceAudio.currentTime.toFixed(2) + 's');
    console.log('  - Duration:', ambienceAudio.duration.toFixed(2) + 's');
    console.log('  - Volume:', ambienceAudio.volume.toFixed(2));
    console.log('  - DM Volume:', ambienceAudio.dataset.dmVolume);
    console.log('  - Loop:', ambienceAudio.loop);
  } else {
    console.log('🌊 Ambience Audio: Element not found');
  }
  
  // Check MusicSyncSystem state
  if (window.musicSync) {
    console.log('🔄 MusicSyncSystem:');
    const stats = window.musicSync.getStats();
    console.log('  - Stats:', stats);
  } else {
    console.log('🔄 MusicSyncSystem: Not initialized');
  }
  
  // Check PlayerVolumeControl state
  if (window.playerVolumeControl) {
    console.log('🔊 PlayerVolumeControl:');
    console.log('  - Volumes:', window.playerVolumeControl.volumes);
  } else {
    console.log('🔊 PlayerVolumeControl: Not initialized');
  }
  
  console.log('========================================\n');
}, 5000);

// Monitor socket emissions
const originalEmit = socket.emit.bind(socket);
socket.emit = function(event, ...args) {
  if (event.includes('bgm') || event.includes('ambience') || event.includes('sync') || event.includes('register')) {
    console.log('📤 PLAYER EMITTING:', event, args);
  }
  return originalEmit(event, ...args);
};

// Monitor socket events received
socket.onAny((event, ...args) => {
  if (event.includes('bgm') || event.includes('ambience') || event.includes('sync') || event.includes('state')) {
    console.log('📥 PLAYER RECEIVED:', event, args);
  }
});

console.log('✅ PLAYER Debug Monitor Active - Check console every 5 seconds');
