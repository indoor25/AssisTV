# Home Assistant передаёт BUILD_FROM, но базовый образ HA тут не нужен: хватает обычного
# node:alpine (он мультиархитектурный — соберётся и на Raspberry Pi).
ARG BUILD_FROM
FROM node:20-alpine

WORKDIR /app
# mqtt — чтобы подхватывать плейлист с телевизора (топик iptv/channels) для карточки HA;
# ws и mqtt-packet — MQTT телевизоров через аддон (mqtt-proxy.js)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY build.js server.js card-data.js vod.js tmdb.js kinopoisk.js archive.js parental.js favorites.js watchlist.js plugins.js guide.js history.js pairing.js mqtt-proxy.js sandbox.js plugin-host.js ./
COPY card ./card
COPY web ./web
# shared/ — копии js/channel-name.js, js/m3u-parser.js, js/xmltv-parser.js, js/channel-match.js, js/vod-sources.js,
# js/i18n.js и lang/ из плеера; кладёт сюда ha-addon/deploy.ps1 перед копированием аддона на Pi.
# Плагины-источники в образ не входят: их ставят со страницы аддона (plugins.js).
COPY shared ./shared

# Живых данных с тремя источниками EPG ~220 МБ, при обновлении рядом лежит прежний EPG — пик ~470 МБ. Без предела куча V8 росла
# мусором до ~0,9 ГБ: сборщик мусора не торопится, пока памяти много.
CMD ["node", "--max-old-space-size=800", "server.js"]
