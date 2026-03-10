/**
 * マイブックマーク - IndexedDB 対応版 (完全版)
 * * 【修正内容】
 * 1. 保存先を LocalStorage（5MB制限）から IndexedDB（PC容量依存）へ変更。
 * 2. データベース名を変更し、以前の不完全な構造によるエラーを回避。
 * 3. 起動時に LocalStorage の既存データを自動で IndexedDB へ移行する機能を搭載。
 * 4. データの読み書きを非同期（async/await）に対応させ、動作を安定化。
 */

// --- データベース管理クラス (IndexedDB) ---
class DBManager {
    constructor() {
        // 以前のエラー（bookmarks_store が見つからない）を確実に回避するため、
        // データベース名を新しく一新して構造を初期化します。
        this.dbName = 'MyBookmarkAppDB_V2_Final';
        this.version = 1;
        this.storeName = 'bookmarks_store';
        this.db = null;
    }

    // データベース接続
    async open() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            
            // データベースの「棚（ストア）」を作る重要な処理
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                    console.log('IndexedDB: データの棚を作成しました');
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };

            request.onerror = (e) => {
                console.error('IndexedDB Error:', e);
                reject('IndexedDB の起動に失敗しました。ブラウザの設定（シークレットモード等）を確認してください。');
            };
        });
    }

    // データの保存
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

    // データの取得
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

    // LocalStorage から IndexedDB への自動データ移行
    async migrateFromLocalStorage() {
        const isMigrated = await this.get('__migration_complete');
        if (isMigrated) return;

        console.log('古い保存領域(LocalStorage)からデータを移行しています...');
        let count = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            // 認証情報やブックマークデータ、DAILY24などのデータを対象にする
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
        if (count > 0) {
            console.log(`${count}件のデータを移行しました。LocalStorage の元データは安全のため保持しています。`);
        }
    }
}

const db = new DBManager();

// --- 認証マネージャー ---
class SimpleAuthManager {
    constructor() {
        this.currentUser = null;
    }

    async hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    generateUserId(username) {
        return 'user_' + username.toLowerCase().replace(/[^a-z0-9]/g, '_');
    }

    async register(username, password) {
        if (!username || !password) throw new Error('ユーザー名とパスワードを入力してください');
        if (username.length < 3) throw new Error('ユーザー名は3文字以上で入力してください');
        const userId = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);

        const existingUser = await db.get(`auth_${userId}`);
        if (existingUser) throw new Error('このユーザー名は既に使用されています');

        await db.set(`auth_${userId}`, {
            username: username,
            passwordHash: passwordHash,
            createdAt: Date.now()
        });
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
    constructor() {
        this.userId = null;
        this.data = { categories: [] };
    }

