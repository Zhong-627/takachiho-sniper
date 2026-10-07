import type { FieldRule, ReadRequestRule } from './safety.js';

// Source: docs/evidence/observed-assets.json, captured from the actual public calendar.
// Deliberately exact paths: unobserved scripts and endpoints fail closed.
const OBSERVED_ASSET_URLS: readonly string[] = [
  "/common/library/file-compress/compress.php?target=/common/css/app.base.color.css,/common/css/app.base.cursor.css,/common/css/app.base.display.css,/common/css/app.base.font.css,/common/css/app.base.position.css,/common/css/app.base.size.css&cache=1791331614",
  "/common/js/app.js?cache=1697524949",
  "/common/library/file-compress/compress.php?target=/common/library/jQuery1.11.1/jquery.min.js,/common/js/app.base.000.jquery-extension.js,/common/js/app.base.000.jquery-dateFormatter.js,/common/js/app.base.000.jquery-dayFormatter.js,/common/js/app.base.001.type.js,/common/js/app.base.002.str.js,/common/js/app.base.003.math.js,/common/js/app.base.004.date.js,/common/js/app.base.005.format.js,/common/js/app.base.006.ajax.js,/common/js/app.base.007.display.js,/common/js/app.base.500.device.js,/common/js/app.base.501.display-util.js,/common/js/app.base.502.form.js,/common/js/app.base.503.auth.js&cache=1791331614&cache=1791331614",
  "/common/library/file-compress/compress.php?target=/common/css/app.base.501.display-util.css&cache=1791331614",
  "/common/library/file-compress/compress.php?target=/common/js/app.extra.pagetop-motion.js,/common/js/app.extra.ajax-paging.js,/common/js/app.extra.zip-address.js,/common/js/app.extra.ajax-resolve.js,/common/js/app.extra.multiple-input.js&cache=1791331614&cache=1791331614",
  "/common/library/Modernizr-2.7.1/modernizr-custom.js?cache=1503025414",
  "/common/library/Font-Awesome-6.0.0-beta2/css/fontawesome.min.css?cache=1639471696",
  "/common/library/Font-Awesome-6.0.0-beta2/css/solid.min.css?cache=1639471696",
  "/common/library/Font-Awesome-6.0.0-beta2/css/regular.min.css?cache=1639471697",
  "/common/library/Font-Awesome-6.0.0-beta2/css/brands.min.css?cache=1639471696",
  "/common/css/app.lib.fontawesome.css?cache=1639471697",
  "/common/library/Font-Awesome-EIPrO/css/eipro.css?cache=1639471696",
  "/common/library/file-compress/compress.php?target=/common/library/moment-2.22.2/moment-with-locales.min.js,/common/library/fullcalendar-3.9.0/fullcalendar.js,/common/library/fullcalendar-3.9.0/locale-all.js,/common/library/fullcalendar-scheduler-1.9.4/scheduler.js&cache=1791331614&cache=1791331614",
  "/common/library/jquery.bxslider/jquery.bxslider.min.css?cache=1503025411",
  "/common/library/jquery.bxslider/jquery.bxslider.min.js?cache=1503025411",
  "/common/library/flatpickr-master/dist/flatpickr.min.css?cache=1503025405",
  "/common/library/flatpickr-master/dist/flatpickr.min.js?cache=1503025406",
  "/common/library/select2-4.0.13/js/select2.min.js?cache=1594710684",
  "/common/js/app.lib.select2-4.0.13.boot.js?cache=1774250431",
  "/common/js/app.extra.fullcalendar.js?cache=1684158120",
  "/common/js/app.lib.elements.parts.fullcalendar_contol_bar.js?cache=1688973765",
  "/common/library/file-compress/compress.php?target=/module/Front/js/app.module.front.form.boot.js,/module/Front/js/app.module.front.fullcalendar-3.9.0.boot.js,/module/Front/js/app.module.front.jquery.bxslider.boot.js,/module/Front/js/app.module.front.flatpickr.boot.js,/module/Front/js/app.module.front.order.js,/module/Front/js/app.module.front.display.js&cache=1791331614&cache=1791331614",
  "/common/library/file-compress/compress.php?target=/module/Front/css/app.module.front.fullcalendar-3.9.0.boot.css,/module/Front/css/app.module.front.jquery.bxslider.boot.css,/module/Front/css/app.module.front.order.css,/module/Front/css/responsee.css,/module/Front/css/template-style.css,/module/Front/css/front.css,/module/Front/css/front.table.css,/module/Front/css/front.button.css,/module/Front/css/front.form.css&cache=1791331614",
  "/module/Front/js/app.page.EventCalendars.js?cache=1688973765",
  "/module/Front/css/app.page.EventCalendars.css?cache=1778550007",
  "/common/library/fullcalendar-3.9.0/fullcalendar.min.css?cache=1540194842",
  "/common/library/fullcalendar-scheduler-1.9.4/scheduler.min.css?cache=1540194840",
  "/common/library/select2-4.0.13/css/select2.min.css?cache=1594710682",
  "/common/css/app.lib.elements.parts.fullcalendar_contol_bar.css?cache=1705307558",
  "/common/img/loader.svg",
  "/module/Front/js/app.module.front.sidemenu.js?cache=1503025393"
];

