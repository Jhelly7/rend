FROM node:20-alpine

WORKDIR /app

# Instalar dependências primeiro (cache layer)
COPY package.json ./
RUN npm install --omit=dev

# Copiar código
COPY dispatcher.js ./

# Porta exposta (Railway/Render injectam PORT automaticamente)
EXPOSE 3002

# Healthcheck — Railway e Render usam isto para saber se o container está vivo
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3002}/health || exit 1

CMD ["node", "dispatcher.js"]