    async setUserId(userId) {
        this.userId = userId;
        await this.loadData();
    }

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
        const newCategory = { id: 'cat_' + Date.now(), name: name, bookmarks: [] };
        if (!this.data.categories) this.data.categories = [];
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
            const newBookmark = { id: 'bm_' + Date.now(), name, url, description, createdAt: Date.now() };
            if (!category.bookmarks) category.bookmarks = [];
            category.bookmarks.push(newBookmark);
            await this.saveData();
            return newBookmark;
        }
    }

    async updateBookmark(categoryId, bookmarkId, name, url, description) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            const bookmark = category.bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) {
                Object.assign(bookmark, { name, url, description });
                await this.saveData();
            }
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

        this.loginScreen = document.getElementById('loginScreen');
        this.mainScreen = document.getElementById('mainScreen');
        this.categoryList = document.getElementById('categoryList');
        
        this.categoryModal = document.getElementById('categoryModal');
        this.bookmarkModal = document.getElementById('bookmarkModal');
        this.importModal = document.getElementById('importModal');

        this.initEventListeners();
    }

    initEventListeners() {
        document.getElementById('showRegisterBtn').onclick = () => {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'block';
        };
        document.getElementById('showLoginBtn').onclick = () => {
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('loginForm').style.display = 'block';
        };

        document.getElementById('registerBtn').onclick = async () => {
            const user = document.getElementById('registerUsername').value;
            const pass = document.getElementById('registerPassword').value;
            if (pass !== document.getElementById('registerConfirmPassword').value) {
                alert('パスワードが一致しません'); return;
            }
            try {
                await this.auth.register(user, pass);
                alert('登録完了！ログインしてください。');
                document.getElementById('showLoginBtn').click();
            } catch (e) { alert(e.message); }
        };

        document.getElementById('loginBtn').onclick = async () => {
            const user = document.getElementById('loginUsername').value;
            const pass = document.getElementById('loginPassword').value;
            try {
                const userData = await this.auth.login(user, pass);
                await this.manager.setUserId(userData.userId);
                this.showMainScreen(userData.username);
            } catch (e) { alert(e.message); }
        };

        document.getElementById('logoutBtn').onclick = () => { this.auth.logout(); location.reload(); };

        document.getElementById('addCategoryBtn').onclick = () => this.openCategoryModal();
        document.getElementById('saveCategoryBtn').onclick = async () => {
            const name = document.getElementById('categoryNameInput').value.trim();
            if (!name) return;
            if (this.currentCategoryId) await this.manager.updateCategory(this.currentCategoryId, name);
            else await this.manager.addCategory(name);
            this.closeAllModals(); this.renderCategories();
        };

        document.getElementById('saveBookmarkBtn').onclick = async () => {
            const name = document.getElementById('bookmarkNameInput').value.trim();
            let url = document.getElementById('bookmarkUrlInput').value.trim();
            const desc = document.getElementById('bookmarkDescInput').value.trim();
            if (!name || !url) { alert('サイト名とURLを入力してください'); return; }
            if (!url.startsWith('http')) url = 'https://' + url;

            if (this.currentBookmarkId) await this.manager.updateBookmark(this.currentCategoryId, this.currentBookmarkId, name, url, desc);
            else await this.manager.addBookmark(this.currentCategoryId, name, url, desc);
            this.closeAllModals(); this.renderCategories();
        };

        document.getElementById('exportBtn').onclick = () => {
            const data = this.manager.exportData();
            const blob = new Blob([data], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `bookmarks_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
        };

        document.getElementById('importBtn').onclick = () => this.importModal.classList.add('active');
        document.getElementById('confirmImportBtn').onclick = async () => {
            const file = document.getElementById('importFileInput').files[0];
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
        };

        document.querySelectorAll('.close, .cancel').forEach(btn => btn.onclick = () => this.closeAllModals());
    }

    showMainScreen(username) {
        this.loginScreen.style.display = 'none';
        this.mainScreen.style.display = 'block';
        document.getElementById('displayUsername').textContent = username;
        this.renderCategories();
    }

    renderCategories() {
        this.categoryList.innerHTML = '';
        const categories = this.manager.getCategories();
        if (categories.length === 0) {
            this.categoryList.innerHTML = '<p class="empty-msg">カテゴリがありません。追加してください。</p>'; return;
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
            this.categoryList.appendChild(catEl);
        });
    }

    escape(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

    openCategoryModal(id = null, name = '') {
        this.currentCategoryId = id;
        document.getElementById('categoryModalTitle').textContent = id ? 'カテゴリを編集' : 'カテゴリを追加';
        document.getElementById('categoryNameInput').value = name;
        this.categoryModal.classList.add('active');
    }

    openBookmarkModal(categoryId, bookmark = null) {
        this.currentCategoryId = categoryId;
        this.currentBookmarkId = bookmark ? bookmark.id : null;
        document.getElementById('bookmarkModalTitle').textContent = bookmark ? 'ブックマークを編集' : 'ブックマークを追加';
        document.getElementById('bookmarkNameInput').value = bookmark ? bookmark.name : '';
        document.getElementById('bookmarkUrlInput').value = bookmark ? bookmark.url : '';
        document.getElementById('bookmarkDescInput').value = bookmark ? (bookmark.description || '') : '';
        this.bookmarkModal.classList.add('active');
    }

    closeAllModals() {
        this.categoryModal.classList.remove('active');
        this.bookmarkModal.classList.remove('active');
        this.importModal.classList.remove('active');
        this.currentCategoryId = null; this.currentBookmarkId = null;
    }
}

// アプリ初期化
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 1. データベース起動
        await db.open();
        // 2. 初回のみ古いデータを移行
        await db.migrateFromLocalStorage();
        // 3. UIの起動
        const authManager = new SimpleAuthManager();
        const bookmarkManager = new BookmarkManager();
        new UIManager(authManager, bookmarkManager);
    } catch (e) {
        console.error(e);
        alert('アプリの起動中にエラーが発生しました。ブラウザのキャッシュをクリアするか、ページを再読み込みしてください。');
    }
});