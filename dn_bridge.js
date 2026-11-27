/* 今日要闻 · 前后端架构「可选增强层」
   ------------------------------------------------------------------
   本脚本只在磁盘 index.html 的 </body> 前被服务端追加一行 <script> 引入。
   磁盘上的 index.html 与用户提供的静态版逐字节一致，一个字节都没改。

   原则：**只追加，不修改、不覆盖、不删除原页面任何 DOM / 函数 / 变量**。
   - 原十个功能区、全部控件、封面/卡片渲染、默认值、原导出按钮照常工作；
   - 即使后端不可用，原页面 100% 按静态版运行；
   - 需要纯静态时设 DN_PURE_STATIC=1，服务端不注入本脚本，连附加 UI 都不出现。

   追加的能力（真正走后端）：
   - 01 数据源：服务端按窗口采集 / 导入（配了 DN_SOURCE_URL 才有意义）
   - 05 人声：服务端统一合成与缓存
   - 08 导出：服务端 ffmpeg 出 H.264/AAC MP4（原浏览器导出按钮完全不动）
*/
(function () {
  'use strict';
  var API = '/api/v1';
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function log(box, msg, bad) {
    box.className = bad ? 'errbar' : 'okbar';
    box.textContent = msg;
  }

  /* ---------- 1. 顶栏追加一个后端状态徽标（纯附加） ---------- */
  function mountBadge() {
    var hd = $('.hd');
    if (!hd || $('#dnBackendBadge')) return;
    var b = el('span', 'mini');
    b.id = 'dnBackendBadge';
    b.style.cssText = 'color:#8fe0b6;border:1px solid rgba(57,192,122,.32);' +
      'background:rgba(57,192,122,.08);border-radius:5px;padding:3px 9px;font:11px var(--mono)';
    b.textContent = '后端连接中…';
    hd.appendChild(b);
    // 探 /ready：毫秒级、不触发 ffmpeg 探测（100MB 静态 exe 冷启动会拖慢 /health）
    fetch(API + '/ready', { signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined }).then(function (r) { return r.json(); })
      .then(function (j) {
        b.textContent = j && j.ready ? '本机后端已连接 · 服务端能力可用' : '后端未就绪（原功能不受影响）';
        if (!j || !j.ok) b.style.color = '#ffd27a';
      }).catch(function () {
        b.textContent = '后端未连接 · 请确认托盘中软件仍在运行';
        b.style.color = '#ffd27a';
      });
  }

  /* ---------- 2. 通用：从原页面读到当前画布与文稿（只读） ---------- */
  function grab() {
    var out = { cover_png: '', card_pngs: [], sentences: [], srt: '', ass: '', bgm_file: '内置配乐.mp3' };
    ['cvCanvas', 'cdCanvas', 'plCanvas', 'docMiniCv'].forEach(function (id) {
      var c = document.getElementById(id);
      if (!c || !c.width || !c.height) return;
      try {
        var u = c.toDataURL('image/png');
        if (!out.cover_png) out.cover_png = u;
        else out.card_pngs.push(u);
      } catch (e) { /* 画布被跨域污染时跳过，不影响原功能 */ }
    });
    ['openText', 'bodyText', 'closeText', 'windowText'].forEach(function (id) {
      var t = document.getElementById(id);
      if (t && t.value && t.value.trim()) out.sentences.push(t.value.trim());
    });
    if (!out.sentences.length) {
      try {
        var S = (typeof window.S !== 'undefined') ? window.S : null;
        if (S && Array.isArray(S.sentences)) out.sentences = S.sentences.slice();
        else if (S && Array.isArray(S.segs)) out.sentences = S.segs.map(function (x) { return x.text || ''; });
      } catch (e) { }
    }
    return out;
  }

  /* ---------- 3. 08 区追加「服务端导出」（原导出按钮一行不动） ---------- */
  function mountExport() {
    var pb = $('#sec-export .pb');
    if (!pb || $('#dnServerExport')) return;
    var g = el('div', 'tgroup');
    g.id = 'dnServerExport';
    g.style.marginTop = '14px';
    g.innerHTML = '<h3>服务端导出（前后端架构）<small>本机 ffmpeg 出 H.264/AAC MP4；上方原有导出按钮照常使用，互不干扰</small></h3>';
    var row = el('div', 'row');
    var btn = el('button', 'pri', '⬇ 用后端生成 MP4');
    var cap = el('button', 'sm', '查后端编码能力');
    row.appendChild(btn); row.appendChild(cap);
    var box = el('div', 'okbar');
    box.textContent = '可选增强。原页面所有导出方式（MP4 / WebM / MP3 / WAV / SRT / ASS / PNG / MD / JSON）全部保留。';
    g.appendChild(row); g.appendChild(box);
    pb.appendChild(g);

    cap.onclick = function () {
      function show(j) {
        log(box, '后端编码能力：' + JSON.stringify({
          h264: j.h264, aac: j.aac, h264_aac: j.h264_aac,
          webm: j.webm, libass: j.libass, subtitle_burn: j.subtitle_burn
        }));
      }
      fetch(API + '/export/capabilities').then(function (r) { return r.json(); })
        .then(function (j) {
          // ffmpeg 能力在后台预热，首次可能还在探测；1.5s 后自动重试一次
          if (j.probing || j.encoder && j.encoder.probing) {
            log(box, 'ffmpeg 能力正在后台探测，稍候自动刷新…');
            setTimeout(function () {
              fetch(API + '/export/capabilities').then(function (r) { return r.json(); })
                .then(show).catch(function (e) { log(box, '后端不可达：' + e, true); });
            }, 1500);
            return;
          }
          show(j);
        }).catch(function (e) { log(box, '后端不可达：' + e, true); });
    };

    btn.onclick = function () {
      var d = grab();
      if (!d.cover_png) { log(box, '没读到封面画布，先在 03 区渲染一次封面再点。', true); return; }
      btn.disabled = true; btn.textContent = '提交中…';
      log(box, '已提交服务端作业，正在合成…');
      fetch(API + '/export/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cover_png: d.cover_png, card_pngs: d.card_pngs,
          sentences: d.sentences, srt: d.srt, ass: d.ass,
          bgm_file: d.bgm_file, burn_subtitle: true,
          cover_seconds: 3.0, card_seconds: 4.0, codec: 'h264'
        })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) throw new Error(j.message || '提交失败');
        return poll(j.id, box, btn);
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '⬇ 用后端生成 MP4';
        log(box, '服务端导出失败：' + e.message + '（请确认右下角托盘里的「今日要闻」仍在运行；服务退出后本机接口都会 Failed to fetch，重新双击桌面图标即可）', true);
      });
    };

    function poll(id, box, btn) {
      var n = 0;
      var t = setInterval(function () {
        n++;
        fetch(API + '/export/jobs/' + id).then(function (r) { return r.json(); })
          .then(function (j) {
            log(box, '作业 ' + id + ' · ' + (j.stage || j.status) + ' · ' + (j.progress || 0) + '% ' + (j.message || ''));
            if (j.status === 'done') {
              clearInterval(t);
              btn.disabled = false; btn.textContent = '⬇ 用后端生成 MP4';
              log(box, '成片完成（' + (j.codec || 'h264') + ' / ' + (j.size || 0) + ' B）。开始下载…');
              var a = document.createElement('a');
              a.href = API + '/export/jobs/' + id + '/download';
              a.download = '今日要闻_' + id + '.mp4';
              document.body.appendChild(a); a.click(); a.remove();
            } else if (j.status === 'failed' || n > 180) {
              clearInterval(t);
              btn.disabled = false; btn.textContent = '⬇ 用后端生成 MP4';
              log(box, '作业失败或超时：' + (j.message || (j.log || []).slice(-3).join(' | ')), true);
            }
          }).catch(function (e) {
            clearInterval(t);
            btn.disabled = false; btn.textContent = '⬇ 用后端生成 MP4';
            log(box, '轮询失败：' + e, true);
          });
      }, 1000);
    }
  }

  /* ---------- 4. 01 区追加「服务端采集」（原采集控件一行不动） ---------- */
  function mountSource() {
    var pb = $('#sec-source .pb') || $('#sec-data .pb');
    if (!pb || $('#dnServerSource')) return;
    var g = el('div', 'tgroup');
    g.id = 'dnServerSource';
    g.style.marginTop = '14px';
    g.innerHTML = '<h3>服务端窗口采集（可选）<small>原有「历史快照 / 导入 JSON / 应用数据源」全部保留</small></h3>';
    var row = el('div', 'row');
    var b1 = el('button', 'sm', '执行服务端采集');
    var b2 = el('button', 'sm', '查看窗口内条目');
    row.appendChild(b1); row.appendChild(b2);
    var box = el('div', 'okbar');
    box.textContent = '配了 DN_SOURCE_URL 才会采到当日新闻；未配置时后端如实返回历史快照。';
    g.appendChild(row); g.appendChild(box);
    pb.appendChild(g);
    b1.onclick = function () {
      fetch(API + '/source/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (j) { log(box, '采集结果：' + JSON.stringify(j).slice(0, 400)); })
        .catch(function (e) { log(box, '采集失败：' + e, true); });
    };
    b2.onclick = function () {
      fetch(API + '/source/window').then(function (r) { return r.json(); })
        .then(function (j) { log(box, '窗口：' + JSON.stringify(j).slice(0, 400)); })
        .catch(function (e) { log(box, '查询失败：' + e, true); });
    };
  }

  /* ---------- 5. 05 区追加「服务端合成人声」（原人声控件一行不动） ---------- */
  function mountVoice() {
    var pb = $('#sec-voice .pb');
    if (!pb || $('#dnServerVoice')) return;
    var g = el('div', 'tgroup');
    g.id = 'dnServerVoice';
    g.style.marginTop = '14px';
    g.innerHTML = '<h3>服务端人声合成（可选）<small>原有试听 / 本地合成全部保留</small></h3>';
    var row = el('div', 'row');
    var b = el('button', 'sm', '后端合成当前文稿');
    row.appendChild(b);
    var box = el('div', 'okbar');
    box.textContent = '在线不可达时后端回退本地替代音，并明确写出回退句数，不冒充真人声。';
    g.appendChild(row); g.appendChild(box);
    pb.appendChild(g);
    b.onclick = function () {
      var d = grab();
      if (!d.sentences.length) { log(box, '没读到文稿，先在 02 区填好四段文案。', true); return; }
      fetch(API + '/voice/synthesize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentences: d.sentences, reuse: true })
      }).then(function (r) { return r.json(); })
        .then(function (j) { log(box, '合成完成：' + JSON.stringify(j).slice(0, 400)); })
        .catch(function (e) { log(box, '合成失败：' + e, true); });
    };
  }

  function boot() {
    try { mountBadge(); } catch (e) { }
    try { mountExport(); } catch (e) { }
    try { mountSource(); } catch (e) { }
    try { mountVoice(); } catch (e) { }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
