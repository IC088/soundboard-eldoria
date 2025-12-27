FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY src/package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY src/ ./

# Create audio directories with proper permissions
RUN mkdir -p /app/audio/bgm /app/audio/ambience /app/audio/sfx && \
    chmod -R 777 /app/audio

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]