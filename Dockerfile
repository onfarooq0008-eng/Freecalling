FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Koyeb injects PORT at runtime; server.js reads process.env.PORT
EXPOSE 8000

CMD ["node", "server.js"]
