FROM node:24-bookworm-slim

WORKDIR /app

COPY server.js ./server.js
COPY scripts/backup-database.js ./scripts/backup-database.js

RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=5178
ENV DATA_DIR=/app/data

USER node

EXPOSE 5178

CMD ["node", "server.js"]
