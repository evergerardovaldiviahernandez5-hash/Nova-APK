(() => {
  'use strict';

  const DB_NAME = 'nova-local-v1';
  const DB_VERSION = 1;

  class NovaLocalStore {
    constructor() {
      this.db = null;
    }

    async open() {
      if (this.db) return this.db;
      if (!('indexedDB' in window)) throw new Error('Este WebView no dispone de IndexedDB.');
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('conversations')) {
            const store = db.createObjectStore('conversations', { keyPath: 'id' });
            store.createIndex('updatedAt', 'updatedAt');
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('No se pudo abrir el archivo local.'));
        request.onblocked = () => reject(new Error('El archivo local está bloqueado por otra pestaña.'));
      });
      return this.db;
    }

    async transaction(storeName, mode, operation) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let request;
        try { request = operation(store); } catch (error) { reject(error); return; }
        let result;
        if (request) request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('Error de almacenamiento local.'));
        tx.onabort = () => reject(tx.error || new Error('Operación local cancelada.'));
      });
    }

    async listConversations() {
      const items = await this.transaction('conversations', 'readonly', store => store.getAll()) || [];
      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getConversation(id) {
      return this.transaction('conversations', 'readonly', store => store.get(id));
    }

    saveConversation(conversation) {
      return this.transaction('conversations', 'readwrite', store => store.put(conversation));
    }

    deleteConversation(id) {
      return this.transaction('conversations', 'readwrite', store => store.delete(id));
    }

    async getSetting(key, fallback = null) {
      const row = await this.transaction('settings', 'readonly', store => store.get(key));
      return row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : fallback;
    }

    setSetting(key, value) {
      return this.transaction('settings', 'readwrite', store => store.put({ key, value }));
    }
  }

  window.novaId = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  };
  window.NovaStore = new NovaLocalStore();
})();
