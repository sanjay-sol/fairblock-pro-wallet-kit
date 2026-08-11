# Cloud Run image for the Stabletrust Pro backend.
# Lightweight Node server — NO WASM/proving (that's all client-side), so this stays small.
FROM node:22-slim

WORKDIR /app

# Install prod deps first (cached layer unless package files change).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (secrets + node_modules excluded via .dockerignore).
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT (usually 8080); server.mjs reads process.env.PORT and binds 0.0.0.0.
CMD ["node", "server.mjs"]
