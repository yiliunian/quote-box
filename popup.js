// Popup 脚本 - 直接操作 IndexedDB
document.addEventListener('DOMContentLoaded', async () => {
  // 等待 db.js 加载完成
  await waitForDB();
  
  // DOM 元素
  const saveSelectionBtn = document.getElementById('save-selection');
  const selectionHint = document.getElementById('selection-hint');
  const openManagerBtn = document.getElementById('open-manager');
  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const importFile = document.getElementById('import-file');
  const cardCountEl = document.getElementById('card-count');
  const recentCountEl = document.getElementById('recent-count');
  const recentList = document.getElementById('recent-list');
  const statusMessage = document.getElementById('status-message');
  
  let currentSelection = null;
  
  // 等待 db.js 加载
  function waitForDB() {
    return new Promise((resolve) => {
      if (window.QuoteBoxDB) {
        resolve();
        return;
      }
      const check = () => {
        if (window.QuoteBoxDB) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }
  
  // 检查当前页面是否有选中内容
  async function checkSelection() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        saveSelectionBtn.disabled = true;
        selectionHint.textContent = '无法获取页面信息';
        return;
      }
      
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
        saveSelectionBtn.disabled = true;
        selectionHint.textContent = '此页面不支持保存';
        return;
      }
      
      currentSelection = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'getSelection' }, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      });
      
      if (currentSelection && currentSelection.hasContent) {
        saveSelectionBtn.disabled = false;
        const shortTitle = currentSelection.title.substring(0, 25);
        saveSelectionBtn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          保存: "${shortTitle}..."
        `;
        selectionHint.textContent = '已检测到选中内容，点击保存';
      } else {
        saveSelectionBtn.disabled = false;
        selectionHint.textContent = '请先在页面上选中要保存的文字或图片';
      }
    } catch (error) {
      console.error('检查选中内容失败:', error);
    }
  }
  
  // 保存选中内容 - 让 content script 在页面上下文中直接保存（它处理图片下载）
  saveSelectionBtn.addEventListener('click', async () => {
    saveSelectionBtn.disabled = true;
    const originalHTML = saveSelectionBtn.innerHTML;
    saveSelectionBtn.textContent = '保存中...';
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        showStatus('无法获取页面', 'error');
        return;
      }
      
      // 让 content script 捕获并直接保存到 IndexedDB
      const result = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'saveSelectionDirect' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false });
          } else {
            resolve(response || {});
          }
        });
      });
      
      if (result.success) {
        showStatus('✓ 已保存到 QuoteBox', 'success');
        await loadStats();
        await loadRecentCards();
        await checkSelection();
      } else {
        showStatus('✗ 保存失败', 'error');
      }
    } catch (error) {
      console.error('保存失败:', error);
      showStatus('保存失败: ' + error.message, 'error');
    } finally {
      saveSelectionBtn.disabled = false;
      saveSelectionBtn.innerHTML = originalHTML;
    }
  });
  
  // 打开管理页面
  openManagerBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openManager' });
  });
  
  // 导出全部 - 直接操作 IndexedDB
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    const originalHTML = exportBtn.innerHTML;
    exportBtn.textContent = '导出中...';
    
    try {
      const cards = await window.QuoteBoxDB.getAllCards();
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
      URL.revokeObjectURL(url);
      
      showStatus(`✓ 已导出 ${cards.length} 张卡片`, 'success');
    } catch (error) {
      showStatus('导出失败: ' + error.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = originalHTML;
    }
  });
  
  // 导入（只新增、不覆盖、自动去重）
  importBtn.addEventListener('click', () => importFile.click());
  
  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const cards = data.cards || data;
      
      if (!Array.isArray(cards)) {
        throw new Error('文件格式不正确');
      }
      
      const result = await window.QuoteBoxDB.importCardsAddOnly(cards);
      showStatus(`✓ 成功导入 ${result.added} 张卡片`, 'success');
      await loadStats();
      await loadRecentCards();
    } catch (error) {
      showStatus('导入失败: ' + error.message, 'error');
    } finally {
      importFile.value = '';
    }
  });
  
  // 加载统计数据
  async function loadStats() {
    try {
      const cards = await window.QuoteBoxDB.getAllCards();
      cardCountEl.textContent = cards.length;
      
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recent = cards.filter(c => c.createdAt >= weekAgo);
      recentCountEl.textContent = recent.length;
    } catch (error) {
      console.error('加载统计失败:', error);
    }
  }
  
  // 加载最近卡片
  async function loadRecentCards() {
    try {
      const cards = (await window.QuoteBoxDB.getAllCards()).slice(0, 5);
      
      if (cards.length === 0) {
        recentList.innerHTML = '<div class="empty-hint">暂无卡片</div>';
        return;
      }
      
      recentList.innerHTML = cards.map(card => `
        <div class="recent-item" data-id="${card.id}">
          <div class="recent-favicon">
            ${card.faviconUrl ? `<img src="${card.faviconUrl}" onerror="this.style.display='none'">` : ''}
          </div>
          <span class="recent-title" title="${escapeHtml(card.title)}">${escapeHtml(card.title)}</span>
          <span class="recent-time">${formatTime(card.createdAt)}</span>
        </div>
      `).join('');
      
      recentList.querySelectorAll('.recent-item').forEach(item => {
        item.addEventListener('click', () => {
          chrome.runtime.sendMessage({ action: 'openManager' });
        });
      });
    } catch (error) {
      console.error('加载最近卡片失败:', error);
    }
  }
  
  // 显示状态提示
  function showStatus(message, type = 'success') {
    statusMessage.textContent = message;
    statusMessage.className = 'status-message ' + type;
    statusMessage.style.display = 'block';
    
    setTimeout(() => {
      statusMessage.style.display = 'none';
    }, 2500);
  }
  
  function formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }
  
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
  
  // 初始化
  await checkSelection();
  await loadStats();
  await loadRecentCards();
});
