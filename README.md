# TTRPG Soundboard

A real-time soundboard and BGM streaming app for tabletop RPG sessions. The DM controls the music while players hear synchronized audio.

## Features

- **Dual Audio Channels**: Separate BGM and Ambience tracks that can play simultaneously
- **Real-time Sync**: All players hear the same audio at the same time via WebSocket
- **SFX Pads**: Quick one-shot sound effects for dramatic moments
- **Fade Controls**: Smooth fade in/out for cinematic transitions
- **Drag & Drop**: Easy track assignment via drag and drop
- **File Upload**: Upload MP3, WAV, OGG, M4A, FLAC, and WebM files
- **Loop Toggle**: Enable/disable looping per channel
- **Progress Seeking**: Click to seek within tracks
- **Master Controls**: Stop all audio or fade everything out at once

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Clone or download the project
cd soundboard

# Start the server
docker compose up -d

# View logs
docker compose logs -f
```

### Without Docker

```bash
cd src
npm install
npm start
```

## Usage

1. **DM View**: Open `http://localhost:3000` in your browser
2. **Player View**: Share `http://<your-ip>:3000/player.html` with your players

### Finding Your IP

```bash
# Linux/Mac
hostname -I | awk '{print $1}'

# Windows
ipconfig | findstr IPv4
```

Players on the same network can access the player view using your local IP address.

## File Structure

```
soundboard/
├── docker-compose.yml
├── Dockerfile
├── audio/                    # Uploaded audio files (persisted)
└── src/
    ├── package.json
    ├── server.js             # Node.js/Express/Socket.IO server
    └── public/
        ├── index.html        # DM control panel
        └── player.html       # Player view (read-only)
```

## DM Controls

| Control | Description |
|---------|-------------|
| **Library** | Browse and search uploaded tracks |
| **Upload** | Add new audio files (up to 100MB each) |
| **BGM/Ambience Buttons** | Quick-assign tracks to channels |
| **SFX Button** | Play track as one-shot sound effect |
| **Drag & Drop** | Drag tracks onto channel drop zones |
| **Transport** | Play, pause, stop, seek forward/back |
| **Volume Slider** | Adjust channel volume |
| **Loop Toggle** | Enable/disable track looping |
| **Fade In/Out** | 2-second fade transitions |
| **Master Controls** | Fade all or stop all audio |

## Tips for Sessions

1. **Pre-load tracks**: Upload your session's music before players join
2. **Layer audio**: Use BGM for music and Ambience for environmental sounds
3. **SFX pads**: The first 12 tracks appear as quick-access pads
4. **Fade transitions**: Use fade out/in for scene changes
5. **Search**: Use the search box to quickly find tracks during play

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | development | Environment mode |

## Troubleshooting

### Players can't hear audio
- Browsers require user interaction before playing audio
- Players should click anywhere on the page after connecting
- Check that players are using `http://`, not `https://`

### Audio not syncing perfectly
- Minor sync differences are normal due to network latency
- Audio syncs on play commands; existing playback continues from current position

### Can't upload files
- Check file size (max 100MB per file)
- Supported formats: MP3, WAV, OGG, M4A, FLAC, WebM

## License

MIT - Use freely for your games!