const slashDate: FieldRule = { kind: 'date', separator: '/' };
const constant = (value: string): FieldRule => ({ kind: 'constant', value });

function observedAssetRules(): ReadRequestRule[] {
  return OBSERVED_ASSET_URLS.map(value => {
    const url = new URL(value, 'https://eipro.jp');
    const query: Record<string, FieldRule> = {};
    for (const name of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name);
      query[name] = name === 'cache'
        ? { kind: 'integer', min: 0, max: 9_999_999_999_999, repeat: { min: 1, max: values.length } }
        : { kind: 'constant', value: values[0] ?? '' };
    }
    return { pathname: url.pathname, method: 'GET', ...(Object.keys(query).length ? { query } : {}) };
  });
}

export const EIPRO_ORIGIN = 'https://eipro.jp';
export const HOLD_PATH = '/takachiho1/apiServices/api/hold_slot';
export const CUSTOMER_PATH = '/takachiho1/orders/add';

/** Verified, bounded schemas permit date changes without permitting a new operation. */
export const EIPRO_READ_RULES: readonly ReadRequestRule[] = [
  { pathname: '/takachiho1/terms/view/toppage', method: 'GET' },
  { pathname: '/takachiho1/eventCalendars/index', method: 'GET' },
  { pathname: '/takachiho1/manager/viewer/img/2.jpg', method: 'GET' },
  // Observed actual CSS font requests during guarded inspect on 2026-10-07.
  { pathname: '/common/font/Osaka.ttf', method: 'GET' },
  { pathname: '/common/library/Font-Awesome-6.0.0-beta2/webfonts/fa-regular-400.woff2', method: 'GET' },
  { pathname: '/common/library/Font-Awesome-6.0.0-beta2/webfonts/fa-regular-400.ttf', method: 'GET' },
  { pathname: '/common/library/Font-Awesome-6.0.0-beta2/webfonts/fa-solid-900.woff2', method: 'GET' },
  { pathname: '/common/library/Font-Awesome-6.0.0-beta2/webfonts/fa-solid-900.ttf', method: 'GET' },
  {
    pathname: '/takachiho1/eventCalendars/search',
    method: 'POST',
    form: {
      'data[conds][ServiceView][max_session_dateOver]': slashDate,
      'data[conds][ServiceView][min_session_dateUnder]': slashDate,
      action_token: { kind: 'opaque-token', minLength: 20, maxLength: 128 },
      root_action: constant('index'),
      'data[ServiceView][id]': constant(''),
      'data[ServiceView][cd]': constant(''),
      calendar_view_name: { kind: 'one-of', values: ['agendaWeek', 'agendaDay', 'month'] },
      calendar_type: { kind: 'one-of', values: ['week', 'day', 'month'] },
    },
  },
  {
    pathname: '/takachiho1/apiCalendars/api/holidays',
    method: 'POST',
    form: { 'data[start]': slashDate, 'data[end]': slashDate },
  },
  ...observedAssetRules(),
];
