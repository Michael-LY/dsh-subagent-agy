/**
 * dsh-subagent-antigravity —— Gemini 网页 Deep Research 侧边栏面板（浏览器端）。
 *
 * 客户端是 DSH 的 lazy-CJS 包：只注册工厂，模块体副作用在首次物化时执行。
 * 面板注册到 root 作用域的 `main` keyed slot，并在 `sidebar.panellist`
 * 注册同名 entry；点击侧边栏的「Gemini 调研」即可打开。
 *
 * 所有耗时操作都走主机侧 /api/dsh-gemini-research/* 桥接，浏览器端不直接
 * 启动进程，也不接触登录态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-antigravity',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');

    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var PANEL_ID = 'gemini-research';
    var API = '/api/dsh-gemini-research';
    var STYLE_ID = 'dsh-gemini-research-styles';

    var CSS = [
      '.dgr-page{box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;padding:28px 28px 48px;color:var(--dsw-alias-label-primary,inherit);font:inherit}',
      '.dgr-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}',
      '.dgr-headText{flex:1;min-width:0}',
      '.dgr-title{font-size:20px;line-height:28px;font-weight:650;margin:0}',
      '.dgr-sub{margin-top:4px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
      '.dgr-badge{flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit)}',
      '.dgr-dot{width:7px;height:7px;border-radius:50%;background:#8a8f99}',
      '.dgr-dot.ok{background:#22a06b}.dgr-dot.run{background:#4c8dff}.dgr-dot.bad{background:#e5484d}',
      '.dgr-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:14px;background:var(--dsw-alias-bg-layer-2,transparent);padding:16px;margin-bottom:14px}',
      '.dgr-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dgr-col{display:flex;flex-direction:column;gap:10px}',
      '.dgr-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
      '.dgr-input{box-sizing:border-box;width:100%;min-height:92px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13.5px;line-height:21px;outline:none}',
      '.dgr-input:focus{border-color:#4c8dff}',
      '.dgr-btn{appearance:none;min-height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:var(--dsw-alias-fill-elevated,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.dgr-btn:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.16))}',
      '.dgr-btn:disabled{opacity:.5;cursor:default}',
      '.dgr-btn.primary{border-color:#4c8dff;background:#4c8dff;color:#fff}',
      '.dgr-btn.danger{border-color:#e5484d;color:#e5484d;background:transparent}',
      '.dgr-status{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;line-height:20px}',
      '.dgr-kv{display:flex;gap:6px;align-items:baseline}.dgr-kv b{font-weight:600}',
      '.dgr-note{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,inherit);opacity:.82}',
      '.dgr-warn{border:1px solid rgba(220,140,0,.45);background:rgba(220,140,0,.08);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:20px}',
      '.dgr-report{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:22px;max-height:60vh;overflow:auto;padding:14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
      '.dgr-log{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:17px;max-height:180px;overflow:auto;opacity:.7}',
      '.dgr-empty{padding:26px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,inherit);opacity:.72}',
      '.dgr-icon{display:block}',
      '@media (max-width:700px){.dgr-page{padding:20px 16px 40px}}',
    ].join('');

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-subagent-antigravity';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function getJson(path) {
      return fetch(API + path, { method: 'GET', headers: { accept: 'application/json' } }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && (body.message || body.code)) || ('HTTP ' + res.status));
          return body;
        });
      });
    }

    function postJson(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        return res.json().then(function (payload) {
          if (!res.ok) throw new Error((payload && (payload.message || payload.code)) || ('HTTP ' + res.status));
          return payload;
        });
      });
    }

    function fmtTime(value) {
      if (!value) return '—';
      try {
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleString();
      } catch (error) {
        return '—';
      }
    }

    function elapsed(job) {
      if (!job || !job.startedAt) return '—';
      var end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
      var start = new Date(job.startedAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
      var seconds = Math.max(0, Math.round((end - start) / 1000));
      var minutes = Math.floor(seconds / 60);
      return minutes > 0 ? minutes + ' 分 ' + (seconds % 60) + ' 秒' : seconds + ' 秒';
    }

    var STATUS_TEXT = {
      queued: '排队中',
      running: '调研中',
      done: '已完成',
      error: '失败',
    };

    function statusTone(job) {
      if (!job) return '';
      if (job.status === 'done') return 'ok';
      if (job.status === 'running' || job.status === 'queued') return 'run';
      if (job.status === 'error') return 'bad';
      return '';
    }

    function GeminiIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18;
      return h(
        'svg',
        {
          className: 'dgr-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M12 2.6l1.9 5.9 5.9 1.9-5.9 1.9L12 18.2l-1.9-5.9L4.2 10.4l5.9-1.9L12 2.6z',
          fill: 'currentColor',
          opacity: '0.92',
        }),
        h('path', { d: 'M19 15.2l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7z', fill: 'currentColor', opacity: '0.55' })
      );
    }

    function GeminiResearchPanel() {
      var topicState = useState('');
      var statusState = useState(null);
      var jobState = useState(null);
      var errorState = useState('');
      var noticeState = useState('');
      var busyState = useState(false);

      var topic = topicState[0];
      var setTopic = topicState[1];
      var status = statusState[0];
      var setStatus = statusState[1];
      var job = jobState[0];
      var setJob = jobState[1];
      var error = errorState[0];
      var setError = errorState[1];
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var busy = busyState[0];
      var setBusy = busyState[1];
      var jobIdRef = useRef(null);

      function refresh() {
        return getJson('/status')
          .then(function (data) {
            setStatus(data);
            if (data && data.job) {
              jobIdRef.current = data.job.id;
              setJob(function (previous) {
                if (previous && previous.id === data.job.id) {
                  return Object.assign({}, data.job, { result: previous.result, logTail: previous.logTail });
                }
                return data.job;
              });
            }
            return data;
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          });
      }

      function refreshJob() {
        var id = jobIdRef.current;
        if (!id) return Promise.resolve(null);
        return getJson('/job?id=' + encodeURIComponent(id))
          .then(function (data) {
            if (data && data.job) setJob(data.job);
            return data && data.job;
          })
          .catch(function () {
            return null;
          });
      }

      useEffect(function () {
        refresh();
        var timer = setInterval(function () {
          refreshJob().then(function (current) {
            if (current && (current.status === 'done' || current.status === 'error')) {
              clearInterval(timer);
            }
          });
          getJson('/status').then(setStatus).catch(function () {});
        }, 2500);
        return function () {
          clearInterval(timer);
        };
      }, []);

      function startResearch() {
        var text = topic.trim();
        if (text.length === 0) {
          setError('先写调研主题');
          return;
        }
        setError('');
        setNotice('');
        setBusy(true);
        postJson('/run', { topic: text })
          .then(function (data) {
            jobIdRef.current = data.jobId;
            setNotice('已提交，任务会自动排队执行。');
            return refreshJob();
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function initLogin() {
        setError('');
        setNotice('');
        setBusy(true);
        postJson('/login/init', {})
          .then(function () {
            setNotice('已打开登录窗口：请在弹出的 Chrome 里登录 Google 账号，登录完成后窗口会自动关闭。');
            return refresh();
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function copyReport() {
        var text = job && job.result ? job.result : '';
        if (!text) return;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () {
            setNotice('报告已复制到剪贴板');
          }).catch(function () {
            setError('复制失败，请手动选择报告文本');
          });
        } else {
          setError('当前环境不支持剪贴板');
        }
      }

      var running = !!(job && (job.status === 'running' || job.status === 'queued'));
      var loginKnown = status && status.loginReady === true;

      return h(
        'div',
        { className: 'dgr-page' },
        h(
          'div',
          { className: 'dgr-head' },
          h('div', { className: 'dgr-headText' },
            h('h1', { className: 'dgr-title' }, 'Gemini 网页调研'),
            h('div', { className: 'dgr-sub' }, '用 Google AI Pro 网页端的 Deep Research 做多步调研，结果回到这里；单次通常 5–10 分钟。')
          ),
          h('span', { className: 'dgr-badge' },
            h('span', { className: 'dgr-dot ' + (loginKnown ? 'ok' : '') }),
            loginKnown ? '登录态已保存' : '待初始化登录'
          )
        ),

        status === null
          ? h('div', { className: 'dgr-empty' }, '正在读取服务状态…')
          : h(
              'div',
              { className: 'dgr-card' },
              h('div', { className: 'dgr-status' },
                h('span', { className: 'dgr-kv' }, h('b', null, '运行状态'), running ? '调研中' : '空闲'),
                h('span', { className: 'dgr-kv' }, h('b', null, '登录进程'), status.loginRunning ? '运行中' : '未运行'),
                h('span', { className: 'dgr-kv' }, h('b', null, '登录态'), status.loginReady ? '已就绪' : '未就绪'),
                h('span', { className: 'dgr-kv' }, h('b', null, 'Profile'), status.profileExists ? '已创建' : '未创建')
              ),
              !loginKnown
                ? h('div', { className: 'dgr-warn', style: { marginTop: '12px' } },
                    '还没有可用的 Gemini 登录态。先点「初始化登录」，在弹出的 Chrome 里完成 Google 登录；登录态会保存在本机 profile 里。'
                  )
                : null
            ),

        h(
          'div',
          { className: 'dgr-card dgr-col' },
          h('div', { className: 'dgr-label' }, '调研主题'),
          h('textarea', {
            className: 'dgr-input',
            placeholder: '例如：调研 2026 年 GT3 组别对 e-Fuel 的技术规范与引入时间表，要求列出关键数据、多方观点与来源链接',
            value: topic,
            onChange: function (event) { setTopic(event.target.value); },
            disabled: running,
          }),
          h('div', { className: 'dgr-row' },
            h('button', { className: 'dgr-btn primary', type: 'button', onClick: startResearch, disabled: busy || running }, running ? '调研进行中…' : '开始 Deep Research'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: initLogin, disabled: busy }, '初始化登录'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: refresh, disabled: busy }, '刷新状态')
          ),
          h('div', { className: 'dgr-note' }, '额度提示：Google AI Pro 的 Deep Research 约为每天 20 次；同一时间只跑一个任务（Chrome profile 单实例锁）。')
        ),

        error ? h('div', { className: 'dgr-warn', style: { marginBottom: '14px' } }, error) : null,
        notice ? h('div', { className: 'dgr-note', style: { marginBottom: '14px' } }, notice) : null,

        job
          ? h(
              'div',
              { className: 'dgr-card' },
              h('div', { className: 'dgr-status', style: { marginBottom: '10px' } },
                h('span', { className: 'dgr-kv' }, h('b', null, '任务'), job.id ? job.id.slice(0, 8) : '—'),
                h('span', { className: 'dgr-kv' }, h('b', null, '状态'), STATUS_TEXT[job.status] || job.status),
                h('span', { className: 'dgr-kv' }, h('b', null, '耗时'), elapsed(job)),
                h('span', { className: 'dgr-kv' }, h('b', null, '创建'), fmtTime(job.createdAt))
              ),
              job.topic ? h('div', { className: 'dgr-note', style: { marginBottom: '10px' } }, '主题：' + job.topic) : null,
              job.status === 'done' && job.result
                ? h('div', { className: 'dgr-col' },
                    h('div', { className: 'dgr-row' },
                      h('div', { className: 'dgr-label', style: { flex: '1' } }, '调研报告'),
                      h('button', { className: 'dgr-btn', type: 'button', onClick: copyReport }, '复制报告')
                    ),
                    h('pre', { className: 'dgr-report' }, job.result)
                  )
                : null,
              job.status === 'error'
                ? h('div', { className: 'dgr-warn' }, '调研失败：' + (job.error || '未知错误'))
                : null,
              job.logTail
                ? h('details', { style: { marginTop: '10px' } },
                    h('summary', { className: 'dgr-label' }, '运行日志'),
                    h('pre', { className: 'dgr-log' }, job.logTail)
                  )
                : null
            )
          : h('div', { className: 'dgr-empty' }, '还没有任务。填好主题后点「开始 Deep Research」。')
      );
    }

    var inject = ['slots'];

    function apply(ctx) {
      ensureStyles();
      var disposers = [];
      if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
        disposers.push(
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, GeminiResearchPanel);
          })
        );
        disposers.push(
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: function () { return 'Gemini 调研'; } },
              GeminiIcon
            );
          })
        );
      }
      return function () {
        for (var i = 0; i < disposers.length; i += 1) {
          try { disposers[i](); } catch (error) { /* ignore */ }
        }
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__panel = GeminiResearchPanel;
    exports.__icon = GeminiIcon;
    return module.exports;
  },
});
