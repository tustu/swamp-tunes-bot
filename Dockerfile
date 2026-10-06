FROM node:20-bookworm-slim

# yt-dlp + ffmpeg (needed for YouTube audio)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

CMD ["node", "src/index.js"]
