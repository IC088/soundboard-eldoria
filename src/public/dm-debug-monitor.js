// DM Side Debug Monitor
// Add this to your DM view (index.html) after socket initialization

console.log('🔍 DM Debug Monitor Initialized');

// Monitor state every 5 seconds
setInterval(() => {
  const bgmAudio = document.getElementById('bgm-audio');
  const ambienceAudio = document.getElementById('ambience-audio');
  
  console.log('========================================');
  console.log('🎮 DM STATE CHECK @ ' + new Date().toLocaleTimeString());
  console.log('========================================');
  
  if (bgmAudio) {
    console.log('🎵 BGM Audio:');
    console.log('  - Source:', bgmAudio.src || 'None');
    console.log('  - Paused:', bgmAudio.paused);
    console.log('  - Current Time:', bgmAudio.currentTime.toFixed(2) + 's');
    console.log('  - Duration:', bgmAudio.duration.toFixed(2) + 's');
    console.log('  - Volume:', bgmAudio.volume.toFixed(2));
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
    console.log('  - Loop:', ambienceAudio.loop);
  } else {
    console.log('🌊 Ambience Audio: Element not found');
  }
  
  console.log('========================================\n');
}, 5000);

// Monitor socket emissions
const originalEmit = socket.emit.bind(socket);
socket.emit = function(event, ...args) {
  if (event.includes('bgm') || event.includes('ambience') || event.includes('sync')) {
    console.log('📤 DM EMITTING:', event, args);
  }
  return originalEmit(event, ...args);
};

// Monitor socket events received
socket.onAny((event, ...args) => {
  if (event.includes('bgm') || event.includes('ambience') || event.includes('sync')) {
    console.log('📥 DM RECEIVED:', event, args);
  }
});

console.log('✅ DM Debug Monitor Active - Check console every 5 seconds');
