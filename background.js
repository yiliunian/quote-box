// Background Service Worker - 唯一的 IndexedDB 存储中心
// content script 只负责捕获和图片下载，然后 sendMessage 过来
// background 和 popup/manager 都在扩展 origin 下，共享同一个 IndexedDB
importScripts('db.js');

console.log('[QuoteBox] Background 启动, QuoteBoxDB 存在:', typeof QuoteBoxDB !== 'undefined');

// 安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'quotebox-save-selection',
    title: '保存选中内容到 QuoteBox',
    contexts: ['selection', 'image', 'link']
  });
  
  chrome.contextMenus.create({
    id: 'quotebox-open-manager',
    title: '打开 QuoteBox 管理页面',
    contexts: ['action']
  });
});

// 右键菜单点击 → 让 content script 捕获处理 → 处理完会 sendMessage 回来
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'quotebox-save-selection') {
    chrome.tabs.sendMessage(tab.id, { action: 'saveSelectionFromContextMenu' });
  } else if (info.menuItemId === 'quotebox-open-manager') {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
  }
});

// === 统一的消息路由 ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request.action;
  
  // 所有需要操作 IndexedDB 的请求都走这里
  if (action === 'saveCard') {
    handleSaveCard(request.data, sendResponse);
    return true; // 异步保持通道
    
  } else if (action === 'openManager') {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
    sendResponse({ success: true });
    
  } else {
    sendResponse({ error: '未知 action: ' + action });
  }
});

// === 实际存储 ===
async function handleSaveCard(data, sendResponse) {
  try {
    if (typeof QuoteBoxDB === 'undefined') {
      throw new Error('QuoteBoxDB 未定义');
    }
    
    const card = await QuoteBoxDB.addCard(data);
    console.log('[QuoteBox Background] ✓ 卡片已存入扩展 IndexedDB, id:', card.id);
    sendResponse({ success: true, card });
  } catch (err) {
    console.error('[QuoteBox Background] ✗ 存储失败:', err);
    sendResponse({ success: false, error: err.message });
  }
}
