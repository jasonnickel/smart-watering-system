FROM node:22-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package.json package-lock.json ./
RUN npm install --production

# Copy application
COPY src/ src/
COPY zones.yaml .env.example ./

# Create data directory
RUN mkdir -p /data

ENV DB_PATH=/data/taproot.db
ENV STATUS_PAGE_PATH=/data/status.html
ENV WEB_PORT=3000
ENV SHADOW_MODE=true
ENV DEBUG_LEVEL=1

EXPOSE 3000

VOLUME /data

# Default: run the web UI. Override with docker exec for CLI commands.
CMD ["node", "src/web.js"]
