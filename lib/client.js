/**
 * dsh-subagent-agy —— Gemini 网页 Deep Research 侧边栏面板（浏览器端）。
 *
 * 客户端是 DSH 的 lazy-CJS 包：只注册工厂，模块体副作用在首次物化时执行。
 * 面板注册到 root 作用域的 `main` keyed slot，并在 `sidebar.panellist`
 * 注册同名 entry；点击侧边栏的「Gemini 调研」即可打开。
 *
 * 所有耗时操作都走主机侧 /api/dsh-gemini-research/* 桥接，浏览器端不直接
 * 启动进程，也不接触登录态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-agy',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');

    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var PANEL_ID = 'gemini-research';
    var PANEL_ID_CHAT = 'gemini-chat';
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
      '.dgr-select{box-sizing:border-box;min-height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px;outline:none}',
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
      '.dgr-chatList{display:flex;flex-direction:column;gap:10px;min-height:220px;max-height:52vh;overflow:auto;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
      '.dgr-msg{display:flex;flex-direction:column;gap:4px;max-width:88%}',
      '.dgr-msg.user{align-self:flex-end;align-items:flex-end}',
      '.dgr-msg.assistant{align-self:flex-start}',
      '.dgr-msgRole{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,inherit);opacity:.7}',
      '.dgr-msgBody{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:21px;padding:9px 12px;border-radius:12px;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12))}',
      '.dgr-msg.user .dgr-msgBody{background:#4c8dff;color:#fff}',
      '.dgr-chatInput{box-sizing:border-box;width:100%;min-height:64px;max-height:180px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13.5px;line-height:21px;outline:none}',
      '.dgr-chatInput:focus{border-color:#4c8dff}',
      '.dgr-chatEmpty{padding:36px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,inherit);opacity:.72}',
      '@media (max-width:700px){.dgr-page{padding:20px 16px 40px}}',
    ].join('');

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-subagent-agy';
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

    var FALLBACK_MODELS = [
      { id: 'flash-lite', label: 'Flash-Lite', displayName: 'Flash-Lite', thinkingLevels: ['low', 'medium', 'high'] },
      { id: 'flash', label: 'Flash', displayName: 'Flash', thinkingLevels: ['low', 'medium', 'high'] },
      { id: 'pro', label: 'Pro', displayName: 'Pro', thinkingLevels: ['low', 'medium', 'high'] },
      { id: 'argon', label: 'Argon', displayName: '4 Argon', thinkingLevels: ['low', 'medium', 'high'] },
    ];
    var FALLBACK_THINKING = [
      { id: 'low', label: '低（快速高效）' },
      { id: 'medium', label: '中（深度适中）' },
      { id: 'high', label: '高（超级详尽）' },
    ];

    function readPref(key) {
      try {
        return window.localStorage ? window.localStorage.getItem(key) || '' : '';
      } catch (error) {
        return '';
      }
    }

    function writePref(key, value) {
      try {
        if (window.localStorage) window.localStorage.setItem(key, value || '');
      } catch (error) {
        // Local storage can be unavailable in restricted webviews; ignore.
      }
    }

    function loadModelCatalog(mode, live, refresh) {
      return getJson('/models?mode=' + encodeURIComponent(mode) + (live ? '&live=1' : '&live=0') + (refresh ? '&refresh=1' : '')).catch(function () {
        return { ok: true, models: FALLBACK_MODELS, thinking: FALLBACK_THINKING, defaults: { model: '', thinking: '' }, source: 'fallback' };
      });
    }

    function thinkingOptionsFor(catalog, modelId) {
      var levels = catalog && catalog.thinking ? catalog.thinking : FALLBACK_THINKING;
      if (!modelId || !catalog || !catalog.models) return levels;
      var selected = null;
      for (var i = 0; i < catalog.models.length; i += 1) {
        if (catalog.models[i].id === modelId) selected = catalog.models[i];
      }
      if (!selected || !selected.thinkingLevels || selected.thinkingLevels.length === 0) return levels;
      return levels.filter(function (level) { return selected.thinkingLevels.indexOf(level.id) >= 0; });
    }

    function modelSelectRow(models, model, setModel, thinkingOptions, thinking, setThinking, running, onRefresh) {
      return h(
        'div',
        { className: 'dgr-row', style: { marginBottom: '10px' } },
        h('label', { className: 'dgr-row', style: { gap: '6px' } },
          h('span', { className: 'dgr-label' }, '模型'),
          h('select', {
            className: 'dgr-select',
            value: model,
            disabled: running,
            onChange: function (event) { setModel(event.target.value); },
          },
            h('option', { value: '' }, '默认'),
            models.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.displayName || item.label);
            })
          )
        ),
        h('label', { className: 'dgr-row', style: { gap: '6px' } },
          h('span', { className: 'dgr-label' }, '思考强度'),
          h('select', {
            className: 'dgr-select',
            value: thinking,
            disabled: running || thinkingOptions.length === 0,
            onChange: function (event) { setThinking(event.target.value); },
          },
            h('option', { value: '' }, '默认'),
            thinkingOptions.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.label);
            })
          )
        ),
        typeof onRefresh === 'function'
          ? h('button', { className: 'dgr-btn', type: 'button', onClick: onRefresh, disabled: running, style: { minHeight: '30px', padding: '0 10px' } }, '刷新模型')
          : null
      );
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

    function ChatIcon(props) {
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
          d: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
          fill: 'currentColor',
          opacity: '0.92',
        }),
        h('path', {
          d: 'M7 9h10M7 12.5h7',
          stroke: 'currentColor',
          'stroke-width': '1.6',
          'stroke-linecap': 'round',
          opacity: '0.5',
        })
      );
    }

    function GeminiResearchPanel() {
      var topicState = useState('');
      var statusState = useState(null);
      var jobState = useState(null);
      var errorState = useState('');
      var noticeState = useState('');
      var busyState = useState(false);
      var catalogState = useState(null);
      var modelState = useState('');
      var thinkingState = useState('');

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
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var model = modelState[0];
      var setModel = modelState[1];
      var thinking = thinkingState[0];
      var setThinking = thinkingState[1];
      var jobIdRef = useRef(null);

      function changeModel(value) {
        setModel(value);
        writePref('dsh.gemini.research.model', value);
        var levels = thinkingOptionsFor(catalog, value);
        if (thinking && !levels.some(function (item) { return item.id === thinking; })) {
          setThinking('');
          writePref('dsh.gemini.research.thinking', '');
        }
      }

      function changeThinking(value) {
        setThinking(value);
        writePref('dsh.gemini.research.thinking', value);
      }

      function refreshModels() {
        loadModelCatalog('research', true, true).then(function (data) {
          setCatalog(data);
          setNotice('模型目录已刷新');
        }).catch(function (err) {
          setError(String(err && err.message ? err.message : err));
        });
      }

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

      useEffect(function () {
        loadModelCatalog('research').then(function (data) {
          setCatalog(data);
          var savedModel = readPref('dsh.gemini.research.model');
          var savedThinking = readPref('dsh.gemini.research.thinking');
          setModel(savedModel || (data.defaults && data.defaults.model) || '');
          setThinking(savedThinking || (data.defaults && data.defaults.thinking) || '');
        }).catch(function () {});
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
        postJson('/run', {
          topic: text,
          model: model || undefined,
          thinking: thinking || undefined,
        })
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
            setNotice('已打开登录窗口：请在弹出的系统默认浏览器里登录 Google 账号，登录完成后窗口会自动关闭。');
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
      var loginReady = status && status.loginReady === true;
      var loginSaved = status && status.loginSaved === true;
      var models = catalog && catalog.models ? catalog.models : FALLBACK_MODELS;
      var thinkingOptions = thinkingOptionsFor(catalog, model);

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
            h('span', { className: 'dgr-dot ' + (loginReady ? 'ok' : (loginSaved ? 'run' : '')) }),
            loginReady ? '登录态已验证' : (loginSaved ? '登录态待验证' : '待初始化登录')
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
                h('span', { className: 'dgr-kv' }, h('b', null, '登录态'), loginReady ? '已验证' : (loginSaved ? '待验证' : '未就绪')),
                h('span', { className: 'dgr-kv' }, h('b', null, 'Profile'), status.profileExists ? '已创建' : '未创建')
              ),
              !loginReady && !loginSaved
                ? h('div', { className: 'dgr-warn', style: { marginTop: '12px' } },
                    '还没有可用的 Gemini 登录态。先点「初始化登录」，在弹出的系统默认浏览器里完成 Google 登录；登录态会保存在本机 profile 里。'
                  )
                : null,
              !loginReady && loginSaved
                ? h('div', { className: 'dgr-note', style: { marginTop: '12px' } },
                    '检测到上次登录文件，但当前未验证；发起任务时会自动验证，如失败请重新初始化登录。'
                  )
                : null
            ),

        h(
          'div',
          { className: 'dgr-card dgr-col' },
          modelSelectRow(models, model, changeModel, thinkingOptions, thinking, changeThinking, running, refreshModels),
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
          h('div', { className: 'dgr-note' }, '额度提示：Google AI Pro 的 Deep Research 约为每天 20 次；同一时间只跑一个任务（浏览器 profile 单实例锁）。Deep Research 内模型/思考选择可能不生效，以实际报告为准。')
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
              job.model || job.thinking
                ? h('div', { className: 'dgr-note', style: { marginBottom: '10px' } },
                    '模型：' + (job.model || '默认') + ' · 思考：' + (job.thinking || '默认') +
                    ((job.model && job.modelApplied === false) || (job.thinking && job.thinkingApplied === false) ? '（网页未应用，已用默认）' : '')
                  )
                : null,
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

    function GeminiChatPanel() {
      var messagesState = useState([]);
      var inputState = useState('');
      var statusState = useState(null);
      var errorState = useState('');
      var noticeState = useState('');
      var busyState = useState(false);
      var catalogState = useState(null);
      var modelState = useState('');
      var thinkingState = useState('');
      var jobIdRef = useRef(null);
      var listRef = useRef(null);
      var pollFailRef = useRef(0);
      var pollInFlightRef = useRef(false);
      var doneJobRef = useRef(null);

      var messages = messagesState[0];
      var setMessages = messagesState[1];
      var input = inputState[0];
      var setInput = inputState[1];
      var status = statusState[0];
      var setStatus = statusState[1];
      var error = errorState[0];
      var setError = errorState[1];
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var busy = busyState[0];
      var setBusy = busyState[1];
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var model = modelState[0];
      var setModel = modelState[1];
      var thinking = thinkingState[0];
      var setThinking = thinkingState[1];

      function changeModel(value) {
        setModel(value);
        writePref('dsh.gemini.chat.model', value);
        var levels = thinkingOptionsFor(catalog, value);
        if (thinking && !levels.some(function (item) { return item.id === thinking; })) {
          setThinking('');
          writePref('dsh.gemini.chat.thinking', '');
        }
      }

      function changeThinking(value) {
        setThinking(value);
        writePref('dsh.gemini.chat.thinking', value);
      }

      function refreshModels() {
        loadModelCatalog('chat', true, true).then(function (data) {
          setCatalog(data);
          setNotice('模型目录已刷新');
        }).catch(function (err) {
          setError(String(err && err.message ? err.message : err));
        });
      }

      function refreshStatus() {
        return getJson('/status')
          .then(function (data) {
            setStatus(data);
            var chatJob = data && data.chat && data.chat.job ? data.chat.job : null;
            // Recover polling after the panel is remounted while a job runs.
            if (chatJob && (chatJob.status === 'queued' || chatJob.status === 'running')) {
              if (!jobIdRef.current) jobIdRef.current = chatJob.id;
              setBusy(true);
            }
            return data;
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          });
      }

      function pollChatJob(id) {
        if (!id || doneJobRef.current === id) return Promise.resolve(null);
        if (pollInFlightRef.current) return Promise.resolve(null);
        pollInFlightRef.current = true;
        return getJson('/chat/job?id=' + encodeURIComponent(id))
          .then(function (data) {
            pollFailRef.current = 0;
            var job = data && data.job ? data.job : null;
            if (!job) return null;
            if (jobIdRef.current !== id && doneJobRef.current !== id) return null;
            if (job.status === 'done') {
              doneJobRef.current = id;
              setMessages(function (previous) {
                var next = previous.slice();
                var duplicate = next.some(function (item) { return item.jobId === id; });
                if (job.reply && !duplicate) next.push({ role: 'assistant', text: job.reply, jobId: id });
                return next;
              });
              jobIdRef.current = null;
              setBusy(false);
              refreshStatus();
            } else if (job.status === 'error') {
              setError(job.error || '对话失败');
              jobIdRef.current = null;
              setBusy(false);
              refreshStatus();
            }
            return job;
          })
          .catch(function (err) {
            pollFailRef.current += 1;
            if (pollFailRef.current >= 3) {
              setError(String(err && err.message ? err.message : err));
              jobIdRef.current = null;
              setBusy(false);
            }
            return null;
          })
          .finally(function () {
            pollInFlightRef.current = false;
          });
      }

      useEffect(function () {
        refreshStatus();
        var timer = setInterval(function () {
          var id = jobIdRef.current;
          if (id) pollChatJob(id);
          else refreshStatus();
        }, 2000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      useEffect(function () {
        loadModelCatalog('chat').then(function (data) {
          setCatalog(data);
          var savedModel = readPref('dsh.gemini.chat.model');
          var savedThinking = readPref('dsh.gemini.chat.thinking');
          setModel(savedModel || (data.defaults && data.defaults.model) || '');
          setThinking(savedThinking || (data.defaults && data.defaults.thinking) || '');
        }).catch(function () {});
      }, []);

      useEffect(function () {
        var node = listRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [messages.length, busy]);

      function send() {
        var text = input.trim();
        if (text.length === 0) {
          setError('先输入内容');
          return;
        }
        setError('');
        setNotice('');
        setBusy(true);
        var optimistic = { role: 'user', text: text };
        setMessages(messages.concat([optimistic]));
        setInput('');
        doneJobRef.current = null;
        postJson('/chat/send', {
          message: text,
          model: model || undefined,
          thinking: thinking || undefined,
        })
          .then(function (data) {
            jobIdRef.current = data.jobId;
            return pollChatJob(data.jobId);
          })
          .catch(function (err) {
            // The request never reached the queue: roll back the optimistic
            // bubble and restore the draft instead of losing it.
            setMessages(function (previous) {
              return previous.filter(function (item) { return item !== optimistic; });
            });
            setInput(text);
            setError(String(err && err.message ? err.message : err));
            setBusy(false);
          });
      }

      function newChat() {
        setError('');
        setNotice('');
        setBusy(true);
        postJson('/chat/new', {})
          .then(function () {
            jobIdRef.current = null;
            doneJobRef.current = null;
            setMessages([]);
            setNotice('已开新对话');
            return refreshStatus();
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (!busy) send();
        }
      }

      var chatJob = status && status.chat && status.chat.job ? status.chat.job : null;
      var running = busy || !!(chatJob && (chatJob.status === 'queued' || chatJob.status === 'running'));
      var loginReady = status && status.loginReady === true;
      var loginSaved = status && status.loginSaved === true;
      var models = catalog && catalog.models ? catalog.models : FALLBACK_MODELS;
      var thinkingOptions = thinkingOptionsFor(catalog, model);

      return h(
        'div',
        { className: 'dgr-page' },
        h(
          'div',
          { className: 'dgr-head' },
          h('div', { className: 'dgr-headText' },
            h('h1', { className: 'dgr-title' }, 'Gemini 对话'),
            h('div', { className: 'dgr-sub' }, '直接和 Gemini 网页端对话，同一浏览器多轮上下文；与 Deep Research 分开队列，可同时使用。')
          ),
          h('span', { className: 'dgr-badge' },
            h('span', { className: 'dgr-dot ' + (loginReady ? 'ok' : (loginSaved ? 'run' : '')) }),
            loginReady ? '登录态已验证' : (loginSaved ? '登录态待验证' : '未登录')
          )
        ),
        status === null ? h('div', { className: 'dgr-empty' }, '正在读取服务状态…') : null,
        status !== null
          ? h('div', { className: 'dgr-card' },
              h('div', { className: 'dgr-status' },
                h('span', { className: 'dgr-kv' }, h('b', null, 'Worker'), status.worker && status.worker.running ? (status.worker.ready ? '在线' : '启动中') : '未启动'),
                h('span', { className: 'dgr-kv' }, h('b', null, '对话'), running ? '进行中' : '空闲'),
                h('span', { className: 'dgr-kv' }, h('b', null, '登录态'), loginReady ? '已验证' : (loginSaved ? '待验证' : '未就绪'))
              ),
              !loginReady && !loginSaved
                ? h('div', { className: 'dgr-warn', style: { marginTop: '12px' } }, '还没有 Gemini 登录态。可以先用未登录模式对话（无历史），Deep Research 需要先点「初始化登录」。')
                : null,
              !loginReady && loginSaved
                ? h('div', { className: 'dgr-note', style: { marginTop: '12px' } }, '检测到上次登录文件，但当前未验证；发起对话时会自动验证，失败请重新初始化登录。')
                : null
            )
          : null,
        h(
          'div',
          { className: 'dgr-card dgr-col' },
          modelSelectRow(models, model, changeModel, thinkingOptions, thinking, changeThinking, running, refreshModels),
          h('div', { className: 'dgr-chatList', ref: listRef },
            messages.length === 0 && !running
              ? h('div', { className: 'dgr-chatEmpty' }, '还没有消息。输入内容开始对话。')
              : messages.map(function (item, index) {
                  return h('div', { className: 'dgr-msg ' + (item.role === 'user' ? 'user' : 'assistant'), key: 'm' + index },
                    h('div', { className: 'dgr-msgRole' }, item.role === 'user' ? '你' : 'Gemini'),
                    h('div', { className: 'dgr-msgBody' }, item.text)
                  );
                }),
            running
              ? h('div', { className: 'dgr-msg assistant' },
                  h('div', { className: 'dgr-msgRole' }, 'Gemini'),
                  h('div', { className: 'dgr-msgBody' }, chatJob && chatJob.status === 'queued' ? '排队中…' : '正在生成…')
                )
              : null
          ),
          h('div', { className: 'dgr-label' }, '消息'),
          h('textarea', {
            className: 'dgr-chatInput',
            placeholder: '输入消息，Enter 发送，Shift+Enter 换行',
            value: input,
            onChange: function (event) { setInput(event.target.value); },
            onKeyDown: onKeyDown,
            disabled: running,
          }),
          h('div', { className: 'dgr-row' },
            h('button', { className: 'dgr-btn primary', type: 'button', onClick: send, disabled: busy || running }, running ? '生成中…' : '发送'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: newChat, disabled: busy || running }, '新对话'),
            h('button', { className: 'dgr-btn', type: 'button', onClick: refreshStatus, disabled: busy }, '刷新状态')
          ),
          h('div', { className: 'dgr-note' }, '提示：普通对话和 Deep Research 共用同一个浏览器 profile，但分属两个队列、各自占一个标签页，可同时执行。模型/思考选择按消息生效；网页不支持时会保持默认。')
        ),
        error ? h('div', { className: 'dgr-warn', style: { marginBottom: '14px' } }, error) : null,
        notice ? h('div', { className: 'dgr-note', style: { marginBottom: '14px' } }, notice) : null
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
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID_CHAT }, GeminiChatPanel);
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
        disposers.push(
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID_CHAT, order: 31, label: function () { return 'Gemini 对话'; } },
              ChatIcon
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
    exports.__chatPanel = GeminiChatPanel;
    exports.__chatIcon = ChatIcon;
    return module.exports;
  },
});
