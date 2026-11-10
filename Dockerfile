FROM node:22-bookworm-slim

# yt-dlp + ffmpeg (needed for YouTube audio)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app
COPY package*.json ./
# npm ci installs exactly what the committed lockfile pins. The old
# lockfile described an ancient minimal bot, so `npm install` silently
# re-resolved every dependency at image build time — what ran in
# production was whatever npm picked that day. The lockfile is now
# regenerated from package.json; keep the two in sync.
RUN npm ci --omit=dev
COPY src ./src
COPY assets ./assets

CMD ["node", "src/index.js"]
