FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so code changes do not invalidate this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The GTFS archive is cached here; mount a volume to keep it across restarts
# and survive a city-portal outage on boot.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000

# /health reports 503 until the timetable is indexed, which is exactly the
# readiness signal an orchestrator wants.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
