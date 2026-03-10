/**
 * マイブックマーク - IndexedDB 対応版
 * * 【修正内容の詳細】
 * 1. 保存先を LocalStorage から IndexedDB に変更し、容量制限（5MB）を撤廃。
 * 2. 起動時に LocalStorage の既存データを確認し、自動で IndexedDB へコピーする処理を追加。
 * 3. 非同期処理 (async/await) を導入し、大容量データの読み書き時も画面を固まらせないよう最適化。
 */

// --- データベース管理クラス (IndexedDB) ---
class DBManager {
    constructor() {
        this.dbName = 'BookmarkAppDB';
        this.version = 1;
        this.storeName = 'bookmarks_store';
        this.db = null;
    }

    // データベース接続
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
            request.onerror = () => reject('IndexedDB の起動に失敗しました。ブラウザの設定を確認してください。');
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
        // 既に移行済みかチェック
        const isMigrated = await this.get('__migration_complete');
        if (isMigrated) return;

        console.log('古い保存領域からデータを移行しています...');
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
        if (password.length < 4) throw new Error('パスワードは4文字以上で入力してください');

        const userId = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);

        const existingUser = await db.get(`auth_${userId}`);
        if (existingUser) throw new Error('このユーザー名は既に使用されています');

        const userData = {
            username: username,
            passwordHash: passwordHash,
            createdAt: Date.now()
        };

        await db.set(`auth_${userId}`, userData);
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

    logout() {
        this.currentUser = null;
    }
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
    }

    async saveData() {
        if (!this.userId) return;
        await db.set(`bookmarkData_${this.userId}`, this.data);
    }

    getCategories() {
        return this.data.categories || [];
    }

    async addCategory(name) {
        const newCategory = {
            id: 'cat_' + Date.now(),
            name: name,
            bookmarks: []
        };
        if (!this.data.categories) this.data.categories = [];
        this.data.categories.push(newCategory);
        await this.saveData();
        return newCategory;
    }

    async updateCategory(categoryId, name) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            category.name = name;
            await this.saveData();
        }
    }

    async deleteCategory(categoryId) {
        this.data.categories = this.data.categories.filter(c => c.id !== categoryId);
        await this.saveData();
    }

    async addBookmark(categoryId, name, url, description) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            const newBookmark = {
                id: 'bm_' + Date.now(),
                name: name,
                url: url,
                description: description,
                createdAt: Date.now()
            };
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
                bookmark.name = name;
                bookmark.url = url;
                bookmark.description = description;
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

    exportData() {
        return JSON.stringify(this.data);
    }

    async importData(jsonData) {
        try {
            if (jsonData && Array.isArray(jsonData.categories)) {
                this.data = jsonData;
                await this.saveData();
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
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
        // ログイン・新規登録の切り替え
        document.getElementById('showRegisterBtn').onclick = () => {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'block';
        };
        document.getElementById('showLoginBtn').onclick = () => {
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('loginForm').style.display = 'block';
        };

        // 登録ボタン
        document.getElementById('registerBtn').onclick = async () => {
            const user = document.getElementById('registerUsername').value;
            const pass = document.getElementById('registerPassword').value;
            const confirmPass = document.getElementById('registerConfirmPassword').value;

            if (pass !== confirmPass) {
                alert('パスワードが一致しません');
                return;
            }

            try {
                await this.auth.register(user, pass);
                alert('登録が完了しました！ログインしてください。');
                document.getElementById('showLoginBtn').click();
            } catch (e) {
                alert(e.message);
            }
        };

        // ログインボタン
        document.getElementById('loginBtn').onclick = async () => {
            const user = document.getElementById('loginUsername').value;
            const pass = document.getElementById('loginPassword').value;

            try {
                const userData = await this.auth.login(user, pass);
                await this.manager.setUserId(userData.userId);
                this.showMainScreen(userData.username);
            } catch (e) {
                alert(e.message);
            }
        };

        // ログアウトボタン
        document.getElementById('logoutBtn').onclick = () => {
            this.auth.logout();
            location.reload();
        };

        // カテゴリ・ブックマーク保存
        document.getElementById('addCategoryBtn').onclick = () => this.openCategoryModal();
        document.getElementById('saveCategoryBtn').onclick = async () => await this.handleSaveCategory();
        document.getElementById('cancelCategoryBtn').onclick = () => this.closeAllModals();

        document.getElementById('saveBookmarkBtn').onclick = async () => await this.handleSaveBookmark();
        document.getElementById('cancelBookmarkBtn').onclick = () => this.closeAllModals();

        // エクスポート
        document.getElementById('exportBtn').onclick = () => {
            const data = this.manager.exportData();
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bookmarks_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
        };

        // インポート
        document.getElementById('importBtn').onclick = () => this.openImportModal();
        document.getElementById('confirmImportBtn').onclick = async () => await this.handleImport();
        document.getElementById('cancelImportBtn').onclick = () => this.closeAllModals();

        // 閉じるボタン
        document.querySelectorAll('.close').forEach(btn => {
            btn.onclick = () => this.closeAllModals();
        });
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
            this.categoryList.innerHTML = '<p class="empty-msg">カテゴリがありません。追加してください。</p>';
            return;
        }

        categories.forEach(cat => {
            const catEl = document.createElement('div');
            catEl.className = 'category-card';
            catEl.innerHTML = `
                <div class="category-header">
                    <h2 class="category-title">${this.escape(cat.name)}</h2>
                    <div class="category-actions">
                        <button class="btn btn-secondary btn-sm edit-cat" data-id="${cat.id}">編集</button>
                        <button class="btn btn-danger btn-sm delete-cat" data-id="${cat.id}">削除</button>
                    </div>
                </div>
                <div class="bookmark-list">
                    ${(cat.bookmarks || []).map(bm => `
                        <div class="bookmark-item">
                            <div class="bookmark-info">
                                <a href="${this.escape(bm.url)}" target="_blank" class="bookmark-name">${this.escape(bm.name)}</a>
                                <p class="bookmark-desc">${this.escape(bm.description || '')}</p>
                            </div>
                            <div class="bookmark-actions">
                                <button class="btn-icon edit-bm" data-cat="${cat.id}" data-id="${bm.id}">✏️</button>
                                <button class="btn-icon delete-bm" data-cat="${cat.id}" data-id="${bm.id}">🗑️</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <button class="btn btn-primary btn-block add-bm" data-id="${cat.id}">+ ブックマークを追加</button>
            `;

            catEl.querySelector('.edit-cat').onclick = () => this.openCategoryModal(cat.id, cat.name);
            catEl.querySelector('.delete-cat').onclick = async () => {
                if (confirm('このカテゴリと中のブックマークをすべて削除しますか？')) {
                    await this.manager.deleteCategory(cat.id);
                    this.renderCategories();
                }
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
                    if (confirm('このブックマークを削除しますか？')) {
                        await this.manager.deleteBookmark(cat.id, btn.dataset.id);
                        this.renderCategories();
                    }
                };
            });

            this.categoryList.appendChild(catEl);
        });
    }

    escape(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    openCategoryModal(id = null, name = '') {
        this.currentCategoryId = id;
        document.getElementById('categoryModalTitle').textContent = id ? 'カテゴリを編集' : 'カテゴリを追加';
        document.getElementById('categoryNameInput').value = name;
        this.categoryModal.classList.add('active');
    }

    async handleSaveCategory() {
        const name = document.getElementById('categoryNameInput').value.trim();
        if (!name) return;
        if (this.currentCategoryId) {
            await this.manager.updateCategory(this.currentCategoryId, name);
        } else {
            await this.manager.addCategory(name);
        }
        this.closeAllModals();
        this.renderCategories();
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

    async handleSaveBookmark() {
        const name = document.getElementById('bookmarkNameInput').value.trim();
        let url = document.getElementById('bookmarkUrlInput').value.trim();
        const desc = document.getElementById('bookmarkDescInput').value.trim();

        if (!name || !url) {
            alert('サイト名とURLを入力してください');
            return;
        }
        if (!url.startsWith('http')) url = 'https://' + url;

        if (this.currentBookmarkId) {
            await this.manager.updateBookmark(this.currentCategoryId, this.currentBookmarkId, name, url, desc);
        } else {
            await this.manager.addBookmark(this.currentCategoryId, name, url, desc);
        }
        this.closeAllModals();
        this.renderCategories();
    }

    openImportModal() {
        this.importModal.classList.add('active');
    }

    async handleImport() {
        const fileInput = document.getElementById('importFileInput');
        const file = fileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (await this.manager.importData(data)) {
                    alert('データをインポートしました！');
                    this.closeAllModals();
                    this.renderCategories();
                } else {
                    alert('インポートに失敗しました');
                }
            } catch (error) {
                alert('ファイルの形式が正しくありません');
            }
        };
        reader.readAsText(file);
    }

    closeAllModals() {
        this.categoryModal.classList.remove('active');
        this.bookmarkModal.classList.remove('active');
        this.importModal.classList.remove('active');
        this.currentCategoryId = null;
        this.currentBookmarkId = null;
    }
}

// --- アプリ初期化実行 ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 1. データベース起動と自動移行
        await db.open();
        await db.migrateFromLocalStorage();

        // 2. マネージャーとUIの起動
        const authManager = new SimpleAuthManager();
        const bookmarkManager = new BookmarkManager();
        new UIManager(authManager, bookmarkManager);
    } catch (e) {
        console.error(e);
        alert('アプリの起動中に致命的なエラーが発生しました。');
    }
});