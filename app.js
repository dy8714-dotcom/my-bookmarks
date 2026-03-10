/**
 * マイブックマーク - IndexedDB 対応版 (超安定・最終修正版)
 * * 【修正内容】
 * 1. 白い画面（起動不能）を回避するため、エラーが起きても強制的に画面を表示する仕組みを導入。
 * 2. データ移行時の JSON 解析エラーを無視するようにし、壊れたデータがあっても起動を妨げないように改善。
 * 3. 画面部品（ID）が見つからなくても、他の機能が動き続けるようにガードを強化。
 */

// --- データベース管理クラス (IndexedDB) ---
class DBManager {
    constructor() {
        // データベース名を以前のものと変えて、クリーンな状態で開始します
        this.dbName = 'MyBookmarkAppDB_Final_Stable';
        this.version = 1;
        this.storeName = 'bookmarks_store';
        this.db = null;
    }

    async open() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.dbName, this.version);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        db.createObjectStore(this.storeName);
                    }
                };
                request.onsuccess = (e) => {
                    this.db = e.target.result;
                    resolve(this.db);
                };
                request.onerror = (e) => {
                    console.error('DB Open Error:', e);
                    reject('IndexedDB 起動エラー');
                };
            } catch (err) {
                reject(err);
            }
        });
    }

    async set(key, value) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.put(value, key);
                request.onsuccess = () => resolve();
                request.onerror = () => reject('保存失敗');
            });
        } catch (e) { console.error(e); }
    }

    async get(key) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject('取得失敗');
            });
        } catch (e) { return null; }
    }

    async migrateFromLocalStorage() {
        try {
            const isMigrated = await this.get('__migration_complete');
            if (isMigrated) return;

            console.log('古いデータを確認中...');
            let count = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.startsWith('auth_') || key.startsWith('bookmarkData_') || key.startsWith('DAILY24_')) {
                    try {
                        const raw = localStorage.getItem(key);
                        if (raw) {
                            const value = JSON.parse(raw);
                            await this.set(key, value);
                            count++;
                        }
                    } catch (e) {
                        // JSONが壊れているデータはスキップして次へ進む
                        console.warn('移行スキップ:', key);
                    }
                }
            }
            await this.set('__migration_complete', true);
            if (count > 0) console.log(`${count}件のデータを移行しました。`);
        } catch (err) {
            console.error('移行処理でエラーが発生しましたが、起動を続行します。', err);
        }
    }
}

const db = new DBManager();

// --- 認証マネージャー ---
class SimpleAuthManager {
    constructor() { this.currentUser = null; }

    async hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    generateUserId(username) {
        return 'user_' + username.toLowerCase().replace(/[^a-z0-9]/g, '_');
    }

    async register(username, password) {
        if (!username || !password) throw new Error('ユーザー名とパスワードを入力してください');
        const userId = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);
        const existingUser = await db.get(`auth_${userId}`);
        if (existingUser) throw new Error('このユーザー名は既に使用されています');
        await db.set(`auth_${userId}`, { username, passwordHash, createdAt: Date.now() });
        return true;
    }

    async login(username, password) {
        const userId = this.generateUserId(username);
        const userData = await db.get(`auth_${userId}`);
        if (!userData) throw new Error('ユーザーが見つかりません');
        const passwordHash = await this.hashPassword(password);
        if (userData.passwordHash !== passwordHash) throw new Error('パスワードが正しくありません');
        this.currentUser = { userId, username };
        return this.currentUser;
    }

    logout() { this.currentUser = null; }
}

// --- ブックマークマネージャー ---
class BookmarkManager {
    constructor() { this.userId = null; this.data = { categories: [] }; }

    async setUserId(userId) { this.userId = userId; await this.loadData(); }

    async loadData() {
        if (!this.userId) return;
        const savedData = await db.get(`bookmarkData_${this.userId}`);
        this.data = savedData || { categories: [] };
        if (!this.data || !this.data.categories) this.data = { categories: [] };
    }

    async saveData() {
        if (!this.userId) return;
        await db.set(`bookmarkData_${this.userId}`, this.data);
    }

    getCategories() { return this.data.categories || []; }

    async addCategory(name) {
        const newCategory = { id: 'cat_' + Date.now(), name, bookmarks: [] };
        this.data.categories.push(newCategory);
        await this.saveData();
        return newCategory;
    }

    async updateCategory(categoryId, name) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) { category.name = name; await this.saveData(); }
    }

    async deleteCategory(categoryId) {
        this.data.categories = this.data.categories.filter(c => c.id !== categoryId);
        await this.saveData();
    }

    async addBookmark(categoryId, name, url, description) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            if (!category.bookmarks) category.bookmarks = [];
            category.bookmarks.push({ id: 'bm_' + Date.now(), name, url, description, createdAt: Date.now() });
            await this.saveData();
        }
    }

    async updateBookmark(categoryId, bookmarkId, name, url, description) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            const bookmark = category.bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) { Object.assign(bookmark, { name, url, description }); await this.saveData(); }
        }
    }

    async deleteBookmark(categoryId, bookmarkId) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            category.bookmarks = category.bookmarks.filter(b => b.id !== bookmarkId);
            await this.saveData();
        }
    }

    exportData() { return JSON.stringify(this.data); }

    async importData(jsonData) {
        if (jsonData && Array.isArray(jsonData.categories)) {
            this.data = jsonData;
            await this.saveData();
            return true;
        }
        return false;
    }
}

// --- UI マネージャー ---
class UIManager {
    constructor(authManager, bookmarkManager) {
        this.auth = authManager;
        this.manager = bookmarkManager;
        this.currentCategoryId = null;
        this.currentBookmarkId = null;

        this.initEventListeners();
        this.ensureInitialView();
    }

    // 画面が真っ白になるのを防ぐため、初期状態を強制する
    ensureInitialView() {
        const loginScreen = document.getElementById('loginScreen');
        const mainScreen = document.getElementById('mainScreen');
        if (loginScreen) loginScreen.style.display = 'block';
        if (mainScreen) mainScreen.style.display = 'none';
    }

    safeStyle(id, prop, value) {
        const el = document.getElementById(id);
        if (el) el.style[prop] = value;
    }

    initEventListeners() {
        const bindClick = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onclick = fn;
        };

        bindClick('showRegisterBtn', () => {
            this.safeStyle('loginForm', 'display', 'none');
            this.safeStyle('registerForm', '