// 管理页面脚本 - 完全重写，解决字体重叠和详情页按钮失效
document.addEventListener('DOMContentLoaded', async () => {
  // 确认 QuoteBoxDB 可用
  if (typeof QuoteBoxDB === 'undefined') {
    showToast('❌ QuoteBoxDB 未定义，请重新加载扩展', 'error');
    console.error('[QuoteBox] QuoteBoxDB 未定义！');
    return;
  }
  console.log('[QuoteBox] Manager 启动, QuoteBoxDB ✓');
  
  const cardsContainer = document.getElementById('cards-container');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const totalCount = document.getElementById('total-count');
  const viewTitle = document.getElementById('view-title');
  const detailPanel = document.getElementById('detail-panel');
  const overlay = document.getElementById('overlay');
  
  let currentView = 'all';
  let allCards = [];
  let selectedCardId = null;
  let selectedCardData = null;
  let sortMode = 'time-desc'; // time-desc | time-asc | manual
  
  // ★★★ 多选状态
  const selectedIds = new Set();
  const exportSelectedBtn = document.getElementById('export-selected');
  const clearSelectionBtn = document.getElementById('clear-selection');
  const selectedCountSpan = document.getElementById('selected-count');
  const deleteSelectedBtn = document.getElementById('delete-selected');
  const deleteCountSpan = document.getElementById('delete-count');
  const sortSelect = document.getElementById('sort-select');
  
  // 启动加载
  await loadCards();
  
  // === 导航切换 ===
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentView = item.dataset.view;
      viewTitle.textContent = currentView === 'all' ? '全部卡片' : '最近保存';
      renderCards();
    });
  });
  
  searchInput.addEventListener('input', renderCards);
  
  // === 导入（只新增、不覆盖、自动去重） ===
  const importFile = document.getElementById('import-file');
  document.getElementById('import-data').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const cards = data.cards || data;
      if (!Array.isArray(cards)) throw new Error('文件格式不正确');
      
      const result = await QuoteBoxDB.importCardsAddOnly(cards);
      showToast(`✓ 成功导入 ${result.added} 张卡片`, 'success');
      await loadCards();
    } catch (error) { showToast('导入失败: ' + error.message, 'error'); }
    finally { importFile.value = ''; }
  });
  
  // === 导出全部 ===
  document.getElementById('export-all').addEventListener('click', async () => {
    try {
      const data = await QuoteBoxDB.getAllCards();
      if (data.length === 0) {
        showToast('还没有任何卡片', 'error');
        return;
      }
      await triggerDownload(data);
      showToast(`✓ 已导出 ${data.length} 张卡片`, 'success');
    } catch (error) { showToast('导出失败: ' + error.message, 'error'); }
  });
  
  // === 详情面板事件 ===
  document.getElementById('close-detail').addEventListener('click', closeDetail);
  overlay.addEventListener('click', closeDetail);
  
  // 编辑模式切换
  let isEditMode = false;
  let originalSnapshot = null; // 进入编辑模式前的原始快照
  const toggleEditBtn = document.getElementById('toggle-edit');
  const saveEditBtn = document.getElementById('save-edit');
  const restoreEditBtn = document.getElementById('restore-edit');
  
  toggleEditBtn.addEventListener('click', () => toggleEditMode(true));
  saveEditBtn.addEventListener('click', saveEditedContent);
  restoreEditBtn.addEventListener('click', restoreOriginalContent);
  
  function toggleEditMode(edit) {
    const contentEl = document.getElementById('detail-content');
    
    if (edit) {
      // 进入编辑模式 —— 保存快照
      isEditMode = true;
      originalSnapshot = {
        htmlContent: selectedCardData?.htmlContent || '',
        plainText: selectedCardData?.plainText || '',
        images: (selectedCardData?.images || []).map(img => ({ ...img })) // ★ 深拷贝
      };
      
      // 在 shadow DOM 里把容器设为 contenteditable
      const container = contentEl.shadowRoot?.querySelector('div');
      if (container) {
        container.setAttribute('contenteditable', 'true');
        container.setAttribute('spellcheck', 'true');
      }
      contentEl.classList.add('editable');
      
      // 按钮切换
      toggleEditBtn.style.display = 'none';
      saveEditBtn.style.display = 'flex';
      restoreEditBtn.style.display = 'flex';
      
      showToast('✎ 编辑模式已开启', 'success');
    } else {
      // 退出编辑模式（不保存）
      isEditMode = false;
      const container = contentEl.shadowRoot?.querySelector('div');
      if (container) container.removeAttribute('contenteditable');
      contentEl.classList.remove('editable');
      
      toggleEditBtn.style.display = 'flex';
      saveEditBtn.style.display = 'none';
      restoreEditBtn.style.display = 'none';
      
      // 恢复原文
      if (originalSnapshot) {
        restoreOriginalContent();
        originalSnapshot = null;
      }
    }
  }
  
  async function saveEditedContent() {
    if (!selectedCardId) return;
    
    try {
      const contentEl = document.getElementById('detail-content');
      const container = contentEl.shadowRoot?.querySelector('div');
      if (!container) {
        showToast('找不到编辑内容', 'error');
        return;
      }
      
      // 从 DOM 提取修改后的内容
      const newHTML = container.innerHTML;
      const newPlainText = container.textContent || '';
      
      // ★ 从编辑后的 DOM 重新提取 images 数组（用户可能删了图片）
      const newImages = Array.from(container.querySelectorAll('img'))
        .map(img => ({ src: img.src, alt: img.alt || '' }))
        .filter(img => img.src);
      
      // 提取新标题（用第一个段落/标题的前 100 字）
      let newTitle = selectedCardData?.title || '未命名卡片';
      const firstBlock = container.querySelector('p, h1, h2, h3, h4, h5, h6, blockquote');
      if (firstBlock) {
        const t = firstBlock.textContent.trim().substring(0, 100);
        if (t) newTitle = t;
      }
      
      // 保存到 DB（再次清洗，防止浏览器在 contenteditable 编辑中注入脏属性）
      const cleanedNewHTML = cleanInlineStyles(newHTML);
      const updates = {
        htmlContent: cleanedNewHTML,
        plainText: newPlainText,
        title: newTitle,
        images: newImages // ★ 更新图片数组
      };
      
      await QuoteBoxDB.updateCard(selectedCardId, updates);
      
      // ★★★ 立即同步内存中的 allCards —— 不依赖重新从 DB 拉取
      // 先更新内存里的 selectedCardData（详情面板自己用）
      selectedCardData = { ...selectedCardData, ...updates };
      // 再更新 allCards 里对应的条目（renderCards 直接用这个渲染卡片）
      const cardIdx = allCards.findIndex(c => c.id === selectedCardId);
      if (cardIdx !== -1) {
        allCards[cardIdx] = { ...allCards[cardIdx], ...updates };
      }
      
      // 退出编辑模式
      isEditMode = false;
      const c = contentEl.shadowRoot?.querySelector('div');
      if (c) c.removeAttribute('contenteditable');
      contentEl.classList.remove('editable');
      
      toggleEditBtn.style.display = 'flex';
      saveEditBtn.style.display = 'none';
      restoreEditBtn.style.display = 'none';
      originalSnapshot = null;
      
      // 同步更新详情面板的标题显示
      document.getElementById('detail-title').textContent = newTitle;
      
      showToast('✓ 修改已保存', 'success');
      // ★ 直接重渲染（allCards 已手动更新，不需要重新从 DB 拉）
      renderCards();
      updateSelectionUI();
    } catch (error) {
      console.error('保存编辑失败:', error);
      showToast('保存失败: ' + error.message, 'error');
    }
  }
  
  function restoreOriginalContent() {
    if (!originalSnapshot) return;
    
    const contentEl = document.getElementById('detail-content');
    const shadow = contentEl.shadowRoot;
    if (!shadow) return;
    
    // 重新渲染原始 HTML（再次走 cleanInlineStyles + 注入）
    const container = shadow.querySelector('div');
    if (container) {
      const cleaned = cleanInlineStyles(originalSnapshot.htmlContent);
      container.innerHTML = cleaned;
    }
    
    // ★ 更新 selectedCardData + allCards（图片数组也要恢复）
    if (selectedCardData) {
      selectedCardData.htmlContent = originalSnapshot.htmlContent;
      selectedCardData.plainText = originalSnapshot.plainText;
      selectedCardData.images = originalSnapshot.images;
    }
    const cardIdx = allCards.findIndex(c => c.id === selectedCardId);
    if (cardIdx !== -1) {
      allCards[cardIdx].htmlContent = originalSnapshot.htmlContent;
      allCards[cardIdx].plainText = originalSnapshot.plainText;
      allCards[cardIdx].images = originalSnapshot.images;
    }
    renderCards();
    
    showToast('↩ 已恢复原文', 'success');
  }
  
  // 复制文本
  document.getElementById('copy-content').addEventListener('click', async () => {
    if (!selectedCardData) return;
    try {
      await navigator.clipboard.writeText(selectedCardData.plainText || '');
      showToast('✓ 已复制到剪贴板', 'success');
    } catch {
      showToast('复制失败', 'error');
    }
  });
  
  // 删除单张（详情面板内）
  document.getElementById('delete-card').addEventListener('click', async () => {
    if (!selectedCardId) return;
    if (!confirm('确定要删除这张卡片吗？此操作不可撤销。')) return;
    try {
      await QuoteBoxDB.deleteCard(selectedCardId);
      selectedIds.delete(selectedCardId); // ★ 关键：从选中集合里清掉
      showToast('✓ 已删除', 'success');
      closeDetail();
      await loadCards();
      updateSelectionUI(); // ★ 同步更新顶部按钮状态
    } catch (error) { showToast('删除失败: ' + error.message, 'error'); }
  });
  
  // ★ 批量删除（多选后在顶部点）
  deleteSelectedBtn.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`确定要删除选中的 ${selectedIds.size} 张卡片吗？此操作不可撤销。`)) return;
    try {
      let count = 0;
      for (const id of selectedIds) {
        await QuoteBoxDB.deleteCard(id);
        count++;
      }
      selectedIds.clear();
      showToast(`✓ 已删除 ${count} 张`, 'success');
      await loadCards();
      updateSelectionUI();
    } catch (error) { showToast('批量删除失败: ' + error.message, 'error'); }
  });
  
  // ★ 排序切换
  sortSelect.addEventListener('change', (e) => {
    sortMode = e.target.value;
    renderCards();
  });
  
  // 备注自动保存
  let noteTimer = null;
  document.getElementById('detail-note').addEventListener('input', (e) => {
    if (!selectedCardId) return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      try { await QuoteBoxDB.updateCard(selectedCardId, { note: e.target.value }); }
      catch (error) { console.error('备注保存失败:', error); }
    }, 500);
  });
  
  // === 加载和渲染 ===
  async function loadCards() {
    try {
      allCards = await QuoteBoxDB.getAllCards();
      totalCount.textContent = allCards.length;
      renderCards();
    } catch (error) {
      console.error('[QuoteBox] 加载失败:', error);
      showToast('加载失败: ' + error.message, 'error');
    }
  }
  
  // 多选状态相关函数（变量已在顶部声明）
  
  function updateSelectionUI() {
    const count = selectedIds.size;
    const hasSelection = count > 0;
    
    exportSelectedBtn.style.display = hasSelection ? 'inline-flex' : 'none';
    deleteSelectedBtn.style.display = hasSelection ? 'inline-flex' : 'none';
    clearSelectionBtn.style.display = hasSelection ? 'inline-flex' : 'none';
    selectedCountSpan.textContent = count;
    deleteCountSpan.textContent = count;
    
    // 更新当前可见卡片的视觉状态
    document.querySelectorAll('.card').forEach(el => {
      if (selectedIds.has(el.dataset.id)) {
        el.classList.add('selected');
        const cb = el.querySelector('.card-check');
        if (cb) cb.checked = true;
      } else {
        el.classList.remove('selected');
        const cb = el.querySelector('.card-check');
        if (cb) cb.checked = false;
      }
    });
  }
  
  clearSelectionBtn.addEventListener('click', () => {
    selectedIds.clear();
    updateSelectionUI();
  });
  
  exportSelectedBtn.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    try {
      // 从 allCards 里筛选出选中的
      const selectedCards = allCards.filter(c => selectedIds.has(c.id));
      await triggerDownload(selectedCards);
      showToast(`✓ 已导出 ${selectedCards.length} 张卡片`, 'success');
      // 导出后取消选中（用户可能想换一批）
      selectedIds.clear();
      updateSelectionUI();
    } catch (error) {
      showToast('导出失败: ' + error.message, 'error');
    }
  });
  
  function renderCards() {
    let cards = [...allCards];
    
    if (currentView === 'recent') {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      cards = cards.filter(c => c.createdAt >= weekAgo);
    }
    
    const kw = searchInput.value.trim().toLowerCase();
    if (kw) {
      cards = cards.filter(c => 
        (c.title || '').toLowerCase().includes(kw) ||
        (c.plainText || '').toLowerCase().includes(kw) ||
        (c.note || '').toLowerCase().includes(kw)
      );
    }
    
    if (cards.length === 0) {
      cardsContainer.innerHTML = '';
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    
    // ★★★ 排序
    cards.sort((a, b) => {
      if (sortMode === 'time-asc') {
        return (a.createdAt || 0) - (b.createdAt || 0);
      } else { // time-desc
        return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });
    
    // 根据每张卡片的纯文本长度计算预览高度（自适应）
    cardsContainer.innerHTML = cards.map(card => {
      const previewHeight = calcPreviewHeight(card);
      const plainText = (card.plainText || '').trim();
      const firstImage = (card.images || []).find(img => img.src);
      const isSelected = selectedIds.has(card.id);
      
      return `
        <div class="card ${isSelected ? 'selected' : ''}" data-id="${card.id}">
          <!-- ★ 多选 checkbox -->
          <input type="checkbox" class="card-check" data-id="${card.id}" ${isSelected ? 'checked' : ''}>
          <div class="card-preview" style="height:${previewHeight}px">
            ${firstImage && card.images.length === 1 ? 
              `<div class="card-img-only"><img src="${firstImage.src}" alt=""></div>` :
              `<div class="card-text-preview">${escapeHtml(plainText) || '(空)'}</div>`
            }
          </div>
          <div class="card-info">
            <div class="card-title" title="${escapeHtml(card.title)}">${escapeHtml(card.title)}</div>
            <div class="card-meta">
              ${card.faviconUrl ? `<img class="favicon" src="${card.faviconUrl}" onerror="this.style.display='none'">` : ''}
              <span class="source-name" title="${escapeHtml(card.sourceTitle || card.sourceUrl || '')}">
                ${escapeHtml(card.sourceTitle || card.sourceUrl || '未知来源')}
              </span>
              <span>${formatDate(card.createdAt)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
    
    cardsContainer.querySelectorAll('.card').forEach(el => {
      // checkbox 点击 → 切换选中状态，不冒泡到 card
      const cb = el.querySelector('.card-check');
      cb?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateSelectionUI();
      });
      
      // card 整体点击 → 打开详情（但不包括 checkbox）
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('card-check')) return;
        openDetail(el.dataset.id);
      });
    });
  }
  
  // 根据纯文本长度计算卡片预览高度
  function calcPreviewHeight(card) {
    const len = (card.plainText || '').length;
    const imgCount = (card.images || []).length;
    
    if (imgCount === 1 && len < 20) return 200;   // 纯图片卡片
    if (len < 30) return 120;                     // 短文本
    if (len < 80) return 160;                     // 中等
    if (len < 200) return 200;                    // 较长
    return 240;                                    // 长文本（但预览区始终截断）
  }
  
  // === 详情面板 ===
  async function openDetail(cardId) {
    try {
      console.log('[QuoteBox] 打开详情:', cardId);
      const card = await QuoteBoxDB.getCard(cardId);
      if (!card) {
        showToast('卡片不存在', 'error');
        return;
      }
      
      selectedCardId = cardId;
      selectedCardData = card;
      
      document.getElementById('detail-title').textContent = card.title || '未命名卡片';
      
      // 来源
      const srcLink = document.getElementById('detail-source');
      const favicon = document.getElementById('detail-favicon');
      const srcText = document.getElementById('detail-source-text');
      if (card.sourceUrl) {
        srcLink.href = card.sourceUrl;
        srcText.textContent = card.sourceTitle || card.sourceUrl;
        srcLink.style.display = 'flex';
      } else {
        srcLink.style.display = 'none';
      }
      favicon.style.display = card.faviconUrl ? '' : 'none';
      if (card.faviconUrl) favicon.src = card.faviconUrl;
      
      document.getElementById('detail-date').textContent = '保存于 ' + formatFullDate(card.createdAt);
      
      // ★ 详情内容渲染：shadow DOM 样式隔离 + 双保险清洗 inline style
      const contentEl = document.getElementById('detail-content');
      contentEl.innerHTML = '';
      
      if (card.htmlContent) {
        if (contentEl.shadowRoot) {
          contentEl.shadowRoot.innerHTML = '';
        } else {
          contentEl.attachShadow({ mode: 'open' });
        }
        const shadow = contentEl.shadowRoot;
        
        // ★★★ 用 !important 强压所有危险 inline style（Shadow DOM 内 CSS 本身优先级低于 inline style）
        const style = document.createElement('style');
        style.textContent = `
          :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important; }
          :host > * { box-sizing: border-box; }
          /* ★ contenteditable 编辑模式的容器 —— 给光标留出 padding，outline 不覆盖内容 */
          div[contenteditable="true"] {
            padding: 4px 6px !important;
            outline: none !important;
            caret-color: #1f2937 !important;
            cursor: text !important;
          }
          /* ★ 全局重置所有 inline style 带过来的脏数据 */
          * {
            float: none !important;
            position: static !important;
            max-width: 100% !important;
            min-width: 0 !important;
            width: auto !important;
            height: auto !important;
            margin-left: 0 !important;
            margin-right: 0 !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
          }
          /* ★ 文本排版关键重置 —— 压掉原网页 inline style 的 line-height/font-size/margin */
          p, div, span, li, blockquote, h1, h2, h3, h4, h5, h6 {
            line-height: 1.8 !important;
            margin-top: 0 !important;
            margin-bottom: 12px !important;
            font-size: 14px !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
            font-weight: normal !important;
            color: #1f2937 !important;
            white-space: normal !important;
            word-break: break-word !important;
          }
          span { margin: 0 !important; font-size: inherit !important; }
          h1 { font-size: 22px !important; font-weight: 700 !important; margin: 16px 0 8px !important; line-height: 1.4 !important; }
          h2 { font-size: 18px !important; font-weight: 700 !important; margin: 16px 0 8px !important; line-height: 1.4 !important; }
          h3 { font-size: 16px !important; font-weight: 600 !important; margin: 14px 0 6px !important; line-height: 1.4 !important; }
          h4, h5, h6 { font-size: 14px !important; font-weight: 600 !important; margin: 12px 0 6px !important; }
          img { max-width: 100% !important; height: auto !important; border-radius: 6px; margin: 12px 0 !important; display: block !important; }
          blockquote { border-left: 3px solid #667eea; padding: 4px 16px !important; margin: 12px 0 !important; color: #6b7280 !important; }
          a { color: #667eea !important; text-decoration: underline !important; }
          pre { background: #f3f4f6; padding: 12px !important; border-radius: 8px; overflow-x: auto; font-size: 12px !important; margin: 12px 0 !important; }
          code { background: #f3f4f6; padding: 2px 6px !important; border-radius: 4px; font-size: 12px !important; margin: 0 !important; }
          ul, ol { padding-left: 24px !important; margin-bottom: 12px !important; }
          li { margin-bottom: 4px !important; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 12px !important; }
          th, td { border: 1px solid #e5e7eb; padding: 8px !important; text-align: left; margin: 0 !important; }
        `;
        shadow.appendChild(style);
        
        // ★ 先清洗原 HTML 里的危险 inline style（双保险）
        const cleanedHTML = cleanInlineStyles(card.htmlContent);
        const container = document.createElement('div');
        container.innerHTML = cleanedHTML;
        shadow.appendChild(container);
      } else {
        // 没有 htmlContent 就显示纯文本
        contentEl.innerHTML = `<p style="color:#9ca3af;white-space:pre-wrap">${escapeHtml(card.plainText || '无内容')}</p>`;
      }
      
      // 备注
      document.getElementById('detail-note').value = card.note || '';
      
      // 打开面板
      detailPanel.classList.add('open');
      overlay.style.display = 'block';
      
      console.log('[QuoteBox] ✓ 详情面板已打开');
    } catch (error) {
      console.error('[QuoteBox] openDetail 异常:', error);
      showToast('加载详情失败: ' + error.message, 'error');
    }
  }
  
  function closeDetail() {
    // ★ 关闭前如果在编辑模式，先退出并恢复原文（不保存）
    if (isEditMode) {
      toggleEditMode(false); // 退出编辑模式
    }
    
    detailPanel.classList.remove('open');
    overlay.style.display = 'none';
    selectedCardId = null;
    selectedCardData = null;
    originalSnapshot = null;
  }
  
  // ★★★ 危险 inline style 清洗 —— 移除会导致布局混乱的样式属性
  function cleanInlineStyles(htmlString) {
    if (!htmlString) return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div id="__qb_clean">${htmlString}</div>`, 'text/html');
      const wrapper = doc.getElementById('__qb_clean');
      
      // 允许保留的 style 属性（安全的、不影响布局的视觉属性）
      const ALLOWED_STYLES = new Set([
        'color', 'background-color',
        'font-weight', 'font-style',
        'text-align', 'text-decoration',
        'border', 'border-radius',
        'list-style-type'
      ]);
      
      // 需要移除的布局危险属性
      const DANGEROUS_STYLES = new Set([
        'line-height', 'font-size', 'font-family',
        'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
        'position', 'top', 'bottom', 'left', 'right',
        'float', 'clear',
        'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
        'display', 'overflow',
        'transform', 'z-index',
        'letter-spacing', 'word-spacing',
        'text-indent', 'line-clamp',
        'white-space', 'word-break',
        'vertical-align'
      ]);
      
      wrapper.querySelectorAll('*').forEach(el => {
        const style = el.getAttribute('style');
        if (!style) return;
        
        // 解析 style 字符串，只保留安全属性
        const parts = style.split(';');
        const safeParts = [];
        
        parts.forEach(part => {
          const trimmed = part.trim();
          if (!trimmed) return;
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx === -1) return;
          const prop = trimmed.substring(0, colonIdx).trim().toLowerCase();
          const val = trimmed.substring(colonIdx + 1).trim();
          
          if (DANGEROUS_STYLES.has(prop)) {
            // 危险属性直接丢弃
            return;
          } else if (ALLOWED_STYLES.has(prop) || !DANGEROUS_STYLES.has(prop)) {
            // 安全属性保留
            safeParts.push(`${prop}: ${val}`);
          }
        });
        
        if (safeParts.length > 0) {
          el.setAttribute('style', safeParts.join('; '));
        } else {
          el.removeAttribute('style');
        }
        
        // 也移除 class 和 id
        el.removeAttribute('class');
        el.removeAttribute('id');
      });
      
      return wrapper.innerHTML;
    } catch (e) {
      console.warn('[QuoteBox] cleanInlineStyles 失败，返回原 HTML:', e.message);
      return htmlString; // 清洗失败就退回原 HTML（Shadow DOM !important 还能兜底）
    }
  }
  
  // === 工具 ===
  function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + (type || '');
    toast.style.display = 'block';
    setTimeout(() => toast.style.display = 'none', 2500);
  }
  
  function formatDate(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff/60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff/86400000)}天前`;
    const d = new Date(ts);
    return `${d.getMonth()+1}/${d.getDate()}`;
  }
  
  function formatFullDate(ts) {
    return new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
  
  // ★ 公共导出函数（全部 / 选中都走这个）
  function triggerDownload(cards) {
    return new Promise((resolve) => {
      const exportData = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        cards: cards
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quotebox-export-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
      resolve();
    });
  }
  
  console.log('[QuoteBox] Manager page loaded ✓');
});
