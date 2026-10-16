// Netlify Function: приймає заявку з лендінгу і додає замовлення в LP-CRM.
// Налаштування (Netlify → Site configuration → Environment variables):
//   LPCRM_KEY         – вхідний ключ API з кабінету LP-CRM        (обов'язково)
//   LPCRM_PRODUCT_ID  – ID товару в каталозі LP-CRM               (обов'язково)
//   LPCRM_OFFICE      – ID відділу (за замовчуванням 1)
//   LPCRM_HOST        – адреса кабінету (за замовчуванням kiloradar.lp-crm.biz)
//   PRICE             – ціна за одиницю, грн (за замовчуванням 990)

const PRODUCT_NAME = 'Складна 3-ярусна сушарка на коліщатках';

// --- PHP-сумісна серіалізація (LP-CRM чекає serialize() + urlencode()) ---
function phpStr(v) {
  v = String(v);
  return 's:' + Buffer.byteLength(v, 'utf8') + ':"' + v + '";';
}
function phpArr(obj) {
  const isArr = Array.isArray(obj);
  const keys = isArr ? obj.map((_, i) => i) : Object.keys(obj);
  let out = 'a:' + keys.length + ':{';
  keys.forEach((k) => {
    out += isArr ? 'i:' + k + ';' : phpStr(k);
    const v = obj[k];
    out += v !== null && typeof v === 'object' ? phpArr(v) : phpStr(v == null ? '' : v);
  });
  return out + '}';
}
function phpUrlencode(s) {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { ok: false });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return reply(400, { ok: false });
  }

  // пастка для ботів: приховане поле має бути порожнім
  if (body.website) return reply(200, { ok: true });

  const name = String(body.name || '').trim().slice(0, 100);
  const rawPhone = String(body.phone || '').replace(/[\s\-()]/g, '');
  const qty = Math.min(Math.max(parseInt(body.qty, 10) || 1, 1), 10);

  if (name.length < 2 || !/^(\+?38)?0\d{9}$/.test(rawPhone)) {
    return reply(400, { ok: false, error: 'validation' });
  }
  const phone = '+38' + rawPhone.slice(-10);

  const key = process.env.LPCRM_KEY;
  const productId = process.env.LPCRM_PRODUCT_ID;
  if (!key || !productId) {
    console.error('LP-CRM: не задано LPCRM_KEY або LPCRM_PRODUCT_ID');
    return reply(500, { ok: false });
  }
  const host = process.env.LPCRM_HOST || 'kiloradar.lp-crm.biz';
  const office = process.env.LPCRM_OFFICE || '1';
  const price = String(process.env.PRICE || 990); // ціну беремо тільки на сервері

  const products = [{ product_id: String(productId), price, count: String(qty) }];
  const h = event.headers || {};
  const ip = h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim();
  const sender = {
    REMOTE_ADDR: ip,
    HTTP_USER_AGENT: h['user-agent'] || '',
    HTTP_REFERER: h['referer'] || '',
    HTTP_HOST: h['host'] || '',
  };
  const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};
  const orderId = String(Math.round((Date.now() / 1000) * 10)) + String(10000 + Math.floor(Math.random() * 90000));

  const fields = {
    key,
    order_id: orderId,
    country: 'UA',
    office,
    products: phpUrlencode(phpArr(products)),
    bayer_name: name,
    phone,
    comment: PRODUCT_NAME + ' (лендінг)',
    sender: phpUrlencode(phpArr(sender)),
    utm_source: String(utm.utm_source || ''),
    utm_medium: String(utm.utm_medium || ''),
    utm_term: String(utm.utm_term || ''),
    utm_content: String(utm.utm_content || ''),
    utm_campaign: String(utm.utm_campaign || ''),
  };

  const fd = new FormData();
  Object.keys(fields).forEach((k) => fd.append(k, fields[k]));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://' + host + '/api/addNewOrder.html', {
      method: 'POST',
      body: fd,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) {}
    if (json.status === 'ok') return reply(200, { ok: true });
    console.error('LP-CRM відхилила замовлення:', (json.message || text).slice(0, 300));
    return reply(502, { ok: false });
  } catch (err) {
    console.error('LP-CRM недоступна:', err && err.message);
    return reply(502, { ok: false });
  } finally {
    clearTimeout(timer);
  }
};
