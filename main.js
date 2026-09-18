/*
 * main.js —— 伊纳特语词典 · 静态阅读器
 *
 * 职责：
 *   1. 异步加载 data/index.json，容错处理网络失败 / 超时
 *   2. 首字母导航（A-Z + 全部）
 *   3. 全文搜索（可与字母筛选组合）
 *   4. 词条卡片 + 折叠式变格/变位面板（各卡片状态互相独立）
 *   5. 页面层级：首页 → 字母分组 → 词条详情，含返回导航与滚动重置
 *
 * 本文件不写任何词条数据，也不修改 data/ 目录 —— 纯只读渲染。
 */

(function () {
  "use strict";

  const INDEX_URL = "data/index.json";
  const FETCH_TIMEOUT_MS = 8000;

  const POS_LABEL = { n: "名词", v: "动词", adj: "形容词" };

  // 伊纳特语真实字母表（按你提供的顺序，不是拉丁字母顺序）。
  // 必须跟 make_index.py 里的 CUSTOM_ALPHABET 顺序完全一一对应，
  // 唯一区别是这里每个字母首字符大写、那边全小写。
  const ALPHABET = [
    "A", "Ă", "B", "C", "Ç", "D", "E", "F", "G", "H", "I", "Ŭ", "J", "K", "L",
    "M", "N", "Ń", "O", "P", "Ž", "R", "S", "T", "X", "U", "V", "W", "Z",
  ];

  /** @type {{word:string,pos:string,[k:string]:any}[]} */
  let allEntries = [];
  let loadFailed = false;

  const state = {
    letter: null,      // 当前选中的首字母，null = 全部
    query: "",          // 当前搜索关键词
    detailId: null,     // 当前详情页词条 id，null = 未打开详情
    openPanels: new Set(), // 展开中的“变格/变位”面板（跨视图记忆展开状态）
  };

  let lastLevel = null; // 用于判断是否需要滚动回页面顶部

  // ------------------------------------------------------------------
  // DOM 引用
  // ------------------------------------------------------------------

  const el = {
    alphabetNav: document.getElementById("alphabet-nav"),
    searchInput: document.getElementById("search-input"),
    searchClear: document.getElementById("search-clear"),
    breadcrumb: document.getElementById("breadcrumb"),
    loadingIndicator: document.getElementById("loading-indicator"),
    statusBanner: document.getElementById("status-banner"),
    listMeta: document.getElementById("list-meta"),
    entryList: document.getElementById("entry-list"),
    entryDetail: document.getElementById("entry-detail"),
  };

  // ------------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function firstLetter(entry) {
    // 优先用后端 make_index.py 按伊纳特语真实字母表算好的 letter 字段
    // （能正确识别 th 这种复合字母）；如果索引还是旧格式没有这个字段，
    // 退化成取词的第一个字符，保证页面不报错。
    if (entry.letter) return entry.letter;
    return (entry.word || "").trim().charAt(0).toUpperCase();
  }

  function scrollToTopIfLevelChanged(currentLevel) {
    if (currentLevel !== lastLevel) {
      window.scrollTo({ top: 0, behavior: "auto" });
      lastLevel = currentLevel;
    }
  }

  function matchesQuery(entry, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    const haystacks = [
      entry.word,
      entry.translations?.zh,
      entry.translations?.en,
      entry.translations?.es,
      ...(entry.examples || []).flatMap((ex) => [
        ex["Modern Inattian"], ex.zh, ex.en, ex.es,
      ]),
      ...(entry.tags || []),
    ];
    return haystacks.some((h) => h && String(h).toLowerCase().includes(q));
  }

  /** 转义字符串中会破坏正则的特殊字符 */
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * 对原始文本做 HTML 转义的同时，把第一处匹配 query 的子串包进 <mark> 高亮。
   * 找不到匹配、或 query 为空时，等价于普通的 escapeHtml。
   */
  function highlightHtml(rawText, query) {
    const text = String(rawText ?? "");
    if (!query) return escapeHtml(text);
    const re = new RegExp(escapeRegExp(query), "i");
    const match = re.exec(text);
    if (!match) return escapeHtml(text);
    const before = text.slice(0, match.index);
    const hit = text.slice(match.index, match.index + match[0].length);
    const after = text.slice(match.index + match[0].length);
    return `${escapeHtml(before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}`;
  }

  // ------------------------------------------------------------------
  // 数据加载（容错：超时 / 网络失败都不能让页面卡死或崩溃）
  // ------------------------------------------------------------------

  async function loadIndex() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(INDEX_URL, { signal: controller.signal, cache: "no-cache" });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.entries)) {
        throw new Error("索引文件格式不正确");
      }
      allEntries = data.entries;
      loadFailed = false;
    } catch (err) {
      clearTimeout(timer);
      loadFailed = true;
      console.error("词典索引加载失败：", err);
    }

    el.loadingIndicator.hidden = true;
    buildAlphabetNav();
    render();
  }

  // ------------------------------------------------------------------
  // 首字母导航
  // ------------------------------------------------------------------

  function buildAlphabetNav() {
    const available = new Set(allEntries.map((e) => firstLetter(e)));

    el.alphabetNav.innerHTML = "";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "is-reset";
    resetBtn.textContent = "全部";
    resetBtn.addEventListener("click", () => {
      state.letter = null;
      state.detailId = null;
      render();
    });
    el.alphabetNav.appendChild(resetBtn);

    ALPHABET.forEach((letter) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = letter;
      if (!available.has(letter)) btn.disabled = true;
      btn.addEventListener("click", () => {
        state.letter = letter;
        state.detailId = null;
        render();
      });
      el.alphabetNav.appendChild(btn);
    });

    syncAlphabetActiveState();
  }

  function syncAlphabetActiveState() {
    const buttons = el.alphabetNav.querySelectorAll("button");
    buttons.forEach((btn) => {
      const isAll = btn.classList.contains("is-reset");
      const isActive = isAll ? state.letter === null : btn.textContent === state.letter;
      btn.classList.toggle("is-active", isActive);
    });
  }

  // ------------------------------------------------------------------
  // 搜索输入
  // ------------------------------------------------------------------

  el.searchInput.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    el.searchClear.hidden = state.query === "";
    // 清空搜索框时，query 变为空字符串，视图自动回退到当前字母分组 / 首页——
    // 这是天然发生的，因为搜索只是在当前上下文之上叠加的过滤条件。
    render();
  });

  // 处理浏览器自动填充/前进后退导致输入框已有内容的情况
  if (el.searchInput.value.trim()) {
    state.query = el.searchInput.value.trim();
    el.searchClear.hidden = false;
  }

  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    state.query = "";
    el.searchClear.hidden = true;
    el.searchInput.focus();
    render();
  });

  // ------------------------------------------------------------------
  // 渲染：面板（折叠式变格 / 变位）
  // ------------------------------------------------------------------

  function renderDeclensionTable(declension) {
    const numberLabels = Object.keys(declension || {});
    if (numberLabels.length === 0) {
      return `<p class="status-banner is-empty">暂无变格数据。</p>`;
    }
    return numberLabels.map((numberLabel) => {
      const cases = declension[numberLabel] || {};
      const caseNames = Object.keys(cases);
      return `
        <table class="form-table">
          <caption>${escapeHtml(numberLabel)}</caption>
          <tbody>
            ${caseNames.map((c) => `
              <tr><th>${escapeHtml(c)}</th><td>${escapeHtml(cases[c] || "—")}</td></tr>
            `).join("")}
          </tbody>
        </table>`;
    }).join("");
  }

  function renderConjugationTable(conjugation) {
    const tenses = Object.keys(conjugation || {});
    if (tenses.length === 0) {
      return `<p class="status-banner is-empty">变位数据生成中，请稍后运行 make_index.py。</p>`;
    }
    return tenses.map((tense) => {
      const forms = conjugation[tense] || {};
      const persons = Object.keys(forms);
      return `
        <div class="tense-block">
          <table class="form-table">
            <caption>${escapeHtml(tense)}</caption>
            <tbody>
              ${persons.map((p) => `
                <tr><th>${escapeHtml(p)}</th><td>${escapeHtml(forms[p] || "—")}</td></tr>
              `).join("")}
            </tbody>
          </table>
        </div>`;
    }).join("");
  }

  function renderGrammarPanel(entry) {
    const isNounLike = entry.pos === "n" || entry.pos === "adj";
    const isVerb = entry.pos === "v";
    if (!isNounLike && !isVerb) return "";

    const panelId = `panel-${entry.id}`;
    const isOpen = state.openPanels.has(entry.id);
    const title = isNounLike ? "名词变格" : "动词变位";
    const body = isNounLike
      ? renderDeclensionTable(entry.declension)
      : renderConjugationTable(entry.conjugation);

    return `
      <div class="panel ${isOpen ? "is-open" : ""}" data-panel-entry="${escapeHtml(entry.id)}">
        <button type="button" class="panel__toggle" aria-expanded="${isOpen}" aria-controls="${panelId}">
          <span>${title}</span>
          <span class="panel__arrow">${isOpen ? "▼" : "▶"}</span>
        </button>
        <div class="panel__body" id="${panelId}"><div class="panel__body-inner">${body}</div></div>
      </div>`;
  }

  // ------------------------------------------------------------------
  // 渲染：词条卡片（完整信息 + 折叠面板）
  // ------------------------------------------------------------------

  function renderEntryCard(entry, { clickableHeader, prevEntry, nextEntry }) {
    const etymologyHtml = (entry.etymology || []).length
      ? `<ul class="etymology-list">${entry.etymology.map((e) => `
          <li><strong>${escapeHtml(e.part)}</strong> — ${escapeHtml(e.meaning)}</li>
        `).join("")}</ul>`
      : `<p class="status-banner is-empty">暂无词源信息。</p>`;

    const examplesHtml = (entry.examples || []).length
      ? `<ul class="example-list">${entry.examples.map((ex) => `
          <li class="example-item">
            <div class="example-item__source">${escapeHtml(ex["Modern Inattian"])}</div>
            <div class="example-item__gloss">
              ${[ex.zh, ex.en, ex.es].filter(Boolean).map(escapeHtml).join(" · ")}
            </div>
          </li>`).join("")}</ul>`
      : `<p class="status-banner is-empty">暂无例句。</p>`;

    const relationsHtml = ((entry.synonyms || []).length || (entry.antonyms || []).length)
      ? `
        ${(entry.synonyms || []).length ? `<p><strong>近义词：</strong>${entry.synonyms.map(escapeHtml).join("、")}</p>` : ""}
        ${(entry.antonyms || []).length ? `<p><strong>反义词：</strong>${entry.antonyms.map(escapeHtml).join("、")}</p>` : ""}
      `
      : "";

    const tagsHtml = (entry.tags || []).length
      ? `<div class="tag-list">${entry.tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

    const headerWord = clickableHeader
      ? `<button type="button" class="detail-card__word as-link" data-open-detail="${escapeHtml(entry.id)}" style="background:none;border:none;cursor:pointer;padding:0;">${escapeHtml(entry.word)}</button>`
      : `<h2 class="detail-card__word">${escapeHtml(entry.word)}</h2>`;

    const navHtml = clickableHeader ? "" : `
      <nav class="detail-nav" aria-label="上一词条 / 下一词条">
        <button type="button" ${prevEntry ? `data-open-detail="${escapeHtml(prevEntry.id)}"` : "disabled"}>
          <span class="detail-nav__label">‹ 上一词条</span>
          <span class="detail-nav__word">${prevEntry ? escapeHtml(prevEntry.word) : "—"}</span>
        </button>
        <button type="button" ${nextEntry ? `data-open-detail="${escapeHtml(nextEntry.id)}"` : "disabled"}>
          <span class="detail-nav__label">下一词条 ›</span>
          <span class="detail-nav__word">${nextEntry ? escapeHtml(nextEntry.word) : "—"}</span>
        </button>
      </nav>`;

    return `
      <article class="detail-card" data-entry-card="${escapeHtml(entry.id)}">
        <div class="detail-card__head">
          ${headerWord}
          <span class="detail-card__pos">${POS_LABEL[entry.pos] || entry.pos}</span>
          ${entry.gender ? `<span class="detail-card__gender">${escapeHtml(entry.gender)}</span>` : ""}
        </div>

        <dl class="translation-list">
          <div><dt>中文</dt><dd>${escapeHtml(entry.translations?.zh || "—")}</dd></div>
          <div><dt>English</dt><dd>${escapeHtml(entry.translations?.en || "—")}</dd></div>
          <div><dt>Español</dt><dd>${escapeHtml(entry.translations?.es || "—")}</dd></div>
        </dl>

        <div class="detail-section">
          <h3>词源</h3>
          ${etymologyHtml}
        </div>

        <div class="detail-section">
          <h3>例句</h3>
          ${examplesHtml}
        </div>

        ${relationsHtml ? `<div class="detail-section">${relationsHtml}</div>` : ""}
        ${tagsHtml ? `<div class="detail-section">${tagsHtml}</div>` : ""}

        ${renderGrammarPanel(entry)}
        ${navHtml}
      </article>`;
  }

  function renderEntryListRow(entry, query) {
    const gloss = [entry.translations?.zh, entry.translations?.en, entry.translations?.es]
      .filter(Boolean).join(" / ");
    return `
      <button type="button" class="entry-row" data-open-detail="${escapeHtml(entry.id)}">
        <span class="entry-row__word">${highlightHtml(entry.word, query)}</span>
        <span class="entry-row__pos">${POS_LABEL[entry.pos] || entry.pos}</span>
        <span class="entry-row__gloss">${highlightHtml(gloss, query)}</span>
      </button>`;
  }

  // ------------------------------------------------------------------
  // 面包屑（返回导航）
  // ------------------------------------------------------------------

  function renderBreadcrumb() {
    if (state.detailId) {
      el.breadcrumb.hidden = false;
      el.breadcrumb.innerHTML = `<button type="button" data-back="detail">‹ 返回词条列表</button>`;
      return;
    }
    if (state.letter) {
      el.breadcrumb.hidden = false;
      el.breadcrumb.innerHTML = `<button type="button" data-back="letter">‹ 返回全部词条</button>`;
      return;
    }
    el.breadcrumb.hidden = true;
    el.breadcrumb.innerHTML = "";
  }

  // ------------------------------------------------------------------
  // 主渲染函数
  // ------------------------------------------------------------------

  function render() {
    syncAlphabetActiveState();
    renderBreadcrumb();

    // --- 加载失败：显示友好提示，页面其余部分仍可用 ---
    if (loadFailed) {
      el.statusBanner.hidden = false;
      el.statusBanner.textContent =
        "词典数据加载失败（网络超时或连接中断）。请检查网络连接后刷新页面重试，页面其他部分仍可正常浏览。";
      el.listMeta.hidden = true;
      el.entryList.hidden = false;
      el.entryList.innerHTML = "";
      el.entryDetail.hidden = true;
      scrollToTopIfLevelChanged("error");
      return;
    }
    el.statusBanner.hidden = true;

    // --- 详情页 ---
    if (state.detailId) {
      const idx = allEntries.findIndex((e) => e.id === state.detailId);
      const entry = idx === -1 ? null : allEntries[idx];
      el.listMeta.hidden = true;
      el.entryList.hidden = true;
      el.entryDetail.hidden = false;
      if (!entry) {
        el.entryDetail.innerHTML = `<p class="status-banner">未找到该词条，可能已被移除。</p>`;
      } else {
        const prevEntry = idx > 0 ? allEntries[idx - 1] : null;
        const nextEntry = idx < allEntries.length - 1 ? allEntries[idx + 1] : null;
        el.entryDetail.innerHTML = renderEntryCard(entry, {
          clickableHeader: false, prevEntry, nextEntry,
        });
      }
      scrollToTopIfLevelChanged("detail");
      return;
    }

    // --- 列表页（首页 / 字母分组，可叠加搜索） ---
    el.entryDetail.hidden = true;
    el.entryList.hidden = false;

    const byLetter = state.letter
      ? allEntries.filter((e) => firstLetter(e) === state.letter)
      : allEntries;

    if (state.letter && byLetter.length === 0) {
      el.listMeta.hidden = true;
      el.entryList.innerHTML = `<p class="status-banner is-empty">字母 “${escapeHtml(state.letter)}” 暂无词条。</p>`;
      scrollToTopIfLevelChanged(`letter:${state.letter}`);
      return;
    }

    const visible = byLetter.filter((e) => matchesQuery(e, state.query));

    const currentLevel = state.query
      ? `search:${state.letter || "all"}:${state.query}`
      : `letter:${state.letter || "all"}`;

    if (visible.length === 0) {
      el.listMeta.hidden = true;
      el.entryList.innerHTML = `<p class="status-banner is-empty">没有找到匹配 “${escapeHtml(state.query)}” 的词条。</p>`;
      scrollToTopIfLevelChanged(currentLevel);
      return;
    }

    // 统一的计数提示行：区分“搜索结果”与普通浏览
    el.listMeta.hidden = false;
    if (state.query) {
      el.listMeta.textContent = `搜索结果 · 共 ${visible.length} 条${state.letter ? `（字母 ${state.letter} 内）` : ""}`;
    } else if (state.letter) {
      el.listMeta.textContent = `字母 ${state.letter} · 共 ${visible.length} 条`;
    } else {
      el.listMeta.textContent = `全部词条 · 共 ${visible.length} 条`;
    }

    el.entryList.innerHTML = visible.map((e) => renderEntryListRow(e, state.query)).join("");

    // 只在真正切换“层级”时才滚动到顶部，避免搜索打字时跳动
    scrollToTopIfLevelChanged(state.detailId ? "detail" : (state.letter || "home"));
  }

  // ------------------------------------------------------------------
  // 事件委托：打开详情 / 返回 / 展开折叠面板
  // ------------------------------------------------------------------

  document.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-open-detail]");
    if (openBtn) {
      state.detailId = openBtn.getAttribute("data-open-detail");
      render();
      return;
    }

    const backBtn = e.target.closest("[data-back]");
    if (backBtn) {
      if (backBtn.dataset.back === "detail") {
        state.detailId = null;
      } else if (backBtn.dataset.back === "letter") {
        state.letter = null;
      }
      render();
      return;
    }

    const toggleBtn = e.target.closest(".panel__toggle");
    if (toggleBtn) {
      const panelEl = toggleBtn.closest(".panel");
      const entryId = panelEl?.dataset.panelEntry;
      if (!entryId) return;
      if (state.openPanels.has(entryId)) {
        state.openPanels.delete(entryId);
      } else {
        state.openPanels.add(entryId);
      }
      // 只切换当前面板的开合，不重新计算整页布局位置
      panelEl.classList.toggle("is-open");
      const expanded = panelEl.classList.contains("is-open");
      toggleBtn.setAttribute("aria-expanded", String(expanded));
      const arrow = toggleBtn.querySelector(".panel__arrow");
      if (arrow) arrow.textContent = expanded ? "▼" : "▶";
    }
  });

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  loadIndex();
})();
