// Content Script - 只做"捕获+图片下载+样式提取"，不直接存 IndexedDB
// db.js 在 content script 里也加载了，但我们不用它存 —— 因为 origin 不对
// 处理完的数据统一 sendMessage 给 background 存
(function() {
  'use strict';
  
  console.log('[QuoteBox] Content script 启动');
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      switch (request.action) {
        case 'getSelection':
          sendResponse(captureSelection());
          break;
          
        case 'getPageInfo':
          sendResponse({
            url: window.location.href,
            title: document.title,
            favicon: getFaviconUrl()
          });
          break;
          
        case 'saveSelectionFromContextMenu':
        case 'saveSelectionDirect':
          saveAndForward().then(success => {
            try { sendResponse({ success }); } catch(e) {}
          }).catch(err => {
            console.error('[QuoteBox] 未捕获错误:', err);
            try { sendResponse({ success: false, error: err.message }); } catch(e) {}
          });
          break;
          
        default:
          sendResponse({ error: '未知 action: ' + request.action });
      }
    } catch (err) {
      console.error('[QuoteBox] 消息处理异常:', err);
      try { sendResponse({ error: err.message }); } catch(e) {}
    }
    return true;
  });
  
  // === 核心：捕获 + 处理图片 + 转发给 background ===
  async function saveAndForward() {
    const selectionData = captureSelection();
    if (!selectionData.hasContent) {
      showToast('请先选中要保存的内容', true);
      return false;
    }
    
    console.log('[QuoteBox] 捕获到:', selectionData.title, '文本长度:', selectionData.plainText.length);
    
    try {
      // 把远程图片下载为 base64（必须在页面上下文中做，fetch 更可靠）
      const processedHTML = await replaceImagesWithBase64(selectionData.htmlContent);
      
      // 发送给 background 存储（background 和 popup/manager 在同一个 origin 下）
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'saveCard',
          data: {
            title: selectionData.title,
            htmlContent: processedHTML,
            plainText: selectionData.plainText,
            images: selectionData.images,
            sourceUrl: window.location.href,
            sourceTitle: document.title,
            faviconUrl: getFaviconUrl()
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || {});
          }
        });
      });
      
      if (result && result.success) {
        console.log('[QuoteBox] ✓ 保存成功, card id:', result.card?.id || '(无id)');
        showToast('✓ 已保存到 QuoteBox');
        return true;
      } else {
        showToast('✗ 保存失败: ' + (result?.error || '未知错误'), true);
        return false;
      }
    } catch (error) {
      console.error('[QuoteBox] ✗ saveAndForward 异常:', error);
      showToast('✗ 保存失败: ' + error.message, true);
      return false;
    }
  }
  
  // === 图片处理 ===
  async function replaceImagesWithBase64(htmlString) {
    if (!htmlString) return '';
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="__qb_wrap">${htmlString}</div>`, 'text/html');
    const wrapper = doc.getElementById('__qb_wrap');
    const imgElements = wrapper.querySelectorAll('img[data-quotebox-src]');
    
    if (imgElements.length === 0) return wrapper.innerHTML;
    
    console.log('[QuoteBox] 需要下载的图片数:', imgElements.length);
    
    await Promise.all(Array.from(imgElements).map(async (img) => {
      const remoteSrc = img.getAttribute('data-quotebox-src');
      try {
        const base64 = await downloadImageAsBase64(remoteSrc);
        if (base64) img.setAttribute('src', base64);
      } catch (e) {
        console.warn('[QuoteBox] 图片下载失败:', remoteSrc, e.message);
      }
      img.removeAttribute('data-quotebox-src');
    }));
    
    return wrapper.innerHTML;
  }
  
  function downloadImageAsBase64(url) {
    return new Promise((resolve) => {
      fetch(url, { mode: 'cors', credentials: 'omit' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(blob => blobToBase64(blob))
        .then(b64 => resolve(b64))
        .catch(() => {
          loadImageViaCanvas(url).then(resolve).catch(() => resolve(null));
        });
    });
  }
  
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  
  function loadImageViaCanvas(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let done = false;
      const finish = (fn, val) => { if (!done) { done = true; fn(val); } };
      
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const MAX = 2048;
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX || h > MAX) {
            const ratio = Math.min(MAX / w, MAX / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          finish(resolve, canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) { finish(reject, e); }
      };
      img.onerror = () => finish(reject, new Error('图片加载失败'));
      img.src = url;
      setTimeout(() => finish(reject, new Error('超时')), 8000);
    });
  }
  
  // === 选中捕获 ===
  function captureSelection() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return { hasContent: false };
      }
      
      const range = selection.getRangeAt(0);
      const clonedFragment = range.cloneContents();
      
      // ★ 临时挂到 body 上，getComputedStyle 才能可靠工作
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:-9999px;';
      wrapper.appendChild(clonedFragment);
      document.body.appendChild(wrapper);
      
      const plainText = selection.toString().trim();
      
      const images = [];
      wrapper.querySelectorAll('img').forEach((img) => {
        const src = img.src;
        if (src && !src.startsWith('data:')) {
          img.setAttribute('data-quotebox-src', src);
        }
        images.push({ src, alt: img.alt || '' });
      });
      
      let title = '';
      const firstParagraph = wrapper.querySelector('p, h1, h2, h3, h4, h5, h6, blockquote');
      if (firstParagraph) title = firstParagraph.textContent.trim().substring(0, 100);
      if (!title && plainText) title = plainText.substring(0, 100);
      if (!title) title = '未命名卡片';
      
      const htmlContent = extractStyledHTML(wrapper);
      document.body.removeChild(wrapper);
      
      return { hasContent: true, title, htmlContent, plainText, images };
    } catch (err) {
      console.error('[QuoteBox] captureSelection 异常:', err);
      return { hasContent: false, error: err.message };
    }
  }
  
  function extractStyledHTML(wrapper) {
    const styleProps = [
      'font-family', 'font-size', 'font-weight', 'font-style',
      'color', 'background-color',
      'text-align', 'text-decoration', 'line-height',
      'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
      'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
      'border', 'border-radius',
      'width', 'height', 'max-width', 'max-height',
      'display', 'float', 'list-style-type'
    ];
    
    wrapper.querySelectorAll('*').forEach((el) => {
      if (el.nodeType !== 1) return;
      try {
        const cs = window.getComputedStyle(el);
        const inlineStyles = [];
        styleProps.forEach((prop) => {
          let value = '';
          try { value = cs.getPropertyValue(prop); } catch(e) {}
          if (value && value !== 'none' && value !== 'normal' && value !== '0px' && value !== '0') {
            inlineStyles.push(`${prop}: ${value}`);
          }
        });
        if (inlineStyles.length > 0) {
          const existingStyle = el.getAttribute('style') || '';
          el.setAttribute('style', (existingStyle ? existingStyle + ';' : '') + inlineStyles.join(';'));
        }
      } catch (e) {}
      el.removeAttribute('id');
      el.removeAttribute('class');
    });
    
    return wrapper.innerHTML;
  }
  
  function getFaviconUrl() {
    try {
      const link = document.querySelector("link[rel~='icon']") || 
                   document.querySelector("link[rel~='shortcut icon']");
      if (link) return link.href;
      return new URL('/favicon.ico', window.location.origin).href;
    } catch (e) { return ''; }
  }
  
  function showToast(message, isError) {
    try {
      document.getElementById('quotebox-toast')?.remove();
      const toast = document.createElement('div');
      toast.id = 'quotebox-toast';
      toast.textContent = message;
      toast.style.cssText = `
        position:fixed;top:20px;right:20px;z-index:2147483647;
        padding:12px 24px;border-radius:8px;font-size:14px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        color:white;background:${isError ? '#ef4444' : '#10b981'};
        box-shadow:0 4px 12px rgba(0,0,0,0.15);
        animation:__qb_slide_in .3s ease-out;
      `;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = '__qb_fade_out .3s ease-out forwards';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    } catch (e) {}
  }
  
  console.log('[QuoteBox] Content script 加载完成 ✓');
})();
