/**
 * 工作台自己的取数端点（同源 /api/yuanbao）
 * ---------------------------------------------------------------
 * 部署一次（Cloudflare Pages Functions：把本文件放在仓库 functions/api/ 下，
 * 站点由 Cloudflare Pages 托管即可，无需改页面代码）。之后每期用户只在
 * 工作台页面里粘链接、点「拉取这个对话的产物」，这里负责读回产物。
 *
 * 它做的事：
 *   1. 把 /chat/... 或 /s/... 归一成公开分享短链 /s/<shareId>
 *   2. 服务端读该分享页的 SSR 数据（不受浏览器 CORS 限制）
 *   3. 从对话里抽出【多个】产物：结构化 JSON、xlsx 文件（抓回 base64）、对话正文
 *   4. 以 JSON 返回；页面自带的 parseXlsx 把 base64 还原成表格数据
 *
 * 零依赖、零密钥、不碰任何登录态内容：只读「已公开分享」的对话。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

function shareId(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('链接格式不对'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http(s) 链接');
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'yuanbao.tencent.com' && host !== 'yb.tencent.com' && host !== 'yuanbao.qq.com') {
    // 允许自有域名的转发链，但默认只认元宝
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const sid = parts[parts.length - 1];
  if (!sid || sid === 'chat' || sid === 's' || sid.length < 4) throw new Error('链接里找不到分享 ID');
  return sid;
}

function walk(node, strings, msgs, depth = 0) {
  if (depth > 30) return;
  if (typeof node === 'string') { if (node.trim()) strings.push(node.trim()); return; }
  if (Array.isArray(node)) { for (const v of node) walk(v, strings, msgs, depth + 1); return; }
  if (node && typeof node === 'object') {
    const role = node.speaker || node.role || '';
    for (const k of ['displayPrompt', 'speech', 'content', 'text', 'prompt', 'answer', 'msg']) {
      if (typeof node[k] === 'string' && node[k].trim().length > 8) { msgs.push([String(role), node[k].trim()]); break; }
    }
    for (const v of Object.values(node)) walk(v, strings, msgs, depth + 1);
  }
}

function jsonProducts(strings) {
  const found = [];
  for (const s of strings) {
    for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) found.push(m[1]);
    for (const m of s.matchAll(/\{[\s\S]{40,}?\}/g)) found.push(m[0]);
  }
  const out = [], seen = new Set();
  for (const t of found) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) continue;
    let o;
    try { o = JSON.parse(t.slice(a, b + 1)); } catch (e) { continue; }
    if (!o || typeof o !== 'object' || !(o.news || o.items || o.data)) continue;
    const key = JSON.stringify(o).slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

function normNews(items) {
  const out = [];
  for (const it of (items || [])) {
    if (!it || typeof it !== 'object') continue;
    const title = String(it.title || it['标题'] || '').trim();
    if (!title) continue;
    const summary = String(it.summary || it['内容摘要'] || it.content || '');
    let src = it.sources || it['来源'] || [];
    if (typeof src === 'string') src = src.split(' · ').filter(Boolean).map(p => ({ platform: p, url: '' }));
    else if (Array.isArray(src)) src = src.map(v => (typeof v === 'string' ? { platform: v, url: '' } : (v || {})));
    out.push({
      title, summary,
      label: String(it.label || it['分类标签'] || ''),
      level: String(it.level || it['等级'] || ''),
      sem: it.sem || { board: String(it['上位大类'] || ''), src: '', value: '', unit: '', trend: '', stamp: '', org: '' },
      sources: src,
      lead: String(it.lead || '').trim() || summary.split('\n')[0],
    });
  }
  return out;
}

function normCover(cover, news) {
  const cv = (cover || []).filter(c => c && (c.title || c[2])).map((c, i) => {
    if (Array.isArray(c)) c = { rank: c[0], label: c[1], title: c[2], sem: (news[c[3]] || {}).sem || {} };
    return { rank: c.rank || i + 1, label: String(c.label || ''), title: String(c.title || ''), sem: c.sem || {} };
  });
  return (cv.length ? cv : news.slice(0, 10).map((n, i) => ({ rank: i + 1, label: n.label, title: n.title, sem: n.sem }))).slice(0, 10);
}

function fileNames(strings) {
  const out = [], seen = new Set();
  for (const s of strings) for (const m of s.matchAll(/[A-Za-z0-9_\-\u4e00-\u9fff]+\.xlsx/g)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

function xlsxUrls(strings) {
  const out = [], seen = new Set();
  for (const s of strings) for (const m of s.matchAll(/https?:\/\/[^\s"'<>]+\.xlsx(?:\?[^\s"'<>]*)?/gi)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  // SSR 里的 COS 媒体直链
  for (const s of strings) for (const m of s.matchAll(/https?:\/\/[^\s"'<>]+\.(?:xlsx|bin|file)(?:\?[^\s"'<>]*)?/gi)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

async function toBase64(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = await r.arrayBuffer(), bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

export async function onRequestGet(context) {
  const raw = new URL(context.request.url).searchParams.get('u');
  if (!raw) return json({ ok: false, error: '缺少对话链接参数 u' }, 400);

  let sid, short;
  try { sid = shareId(raw); short = 'https://yuanbao.tencent.com/s/' + encodeURIComponent(sid); }
  catch (e) { return json({ ok: false, error: e.message }); }

  let page;
  try {
    const r = await fetch(short, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN' } });
    if (!r.ok) return json({ ok: false, error: '分享页返回 HTTP ' + r.status });
    page = await r.text();
  } catch (e) {
    return json({ ok: false, error: '读取分享页失败：' + e.message });
  }

  const m = page.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return json({ ok: false, error: '分享页没有 SSR 数据（不是公开分享，或页面结构已变）' });
  let nd;
  try { nd = JSON.parse(m[1]); } catch (e) { return json({ ok: false, error: 'SSR 数据解析失败' }); }
  const pp = (nd.props && nd.props.pageProps) || {};
  if (pp.isShareDel) {
    const tip = (pp.errorTip && pp.errorTip.tip) || '原对话已被删除';
    return json({ ok: false, error: '这条分享已失效：' + tip + '。请在元宝里把该对话开启「公开分享」（一次），再把新链接粘到工作台。' });
  }
  const share = pp.fullChatShareData || pp.shareDetailData || null;
  if (!share) {
    return json({ ok: false, error: '这个链接不是公开分享的对话（/chat/ 开头的登录态页面服务端读不到内容）。请在元宝里点「分享」生成公开链接——这是一次性动作，之后每期只在工作台页面里点。' });
  }

  const strings = [], msgs = [];
  walk(share, strings, msgs);
  let title = '';
  try { title = String((((share.chat || {}).shareCardInfo || {}).title) || ''); } catch (e) {}
  const products = [];

  // ① 结构化 JSON 产物，每段一个
  let i = 0;
  for (const o of jsonProducts(strings)) {
    const news = normNews(o.news || o.items || o.data || []);
    if (!news.length) continue;
    products.push({ id: 'json_' + (++i), name: String(o.title || o['期号'] || ('结构化产物 ' + i)),
      kind: '对话 JSON 产物', news, cover: normCover(o.cover, news), sourceUrl: short });
  }

  // ② xlsx 产物：有直链就抓回 base64（页面端 parseXlsx 还原）
  const fnames = fileNames(strings), urls = xlsxUrls(strings), known = new Set(products.map(p => p.name));
  let j = 0;
  for (const u of urls) {
    j++;
    const nm = fnames[j - 1] || decodeURIComponent(new URL(u).pathname.split('/').pop() || ('Excel 产物 ' + j));
    const p = { id: 'xlsx_' + j, name: nm, kind: '对话 xlsx 产物', news: [], cover: [], sourceUrl: u };
    try { p.xlsxBase64 = await toBase64(u); } catch (e) { p.fetchError = e.message; }
    products.push(p);
  }
  // 只有文件名没直链：登记成占位（跳过那些其实来自已处理 URL 的文件名，避免重复项）
  const urlBases = new Set(urls.map(u => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch (e) { return ''; } }));
  for (let k = 0; k < fnames.length; k++) {
    if (urlBases.has(fnames[k])) continue;
    if (!known.has(fnames[k]) && !products.some(p => p.name === fnames[k])) {
      products.push({ id: 'named_' + k, name: fnames[k], kind: '对话中提到的 xlsx', news: [], cover: [], sourceUrl: short });
    }
  }

  // ③ 兜底：对话正文作为一个产物（如实标注，不假装是表格）
  if (!products.length) {
    const seen = new Set(), news = [];
    for (const [role, text] of msgs) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.length < 8 || seen.has(t)) continue;
      seen.add(t);
      const head = t.split(/[。！？\n]/)[0].slice(0, 60);
      news.push({ title: head || t.slice(0, 40), summary: t.slice(0, 600),
        label: (role === 'ai' || role === 'assistant') ? '对话正文' : '用户指令',
        level: '', sem: {}, sources: [], lead: head });
    }
    if (news.length) products.push({ id: 'dialog', name: '对话正文（分享里没有结构化文件）',
      kind: '对话正文', news, cover: normCover([], news), sourceUrl: short });
  }

  return json({
    ok: true,
    meta: { shareId: sid, shareUrl: short, title: title || '元宝对话', messageCount: msgs.length },
    products,
    note: products.length ? '' : '这条对话里没有解析到产物',
  });
}
