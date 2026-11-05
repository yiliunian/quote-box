// IndexedDB 存储封装 - 用于存储卡片数据和图片
const DB_NAME = 'QuoteBoxDB';
const DB_VERSION = 1;
const STORE_NAME = 'cards';

let dbInstance = null;

// 打开/创建数据库
function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }
    
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('sourceUrl', 'sourceUrl', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
    };
    
    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };
    
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

async function addCard(cardData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    const card = {
      id: generateId(),
      title: cardData.title || '未命名卡片',
      htmlContent: cardData.htmlContent || '',
      plainText: cardData.plainText || '',
      images: cardData.images || [],
      sourceUrl: cardData.sourceUrl || '',
      sourceTitle: cardData.sourceTitle || '',
      faviconUrl: cardData.faviconUrl || '',
      note: cardData.note || '',
      createdAt: Date.now(),
      tags: cardData.tags || []
    };
    
    const request = store.add(card);
    request.onsuccess = () => resolve(card);
    request.onerror = () => reject(request.error);
  });
}

async function getAllCards() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = () => {
      const cards = request.result || [];
      cards.sort((a, b) => b.createdAt - a.createdAt);
      resolve(cards);
    };
    request.onerror = () => reject(request.error);
  });
}

async function getCard(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateCard(id, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const card = request.result;
      if (!card) { reject(new Error('卡片不存在')); return; }
      const updated = { ...card, ...updates, id };
      const putRequest = store.put(updated);
      putRequest.onsuccess = () => resolve(updated);
      putRequest.onerror = () => reject(putRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function deleteCard(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function bulkAddCards(cards) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let added = 0;
    for (const card of cards) {
      if (!card.id) card.id = generateId();
      if (!card.createdAt) card.createdAt = Date.now();
      store.put(card);
      added++;
    }
    tx.oncomplete = () => resolve(added);
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllCards() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 导入卡片 —— 只新增，绝不覆盖，不去重
 * 任何导入的卡片都会生成新 id 写入，即使内容完全一样也会保留
 * 用户手动删除重复数据
 * @param {Array} cards 要导入的卡片数组
 * @returns {{added: number, total: number}}
 */
async function importCardsAddOnly(cards) {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    let added = 0;
    for (const card of cards) {
      // ★ 永远生成新 id，保证不会覆盖任何已有卡片
      const newId = generateId();
      const toAdd = { ...card, id: newId };
      if (!toAdd.createdAt) toAdd.createdAt = Date.now();
      store.add(toAdd); // add 不会覆盖，key 重复会抛错（但我们生成了新 id，所以不会）
      added++;
    }
    
    tx.oncomplete = () => resolve({ added, total: cards.length });
    tx.onerror = () => reject(tx.error);
  });
}

async function searchCards(keyword) {
  const allCards = await getAllCards();
  const lowerKeyword = keyword.toLowerCase();
  return allCards.filter(card => 
    (card.title || '').toLowerCase().includes(lowerKeyword) ||
    (card.plainText || '').toLowerCase().includes(lowerKeyword) ||
    (card.note || '').toLowerCase().includes(lowerKeyword)
  );
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ====== 关键修复：同时用 var 声明全局变量 + 挂到 globalThis ======
// var 声明在顶层会成为全局对象的可枚举属性，content.js 中可以直接用 QuoteBoxDB.xxx
// const/let 不会挂到全局对象上，必须显式赋值
var QuoteBoxDB = {
  openDB,
  addCard,
  getAllCards,
  getCard,
  updateCard,
  deleteCard,
  bulkAddCards,
  clearAllCards,
  importCardsAddOnly,
  searchCards,
  blobToBase64
};

// 同时挂到 globalThis 作为保险
(function(g) {
  g.QuoteBoxDB = QuoteBoxDB;
})(typeof globalThis !== 'undefined' ? globalThis : 
   typeof self !== 'undefined' ? self : 
   typeof window !== 'undefined' ? window : this);
