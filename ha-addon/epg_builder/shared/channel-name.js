/**
 * Нормализация имени канала для сопоставления плейлиста с EPG.
 *
 * Вынесено в отдельный файл, потому что нужно в двух местах с разным окружением:
 * в ChannelStore на TV и в аддоне HA (Node, ha-addon/epg_builder — туда файл копирует деплой).
 * Реализация должна оставаться одна — иначе совпадения в аддоне и на TV разъедутся.
 *
 * У нашего провайдера нет tvg-id вообще, так что имя — основной и единственный путь
 * сопоставления: убираем маркеры качества/региона и пунктуацию ("Перший HD UA" → "перший").
 */
function normalizeChannelName(name) {
    return String(name)
        .toLowerCase()
        .replace(/\b(fhd|uhd|hd|sd|4k|orig|ua|international|int)\b/gi, '')
        .replace(/[.,()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

if (typeof module !== 'undefined') module.exports = { normalizeChannelName };
