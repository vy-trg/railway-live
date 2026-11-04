# Small official Node 22 image
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer
COPY package*.json ./
RUN npm ci --omit=dev

# Then copy the app code
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Don't run as root inside the container
USER node

CMD ["node", "server.js"]