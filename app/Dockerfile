FROM node:20-alpine
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Chạy dưới quyền user node có sẵn, không dùng root
USER node

EXPOSE 3000
CMD ["node", "server.js"]
