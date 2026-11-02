/* ============================================================
   Gemini Proxy — 前端逻辑
   ============================================================ */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    view: "dashboard",
    overview: null,
    logCursor: 0,
    logs: [],
    codeTab: "curl",
    baseUrl: location.origin,
    busy: false,
    pgBusy: false,
    initialized: false,
  };

  const VIEW_META = {
    dashboard: ["总览", "把 Google 网页版的 Gemini 额度，变成任何客户端都能用的 API"],
    accounts: ["账号池", "管理参与轮询的 Google 账号，随时查看健康状态"],
    endpoints: ["接口", "OpenAI / Anthropic 兼容地址与接入示例"],
    logs: ["日志", "查看代理的实时运行情况"],
    settings: ["设置", "访问控制、默认行为与网络配置"],
  };

  /* ---------------------------------------------------------- 基础工具 */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
    if (!res.ok) {
      const msg = data?.detail || data?.error?.message || `请求失败 (${res.status})`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  function toast(message, type = "ok") {
    const root = $("#toast-root");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const icon = type === "err"
      ? `<svg class="ti" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.3"/></svg>`
      : `<svg class="ti" viewBox="0 0 24 24"><path d="M4.5 12.5 9 17l10.5-10.5"/></svg>`;
    el.innerHTML = `${icon}<span>${esc(message)}</span>`;
    root.appendChild(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 220);
    }, 2400);
  }

  async function copy(text, label = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast(label);
    }
  }

  function relTime(ts) {
    if (!ts) return "—";
    const d = Date.now() / 1000 - ts;
    if (d < 5) return "刚刚";
    if (d < 60) return `${Math.floor(d)} 秒前`;
    if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
    if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
    return `${Math.floor(d / 86400)} 天前`;
  }

  function clock(ts) {
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  function fmtUptime(sec) {
    if (!sec && sec !== 0) return "—";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h} 小时 ${m} 分`;
    if (m) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
    return String(n ?? 0);
  }

  /* ---------------------------------------------------------- 视图切换 */
  function switchView(name, updateHash = true) {
    if (!VIEW_META[name]) return;
    state.view = name;
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    const [title, sub] = VIEW_META[name];
    $("#page-title").textContent = title;
    $("#page-sub").textContent = sub;
    const addBtn = $("#btn-add-account");
    addBtn.style.display = name === "accounts" || name === "dashboard" ? "" : "none";
    $("#content").scrollTop = 0;
    if (updateHash && location.hash !== `#${name}`) {
      history.replaceState(null, "", `#${name}`);
    }
  }

  /* ---------------------------------------------------------- 主题 */
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function applyTheme(theme) {
    const resolved = theme === "dark" || (theme !== "light" && darkQuery.matches) ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === "dark" ? "#0d0d0f" : "#f5f5f7";
  }
  darkQuery.addEventListener("change", () => {
    const t = state.overview?.settings?.theme || "auto";
    if (t === "auto") applyTheme("auto");
  });

  /* ---------------------------------------------------------- 数据刷新 */
  async function refresh(silent = true) {
    try {
      const data = await api("/api/overview");
      state.overview = data;
      render(data);
      if (!silent && !state.initialized) {
        state.initialized = true;
      }
    } catch (err) {
      if (!silent) toast(err.message, "err");
      $("#side-status-text").textContent = "服务未连接";
      $("#side-dot").style.background = "var(--err)";
    }
  }

  function render(data) {
    const { settings, accounts, counters, requests, models } = data;
    const online = accounts.filter((a) => a.status === "ok").length;

    // 侧栏
    $("#side-endpoint").textContent = `${settings.host}:${settings.port}`;
    $("#nav-account-count").textContent = accounts.length;
    $("#side-status-text").textContent = accounts.length ? `${online}/${accounts.length} 账号就绪` : "等待添加账号";

    // Hero
    const base = `http://${settings.host}:${settings.port}`;
    $("#hero-base-url").textContent = `${base}/v1`;
    $("#stat-uptime").textContent = fmtUptime(counters.uptime);
    $("#stat-online").textContent = accounts.length ? `${online} / ${accounts.length}` : "0";
    const last = requests[0];
    $("#stat-last").textContent = last ? relTime(last.ts) : "—";

    const chipKey = $("#chip-key");
    chipKey.className = "chip " + (settings.has_api_key ? "on" : "warn");
    chipKey.querySelector("span").textContent = settings.has_api_key ? "API Key 已启用" : "未设置 API Key";

    $("#chip-models").querySelector("span").textContent = `${models.length} 个模型`;
    const chipThinking = $("#chip-thinking");
    chipThinking.className = "chip " + (settings.thinking ? "on" : "off");
    chipThinking.querySelector("span").textContent = settings.thinking ? "思考模式开启" : "思考模式关闭";

    // 统计
    $("#stat-total").textContent = fmtNum(counters.total);
    $("#stat-total-foot").textContent = counters.failed ? `${counters.failed} 次失败` : "累计调用";
    const rate = counters.total ? Math.round(((counters.total - counters.failed) / counters.total) * 100) : null;
    $("#stat-rate").textContent = rate === null ? "—" : `${rate}%`;
    $("#stat-rate-foot").textContent = rate === null ? "还没有请求" : rate >= 95 ? "运行稳定" : "有失败请求";
    const lat = requests.length ? Math.round(requests.reduce((a, r) => a + (r.ms || 0), 0) / requests.length) : null;
    $("#stat-latency").textContent = lat === null ? "—" : lat > 1000 ? `${(lat / 1000).toFixed(1)}s` : `${lat}ms`;
    $("#stat-tokens").textContent = fmtNum(counters.tokens_in + counters.tokens_out);
    $("#stat-tokens-foot").textContent = `输入 ${fmtNum(counters.tokens_in)} / 输出 ${fmtNum(counters.tokens_out)}`;

    renderRequests(requests);
    renderAccounts(accounts);
    renderModels(models);
    renderSettings(settings, data);
    updateCodeSample();

    $("#ep-openai-base").textContent = `${base}/v1`;
    $("#ep-openai-copy").dataset.copy = `${base}/v1`;
    $("#ep-anthropic-base").textContent = base;
    $("#ep-anthropic-copy").dataset.copy = base;
    $("#ep-anthropic-model").textContent = settings.default_model || "gemini-pro";
    $("#ep-key").textContent = settings.has_api_key ? "已启用（使用你设置的 Key）" : "未设置（任意值均可）";
  }

  const EMPTY_HTML = `<tr class="empty-row"><td colspan="6"><div class="empty"><span class="empty-ico"><svg viewBox="0 0 24 24"><path d="M3.5 12.5 6 5.6A1.5 1.5 0 0 1 7.4 4.6h9.2A1.5 1.5 0 0 1 18 5.6l2.5 6.9"/><path d="M3.5 12.5h4.2l1 2.2h6.6l1-2.2h4.2v4.2a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2v-4.2Z"/></svg></span><p>还没有请求，去「接口」页看看怎么接入</p></div></td></tr>`;

  function renderRequests(requests) {
    const body = $("#req-body");
    if (!requests.length) {
      body.innerHTML = EMPTY_HTML;
      return;
    }
    body.innerHTML = requests
      .map((r) => {
        const ok = r.status === 200;
        const badge = ok
          ? `<span class="badge ok">200</span>`
          : `<span class="badge err">${esc(r.status)}</span>`;
        return `<tr>
          <td class="mono">${clock(r.ts)}</td>
          <td class="mono">${esc(r.model || "—")}</td>
          <td>${esc(r.account || "—")}</td>
          <td class="mono">${r.ms}ms</td>
          <td>${badge}</td>
          <td><span class="ellip">${esc(r.error || r.preview || "—")}</span></td>
        </tr>`;
      })
      .join("");
  }

  function statusLabel(s) {
    return { ok: "正常", error: "异常", cooldown: "冷却中", unknown: "未检测" }[s] || "未检测";
  }
  function statusClass(s) {
    return { ok: "ok", error: "err", cooldown: "warn", unknown: "mute" }[s] || "mute";
  }

  function renderAccounts(accounts) {
    const grid = $("#account-grid");
    const empty = $("#account-empty");
    if (!accounts.length) {
      grid.innerHTML = "";
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    grid.innerHTML = accounts
      .map((a) => {
        const initial = (a.name || "?").trim().charAt(0).toUpperCase() || "?";
        const success = a.successes + a.failures ? Math.round((a.successes / (a.successes + a.failures)) * 100) : null;
        const quota = (a.quota || [])
          .map(
            (q) => `<div class="q-row" title="已用 ${q.pct}%（${q.used} / ${q.total}）">
              <span class="q-label">${esc(q.label)}</span>
              <div class="q-bar"><i class="q-fill ${q.pct >= 85 ? "hot" : ""}" style="width:${q.pct}%"></i></div>
              <span class="q-pct">${q.pct}%</span>
            </div>`
          )
          .join("");
        return `<div class="account-card ${a.enabled ? "" : "disabled"}" data-status="${a.status}" data-id="${a.id}">
          <div class="acc-head">
            <div class="acc-avatar">${esc(initial)}</div>
            <div class="acc-title">
              <div class="acc-name">${esc(a.name)}</div>
              <div class="acc-sub">${esc(a.psid_masked)}${a.has_psidts ? "" : " · 缺少 PSIDTS"}</div>
            </div>
            <div class="acc-menu">
              <button class="icon-btn sm" data-act="test" title="测试连通性">
                <svg viewBox="0 0 24 24"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z"/></svg>
              </button>
              <button class="icon-btn sm" data-act="toggle" title="${a.enabled ? "停用" : "启用"}">
                ${a.enabled
                  ? `<svg viewBox="0 0 24 24"><path d="M9 8v8M15 8v8"/></svg>`
                  : `<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>`}
              </button>
              <button class="icon-btn sm" data-act="delete" title="删除">
                <svg viewBox="0 0 24 24"><path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/></svg>
              </button>
            </div>
          </div>
          ${a.last_error ? `<div class="acc-error">${esc(a.last_error)}</div>` : ""}
          <div class="acc-metrics">
            <div class="acc-metric"><span>状态</span><b><span class="badge ${statusClass(a.status)}">${statusLabel(a.status)}</span></b></div>
            <div class="acc-metric"><span>请求</span><b>${a.requests}</b></div>
            <div class="acc-metric"><span>成功率</span><b>${success === null ? "—" : success + "%"}</b></div>
            <div class="acc-metric"><span>平均</span><b>${a.avg_ms ? Math.round(a.avg_ms) + "ms" : "—"}</b></div>
          </div>
          ${quota ? `<div class="acc-quota">${quota}</div>` : ""}
          <div class="acc-foot">
            <span class="acc-time">${a.last_ok ? "上次成功 " + relTime(a.last_ok) : "尚未成功调用"}</span>
            <span class="acc-time">${a.models && a.models.length ? a.models.length + " 个模型" : ""}</span>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderModels(models) {
    $("#model-list").innerHTML = models
      .map((m) => `<div class="model-chip"><b>${esc(m.id)}</b><span>${esc(m.name || m.desc || "")}</span></div>`)
      .join("");
    const sel = $("#pg-model");
    const cur = sel.value;
    sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("");
    if (cur && models.some((m) => m.id === cur)) sel.value = cur;
    else if (state.overview?.settings?.default_model) sel.value = state.overview.settings.default_model;

    const setModel = $("#set-model");
    const curSet = setModel.value;
    setModel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("");
    if (curSet && models.some((m) => m.id === curSet)) setModel.value = curSet;
    else if (state.overview?.settings?.default_model) setModel.value = state.overview.settings.default_model;
  }

  function renderSettings(settings, data) {
    const keyHint = $("#set-key-hint");
    if (settings.has_api_key) {
      keyHint.textContent = `当前：${settings.api_key_masked}（留空则不修改）`;
    } else {
      keyHint.textContent = "当前：未设置，本机任何程序都能调用";
    }
    if (document.activeElement !== $("#set-key")) $("#set-key").value = "";

    if (document.activeElement !== $("#set-cooldown")) $("#set-cooldown").value = settings.cooldown_seconds;
    if (document.activeElement !== $("#set-timeout")) $("#set-timeout").value = settings.request_timeout;
    if (document.activeElement !== $("#set-proxy")) $("#set-proxy").value = settings.proxy || "";
    $("#set-thinking").checked = !!settings.thinking;
    if (document.activeElement !== $("#set-model") && settings.default_model) $("#set-model").value = settings.default_model;

    $("#about-host").textContent = `${settings.host}:${settings.port}`;
    $("#about-dir").textContent = data.data_dir || "%LOCALAPPDATA%\\GeminiProxy";
    $("#about-docs").href = `http://${settings.host}:${settings.port}/docs`;
    if (document.activeElement !== $("#set-theme")) $("#set-theme").value = settings.theme || "auto";
    applyTheme(settings.theme || "auto");
  }

  /* ---------------------------------------------------------- 代码示例 */
  const CODE_SAMPLES = {
    curl: () => `curl http://${host()}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyOrAny()}" \\
  -d '{
    "model": "${modelOrDefault()}",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'`,
    python: () => `from openai import OpenAI

client = OpenAI(
    base_url="http://${host()}/v1",
    api_key="${keyOrAny()}",
)

resp = client.chat.completions.create(
    model="${modelOrDefault()}",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)`,
    node: () => `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://${host()}/v1",
  apiKey: "${keyOrAny()}",
});

const stream = await client.chat.completions.create({
  model: "${modelOrDefault()}",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
    env: () => `# OpenAI 兼容客户端通用环境变量
OPENAI_BASE_URL=http://${host()}/v1
OPENAI_API_KEY=${keyOrAny()}

# Claude Code 走 Anthropic 协议
ANTHROPIC_BASE_URL=http://${host()}
ANTHROPIC_AUTH_TOKEN=${keyOrAny()}
ANTHROPIC_MODEL=${modelOrDefault()}`,
  };

  const host = () => {
    const s = state.overview?.settings;
    return s ? `${s.host}:${s.port}` : location.host;
  };
  const keyOrAny = () => (state.overview?.settings?.has_api_key ? "你的 API Key" : "sk-local");
  const modelOrDefault = () =>
    state.overview?.settings?.default_model || state.overview?.models?.[0]?.id || "gemini-pro";

  function updateCodeSample() {
    const fn = CODE_SAMPLES[state.codeTab] || CODE_SAMPLES.curl;
    $("#code-block").textContent = fn();
  }

  /* ---------------------------------------------------------- 弹窗 */
  function openModal(html) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-backdrop">${html}</div>`;
    const backdrop = root.querySelector(".modal-backdrop");
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) closeModal();
    });
    const first = root.querySelector("input, textarea");
    if (first) setTimeout(() => first.focus(), 60);
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }

  function addAccountModal() {
    openModal(`
      <div class="modal" role="dialog">
        <div class="modal-head">
          <div>
            <h3>添加 Google 账号</h3>
            <p>粘贴 Cookie 即可，程序会自动识别其中的两个字段</p>
          </div>
          <button class="icon-btn" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        <div class="modal-body">
          <label class="field">
            <span>账号名称</span>
            <input type="text" id="m-name" placeholder="例如：主号" />
          </label>
          <label class="field">
            <span>Cookie <em style="color:var(--err)">*</em></span>
            <textarea id="m-psid" rows="3" spellcheck="false"
              placeholder="直接粘贴整段 Cookie：&#10;__Secure-1PSID=g.a000…; __Secure-1PSIDTS=sidts…&#10;或只填 __Secure-1PSID 的值"></textarea>
            <em>两种都行：整段 Cookie（推荐，两个字段一次搞定）或单独的 PSID 值</em>
          </label>
          <label class="field">
            <span>__Secure-1PSIDTS</span>
            <input type="text" id="m-psidts" placeholder="粘贴整段 Cookie 时可留空" spellcheck="false" />
          </label>
          <div class="modal-hint">
            <b>怎么拿：</b>浏览器打开 <b>gemini.google.com</b> 并登录 → 按 <code>F12</code> →
            <b>Application</b> → 左侧 <b>Cookies</b> → <code>https://gemini.google.com</code> →
            找到 <code>__Secure-1PSID</code> 和 <code>__Secure-1PSIDTS</code>，双击 Value 复制。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-close>取消</button>
          <button class="btn ghost" id="m-import">
            <svg viewBox="0 0 24 24"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13A1.5 1.5 0 0 0 20 19.5V17"/></svg>
            从浏览器读取
          </button>
          <button class="btn primary" id="m-save">添加</button>
        </div>
      </div>`);

    $("#m-save").addEventListener("click", async () => {
      const raw = $("#m-psid").value.trim();
      if (!raw) return toast("请粘贴 Cookie", "err");
      try {
        await api("/api/accounts", {
          method: "POST",
          body: { name: $("#m-name").value.trim() || "Google 账号", psid: raw, psidts: $("#m-psidts").value.trim() },
        });
        closeModal();
        toast("账号已添加，点 ⚡ 测试连通性");
        await refresh();
        switchView("accounts");
      } catch (e) { toast(e.message, "err"); }
    });

    $("#m-import").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "读取中…";
      try {
        const r = await api("/api/accounts/import-browser", { method: "POST", body: {} });
        closeModal();
        toast(`已从 ${r.browser} 导入`);
        await refresh();
        switchView("accounts");
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = "从浏览器读取";
      }
    });
  }

  function confirmModal(title, desc, onOk, danger = true) {
    openModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-head"><div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div></div>
        <div class="modal-foot">
          <button class="btn ghost" data-close>取消</button>
          <button class="btn ${danger ? "danger" : "primary"}" id="m-ok">确定</button>
        </div>
      </div>`);
    $("#m-ok").addEventListener("click", async () => {
      closeModal();
      await onOk();
    });
  }

  /* ---------------------------------------------------------- 事件绑定 */
  function bind() {
    $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
    $("#btn-add-account").addEventListener("click", addAccountModal);
    $("#btn-empty-add").addEventListener("click", addAccountModal);
    $("#btn-empty-import").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "读取中…";
      try {
        const r = await api("/api/accounts/import-browser", { method: "POST", body: {} });
        toast(`已从 ${r.browser} 导入`);
        await refresh();
      } catch (err) { toast(err.message, "err"); }
      finally { btn.disabled = false; btn.textContent = "从浏览器导入"; }
    });

    $("#btn-refresh").addEventListener("click", async () => {
      await refresh(false);
      toast("已刷新");
    });

    $("#btn-copy-base").addEventListener("click", () => copy(`http://${host()}/v1`, "Base URL 已复制"));
    $("#side-endpoint").addEventListener("click", () => copy(`http://${host()}`, "地址已复制"));

    document.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("[data-copy]");
      if (copyBtn) copy(copyBtn.dataset.copy, "已复制");
      const closeBtn = e.target.closest("[data-close]");
      if (closeBtn) closeModal();
      const tab = e.target.closest("#code-tabs .tab");
      if (tab) {
        state.codeTab = tab.dataset.tab;
        $$("#code-tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
        updateCodeSample();
      }
      const act = e.target.closest("[data-act]");
      if (act) handleAccountAction(act);
    });

    $("#btn-copy-code").addEventListener("click", () => copy($("#code-block").textContent, "示例已复制"));

    $("#btn-clear-requests").addEventListener("click", async () => {
      await api("/api/requests/clear", { method: "POST" });
      await refresh();
      toast("已清空");
    });

    $("#btn-clear-logs").addEventListener("click", async () => {
      await api("/api/logs/clear", { method: "POST" });
      state.logCursor = 0;
      state.logs = [];
      $("#log-view").innerHTML = `<div class="log-empty">日志已清空</div>`;
      toast("日志已清空");
    });

    $("#btn-save-settings").addEventListener("click", async () => {
      const patch = {
        thinking: $("#set-thinking").checked,
        cooldown_seconds: Number($("#set-cooldown").value) || 90,
        request_timeout: Number($("#set-timeout").value) || 180,
        proxy: $("#set-proxy").value.trim(),
        default_model: $("#set-model").value,
        theme: $("#set-theme").value,
      };
      const key = $("#set-key").value.trim();
      if (key) patch.api_key = key;
      try {
        await api("/api/settings", { method: "POST", body: patch });
        toast("设置已保存");
        await refresh();
      } catch (e) { toast(e.message, "err"); }
    });

    $("#btn-gen-key").addEventListener("click", () => {
      const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let out = "sk-";
      const buf = new Uint32Array(28);
      crypto.getRandomValues(buf);
      for (const n of buf) out += chars[n % chars.length];
      $("#set-key").value = out;
      toast("已生成，记得点保存");
    });

    // 在线试跑
    $("#pg-send").addEventListener("click", async () => {
      if (state.pgBusy) return;
      const prompt = $("#pg-input").value.trim();
      if (!prompt) return toast("先写点什么", "err");
      const out = $("#pg-out");
      state.pgBusy = true;
      const btn = $("#pg-send");
      btn.disabled = true;
      btn.textContent = "生成中…";
      out.classList.add("show");
      out.innerHTML = `<div class="pg-meta">正在请求上游模型…</div>`;
      try {
        const r = await api("/api/playground", {
          method: "POST",
          body: { prompt, model: $("#pg-model").value, thinking: $("#pg-thinking").checked },
        });
        out.innerHTML = `<div class="pg-meta"><span>${esc(r.account)}</span><span>${r.elapsed}s</span></div>${esc(r.text)}`;
      } catch (e) {
        out.innerHTML = `<div class="pg-meta" style="color:var(--err)">请求失败</div>${esc(e.message)}`;
      } finally {
        state.pgBusy = false;
        btn.disabled = false;
        btn.textContent = "发送";
      }
    });

    $("#pg-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#pg-send").click();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
      if (e.key === "Enter" && $("#modal-root").innerHTML && $("#m-save")) $("#m-save").click();
    });
  }

  async function handleAccountAction(btn) {
    const card = btn.closest(".account-card");
    if (!card) return;
    const id = card.dataset.id;
    const act = btn.dataset.act;

    if (act === "delete") {
      const name = card.querySelector(".acc-name").textContent;
      confirmModal("删除账号", `确定要删除「${name}」吗？该操作不可撤销。`, async () => {
        await api(`/api/accounts/${id}`, { method: "DELETE" });
        toast("已删除");
        await refresh();
      });
      return;
    }

    if (act === "toggle") {
      const disabled = card.classList.contains("disabled");
      await api(`/api/accounts/${id}`, { method: "PATCH", body: { enabled: disabled } });
      toast(disabled ? "已启用" : "已停用");
      await refresh();
      return;
    }

    if (act === "test") {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg viewBox="0 0 24 24" style="animation:spin 1s linear infinite"><path d="M12 3a9 9 0 1 0 9 9"/></svg>`;
      btn.disabled = true;
      try {
        const r = await api(`/api/accounts/${id}/test`, { method: "POST" });
        toast(`连接正常 · ${r.elapsed}s`, "ok");
        const models = (r.models || []).map((m) => m.id).join("、") || "—";
        const quota = (r.quota || []).map((q) => `${q.label} 已用 ${q.pct}%`).join("　");
        openModal(`
          <div class="modal" style="max-width:420px">
            <div class="modal-head">
              <div><h3>账号连接正常</h3><p>握手耗时 ${r.elapsed}s · ${esc(r.account_status || "状态正常")}</p></div>
              <button class="icon-btn" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
            </div>
            <div class="modal-body">
              <div class="kv"><span>可用模型</span><div class="kv-val"><code>${esc(models)}</code></div></div>
              ${quota ? `<div class="kv"><span>额度</span><div class="kv-val"><code>${esc(quota)}</code></div></div>` : ""}
            </div>
            <div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>
          </div>`);
      } catch (e) {
        toast(e.message, "err");
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
        await refresh();
      }
    }
  }

  /* ---------------------------------------------------------- 日志轮询 */
  async function pollLogs() {
    if (state.view !== "logs") return;
    try {
      const data = await api(`/api/logs?after=${state.logCursor}`);
      if (!data.logs.length) return;
      const view = $("#log-view");
      const auto = $("#log-autoscroll").checked;
      for (const line of data.logs) {
        state.logCursor = Math.max(state.logCursor, line.id);
        const el = document.createElement("div");
        el.className = "log-line";
        el.innerHTML = `<span class="t">${clock(line.ts)}</span><span class="lv ${line.level}">${line.level}</span><span class="m">${esc(line.msg)}</span>`;
        view.appendChild(el);
      }
      while (view.children.length > 600) view.removeChild(view.firstChild);
      if (auto) view.scrollTop = view.scrollHeight;
    } catch { /* 忽略 */ }
  }

  /* ---------------------------------------------------------- 启动 */
  function injectKeyframes() {
    const style = document.createElement("style");
    style.textContent = "@keyframes spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  }

  async function boot() {
    injectKeyframes();
    bind();
    await refresh(false);
    setInterval(() => refresh(true), 2500);
    setInterval(pollLogs, 1200);
    const initial = location.hash.replace("#", "");
    switchView(VIEW_META[initial] ? initial : "dashboard", false);
    window.addEventListener("hashchange", () => {
      const name = location.hash.replace("#", "");
      if (VIEW_META[name] && name !== state.view) switchView(name, false);
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
