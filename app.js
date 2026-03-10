/**
 * マイブックマーク - IndexedDB 対応版 (安定性向上・エラー修正版)
 * * 【修正内容】
 * 1. エラー "Cannot read properties of null (reading 'style')" を回避する安全装置を追加。
 * 2. 保存先を IndexedDB へ変更（5MB制限の撤廃）。
 * 3. 起動時の自動データ移行機能を維持。
 */

// --- データベース管理クラス (IndexedDB) ---
class DBManager {
    constructor() {
        this.dbName = 'MyBookmarkAppDB_V3_Stable';
        this.version = 1;
        this.storeName = 'bookmarks_store';
        this.db = null;
    }

    async open() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
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
            request.onerror = () => reject('IndexedDB の起動に失敗しました。');
        });
    }

    async set(key, value) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject('データの保存に失敗しました');
        });
    }

    async get(key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject('データの取得に失敗しました');
        });
    }

    async migrateFromLocalStorage() {
        const isMigrated = await this.get('__migration_complete');
        if (isMigrated) return;

        console.log('古い保存領域からデータを移行しています...');
        let count = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('auth_') || key.startsWith('bookmarkData_') || key.startsWith('DAILY24_')) {
                try {
                    const value = JSON.parse(localStorage.getItem(key));
                    await this.set(key, value);
                    count++;
                } catch (e) {
                    console.error('移行エラー:', key);
                }
            }
        }
        await this.set('__migration_complete', true);
        if (count > 0) console.log(`${count}件のデータを移行しました。`);
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
        if (!this.data.categories) this.data.categories = [];
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

// --- UI マネージャー (エラー対策強化版) ---
class UIManager {
    constructor(authManager, bookmarkManager) {
        this.auth = authManager;
        this.manager = bookmarkManager;
        this.currentCategoryId = null;
        this.currentBookmarkId = null;

        // 全ての要素を安全に取得
        this.els = {
            loginScreen: document.getElementById('loginScreen'),
            mainScreen: document.getElementById('mainScreen'),
            loginForm: document.getElementById('loginForm'),
            registerForm: document.getElementById('registerForm'),
            categoryList: document.getElementById('categoryList'),
            categoryModal: document.getElementById('categoryModal'),
            bookmarkModal: document.getElementById('bookmarkModal'),
            importModal: document.getElementById('importModal')
        };

        this.initEventListeners();
    }

    // 要素が存在するか確認してから操作する安全関数
    safeStyle(id, prop, value) {
        const el = document.getElementById(id) || this.els[id];
        if (el) {
            el.style[prop] = value;
        } else {
            console.warn(`要素が見つかりません: ${id}`);
        }
    }

    initEventListeners() {
        const bindClick = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onclick = fn;
            else console.warn(`ボタンが見つかりません: ${id}`);
        };

        // ログイン・登録画面切り替え
        bindClick('showRegisterBtn', () => {
            this.safeStyle('loginForm', 'display', 'none');
            this.safeStyle('registerForm', 'display', 'block');
        });
        bindClick('showLoginBtn', () => {
            this.safeStyle('registerForm', 'display', 'none');
            this.safeStyle('loginForm', 'display', 'block');
        });

        // 登録・ログイン・ログアウト
        bindClick('registerBtn', async () => {
            const user = document.getElementById('registerUsername')?.value;
            const pass = document.getElementById('registerPassword')?.value;
            const confirm = document.getElementById('registerConfirmPassword')?.value;
            if (pass !== confirm) { alert('パスワードが一致しません'); return; }
            try {
                await this.auth.register(user, pass);
                alert('登録完了！ログインしてください。');
                document.getElementById('showLoginBtn')?.click();
            } catch (e) { alert(e.message); }
        });

        bindClick('loginBtn', async () => {
            const user = document.getElementById('loginUsername')?.value;
            const pass = document.getElementById('loginPassword')?.value;
            try {
                const userData = await this.auth.login(user, pass);
                await this.manager.setUserId(userData.userId);
                this.showMainScreen(userData.username);
            } catch (e) { alert(e.message); }
        });

        bindClick('logoutBtn', () => { this.auth.logout(); location.reload(); });

        // カテゴリ・ブックマーク操作
        bindClick('addCategoryBtn', () => this.openCategoryModal());
        bindClick('saveCategoryBtn', async () => {
            const name = document.getElementById('categoryNameInput')?.value.trim();
            if (!name) return;
            if (this.currentCategoryId) await this.manager.updateCategory(this.currentCategoryId, name);
            else await this.manager.addCategory(name);
            this.closeAllModals(); this.renderCategories();
        });

        bindClick('saveBookmarkBtn', async () => {
            const name = document.getElementById('bookmarkNameInput')?.value.trim();
            let url = document.getElementById('bookmarkUrlInput')?.value.trim();
            const desc = document.getElementById('bookmarkDescInput')?.value.trim();
            if (!name || !url) { alert('サイト名とURLを入力してください'); return; }
            if (!url.startsWith('http')) url = 'https://' + url;
            if (this.currentBookmarkId) await this.manager.updateBookmark(this.currentCategoryId, this.currentBookmarkId, name, url, desc);
            else await this.manager.addBookmark(this.currentCategoryId, name, url, desc);
            this.closeAllModals(); this.renderCategories();
        });

