// Vercel Serverless (Node 18+). Rotas: /api/checkout, /api/webhook, /api/status
// Variáveis de ambiente: ORDER_SECRET (texto aleatório longo), SITE_URL (https://seusite.com.br),
// INFINITEPAY_HANDLE (padrão: primeburgersmg), TELEGRAM_TOKEN e TELEGRAM_CHAT (opcionais, aviso à loja)
const crypto = require('crypto');
const MENU = {
  xb: ['X-Burger', 18.9], xbc: ['X-Bacon', 22.9], xsal: ['X-Salada', 20.9],
  xtudo: ['X-Tudo', 29.9], bat: ['Batata Frita', 14.9], ref: ['Refrigerante Lata', 6]
};
const HANDLE = process.env.INFINITEPAY_HANDLE || 'primeburgersmg';
const SITE = (process.env.SITE_URL || '').replace(/\/$/, '');
const SECRET = process.env.ORDER_SECRET || '';
const sign = (id, c) => crypto.createHmac('sha256', SECRET).update(id + '.' + c).digest('hex').slice(0, 12);

// order_nsu = PB-<id>-<centavos>-<assinatura>: prova que o pedido nasceu no seu servidor e guarda o valor
function parse(nsu) {
  const p = String(nsu || '').split('-');
  if (p.length !== 4 || p[0] !== 'PB') return null;
  const cents = +p[2];
  if (!(cents > 0) || sign(p[1], cents) !== p[3]) return null;
  return { id: p[1], cents };
}

async function check(o, q) {
  const r = await fetch('https://api.infinitepay.io/invoices/public/checkout/payment_check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: HANDLE, order_nsu: q.order_nsu, transaction_nsu: q.transaction_nsu, slug: q.slug })
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.paid && d.paid_amount >= o.cents ? d : null;
}

async function notify(b, d) {
  const txt = `✅ Pedido pago #${b.order_nsu.split('-')[1]}\n` +
    (b.items || []).map(i => `${i.quantity}× ${i.description}`).join('\n') +
    `\nTotal: R$ ${(d.paid_amount / 100).toFixed(2)} (${d.capture_method})\n${b.receipt_url || ''}`;
  console.log(txt);
  const t = process.env.TELEGRAM_TOKEN, c = process.env.TELEGRAM_CHAT;
  if (t && c) await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: c, text: txt })
  }).catch(() => {});
}

module.exports = async (req, res) => {
  const action = req.query.action;
  try {
    if (!SECRET || !SITE) return res.status(500).json({ error: 'config' });

    if (action === 'checkout' && req.method === 'POST') {
      const { items, name, phone, email } = req.body || {};
      const nm = String(name || '').trim().slice(0, 60), ph = String(phone || '').replace(/\D/g, '');
      if (!nm || ph.length < 10 || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'dados' });
      const lines = [];
      let cents = 0;
      for (const it of items) {
        const m = MENU[it.id], q = Math.floor(+it.q);
        if (!m || !(q >= 1 && q <= 20)) return res.status(400).json({ error: 'item' });
        const price = Math.round(m[1] * 100);
        cents += price * q;
        lines.push({ quantity: q, price, description: m[0] });
      }
      lines[0].description += ` (${nm} · ${ph})`; // o nome e o telefone chegam à loja no webhook
      const id = crypto.randomBytes(4).toString('hex').toUpperCase();
      const order_nsu = `PB-${id}-${cents}-${sign(id, cents)}`;
      const customer = { name: nm, phone_number: '+55' + (ph.startsWith('55') && ph.length > 11 ? ph.slice(2) : ph) };
      if (/^\S+@\S+\.\S+$/.test(email || '')) customer.email = email;
      const r = await fetch('https://api.checkout.infinitepay.io/links', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: HANDLE, order_nsu, items: lines, customer,
          redirect_url: SITE + '/', webhook_url: SITE + '/api/webhook'
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) return res.status(502).json({ error: 'infinitepay' });
      return res.json({ url: d.url, order_nsu });
    }

    if (action === 'webhook' && req.method === 'POST') {
      const b = req.body || {};
      const o = parse(b.order_nsu);
      if (!o) return res.status(400).send('order_nsu inválido');
      const d = await check(o, { order_nsu: b.order_nsu, transaction_nsu: b.transaction_nsu, slug: b.invoice_slug });
      if (!d) return res.status(400).send('não confirmado'); // 400 faz a InfinitePay tentar de novo
      await notify(b, d);
      return res.status(200).send('OK');
    }

    if (action === 'status' && req.method === 'GET') {
      const q = req.query, o = parse(q.order_nsu);
      if (!o || !q.transaction_nsu || !q.slug) return res.status(400).json({ error: 'params' });
      const d = await check(o, q);
      return res.json({ paid: !!d, method: d ? d.capture_method : null });
    }

    res.status(404).json({ error: 'rota' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erro' });
  }
};
