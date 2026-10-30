/**
 * Умолчания своей сборки: адрес аддона и брокера, чтобы не вводить их на каждом TV.
 * В репозитории — пусто. tools/build-wgt.ps1 -Defaults <файл> кладёт на его место свой, например:
 *   window.LOCAL_DEFAULTS = { addonUrl: 'http://192.168.1.10:8765', mqtt: { host: '192.168.1.10' } };
 */
window.LOCAL_DEFAULTS = window.LOCAL_DEFAULTS || {};