        // インポート・エクスポート
        bindClick('exportBtn', () => {
            const data = this.manager.exportData();
            const blob = new Blob([data], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `bookmarks_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
        });

        bindClick('importBtn', () => this.els.importModal?.classList.add('active'));
        bindClick('confirmImportBtn', async () => {
            const file = document.getElementById('importFileInput')?.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (await this.manager.importData(data)) {
                        alert('インポート完了！');
                        this.closeAllModals(); this.renderCategories();
                    }
                } catch (err) { alert('形式が正しくありません'); }
            };
            reader.readAsText(file);
        });

        document.querySelectorAll('.close, .cancel').forEach(btn => {
            btn.onclick = () => this.closeAllModals();
        });
    }

    showMainScreen(username) {
        this.safeStyle('loginScreen', 'display', 'none');
        this.safeStyle('mainScreen', 'display', 'block');
        const userDisplay = document.getElementById('displayUsername');
        if (userDisplay) userDisplay.textContent = username;
        this.renderCategories();
    }

    renderCategories() {
        if (!this.els.categoryList) return;
        this.els.categoryList.innerHTML = '';
        const categories = this.manager.getCategories();
        if (categories.length === 0) {
            this.els.categoryList.innerHTML = '<p class="empty-msg">カテゴリがありません。追加してください。</p>'; return;
        }

        categories.forEach(cat => {
            const catEl = document.createElement('div');
            catEl.className = 'category-card';
            catEl.innerHTML = `
                <div class="category-header"><h2 class="category-title">${this.escape(cat.name)}</h2>
                    <div class="category-actions"><button class="btn btn-secondary btn-sm edit-cat" data-id="${cat.id}">編集</button><button class="btn btn-danger btn-sm delete-cat" data-id="${cat.id}">削除</button></div>
                </div>
                <div class="bookmark-list">
                    ${(cat.bookmarks || []).map(bm => `
                        <div class="bookmark-item">
                            <div class="bookmark-info"><a href="${this.escape(bm.url)}" target="_blank" class="bookmark-name">${this.escape(bm.name)}</a><p class="bookmark-desc">${this.escape(bm.description || '')}</p></div>
                            <div class="bookmark-actions"><button class="btn-icon edit-bm" data-cat="${cat.id}" data-id="${bm.id}">✏️</button><button class="btn-icon delete-bm" data-cat="${cat.id}" data-id="${bm.id}">🗑️</button></div>
                        </div>`).join('')}
                </div>
                <button class="btn btn-primary btn-block add-bm" data-id="${cat.id}">+ ブックマークを追加</button>
            `;
            catEl.querySelector('.edit-cat').onclick = () => this.openCategoryModal(cat.id, cat.name);
            catEl.querySelector('.delete-cat').onclick = async () => {
                if (confirm('このカテゴリを削除しますか？')) { await this.manager.deleteCategory(cat.id); this.renderCategories(); }
            };
            catEl.querySelector('.add-bm').onclick = () => this.openBookmarkModal(cat.id);
            catEl.querySelectorAll('.edit-bm').forEach(btn => {
                btn.onclick = () => {
                    const bm = cat.bookmarks.find(b => b.id === btn.dataset.id);
                    this.openBookmarkModal(cat.id, bm);
                };
            });
            catEl.querySelectorAll('.delete-bm').forEach(btn => {
                btn.onclick = async () => {
                    if (confirm('削除しますか？')) { await this.manager.deleteBookmark(cat.id, btn.dataset.id); this.renderCategories(); }
                };
            });
            this.els.categoryList.appendChild(catEl);
        });
    }

    escape(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

    openCategoryModal(id = null, name = '') {
        this.currentCategoryId = id;
        const title = document.getElementById('categoryModalTitle');
        if (title) title.textContent = id ? 'カテゴリを編集' : 'カテゴリを追加';
        const input = document.getElementById('categoryNameInput');
        if (input) input.value = name;
        this.els.categoryModal?.classList.add('active');
    }

    openBookmarkModal(categoryId, bookmark = null) {
        this.currentCategoryId = categoryId;
        this.currentBookmarkId = bookmark ? bookmark.id : null;
        const title = document.getElementById('bookmarkModalTitle');
        if (title) title.textContent = bookmark ? 'ブックマークを編集' : 'ブックマークを追加';
        const nameInput = document.getElementById('bookmarkNameInput');
        const urlInput = document.getElementById('bookmarkUrlInput');
        const descInput = document.getElementById('bookmarkDescInput');
        if (nameInput) nameInput.value = bookmark ? bookmark.name : '';
        if (urlInput) urlInput.value = bookmark ? bookmark.url : '';
        if (descInput) descInput.value = bookmark ? (bookmark.description || '') : '';
        this.els.bookmarkModal?.classList.add('active');
    }

    closeAllModals() {
        ['categoryModal', 'bookmarkModal', 'importModal'].forEach(m => this.els[m]?.classList.remove('active'));
        this.currentCategoryId = null; this.currentBookmarkId = null;
    }
}

// アプリ初期化
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await db.open();
        await db.migrateFromLocalStorage();
        const auth = new SimpleAuthManager();
        const manager = new BookmarkManager();
        new UIManager(auth, manager);
    } catch (e) {
        console.error(e);
        alert('アプリの起動中にエラーが発生しました。ページを再読み込みしてください。');
    }
});