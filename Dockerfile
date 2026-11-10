FROM node:22-bookworm-slim

# yt-dlp + ffmpeg (needed for YouTube audio)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY assets ./assets

CMD ["node", "src/index.js"]
