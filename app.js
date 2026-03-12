// =============================================
// IndexedDB ヘルパー（bookmarkdb）
// =============================================
const IDB_NAME    = 'bookmarkdb';
const IDB_VERSION = 1;
const IDB_STORE   = 'userdata';

let _db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        if (_db) { resolve(_db); return; }
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE); // out-of-line keys
            }
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror   = (e) => reject(e.target.error);
    });
}

async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readwrite');
        const req = tx.objectStore(IDB_STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// =============================================
// シンプル認証マネージャー（localStorage のまま：認証データは少量）
// =============================================
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
        if (!username || !password) {
            throw new Error('ユーザー名とパスワードを入力してください');
        }
        if (username.length < 3) {
            throw new Error('ユーザー名は3文字以上で入力してください');
        }
        if (password.length < 4) {
            throw new Error('パスワードは4文字以上で入力してください');
        }

        const userId      = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);
        const existingUser = localStorage.getItem(`auth_${userId}`);
        if (existingUser) {
            throw new Error('このユーザー名は既に使用されています');
        }

        const userData = { username, passwordHash, createdAt: Date.now() };
        localStorage.setItem(`auth_${userId}`, JSON.stringify(userData));
        localStorage.setItem('currentUserId', userId);
        this.currentUser = username;
        return true;
    }

    async login(username, password) {
        if (!username || !password) {
            throw new Error('ユーザー名とパスワードを入力してください');
        }

        const userId     = this.generateUserId(username);
        const userDataStr = localStorage.getItem(`auth_${userId}`);
        if (!userDataStr) {
            throw new Error('ユーザー名またはパスワードが間違っています');
        }

        const userData    = JSON.parse(userDataStr);
        const passwordHash = await this.hashPassword(password);
        if (passwordHash !== userData.passwordHash) {
            throw new Error('ユーザー名またはパスワードが間違っています');
        }

        localStorage.setItem('currentUserId', userId);
        this.currentUser = username;
        return true;
    }

    logout() {
        localStorage.removeItem('currentUserId');
        this.currentUser = null;
    }

    isLoggedIn() {
        const userId = localStorage.getItem('currentUserId');
        if (userId) {
            const userDataStr = localStorage.getItem(`auth_${userId}`);
            if (userDataStr) {
                const userData = JSON.parse(userDataStr);
                this.currentUser = userData.username;
                return true;
            }
        }
        return false;
    }

    getCurrentUserId() {
        return localStorage.getItem('currentUserId');
    }
}

// =============================================
// ブックマークマネージャー（IndexedDB 版）
// =============================================
class BookmarkManager {
    constructor() {
        this.data   = { categories: [] };
        this.userId = null;
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /** 初期化：IndexedDB からデータを読み込む（localStorage からの移行も行う） */
    async init(userId) {
        this.userId = userId;

        // IndexedDB から読み込み試行
        let saved = await idbGet(`bookmarkData_${userId}`);

        if (saved) {
            // IndexedDB にデータあり
            this.data = saved;
            console.log('IndexedDB からデータを読み込みました');
        } else {
            // localStorage に旧データがあれば移行
            const legacyStr = localStorage.getItem(`bookmarkData_${userId}`);
            if (legacyStr) {
                try {
                    this.data = JSON.parse(legacyStr);
                    await idbSet(`bookmarkData_${userId}`, this.data);
                    localStorage.removeItem(`bookmarkData_${userId}`);
                    console.log('localStorage → IndexedDB への移行が完了しました');
                } catch (e) {
                    console.error('移行エラー:', e);
                    this.data = { categories: [] };
                }
            } else {
                // デフォルトデータ
                this.data = {
                    categories: [
                        {
                            id: this.generateId(),
                            name: '趣味',
                            color: '#4CAF50',
                            bookmarks: [
                                { id: this.generateId(), name: 'YouTube', url: 'https://www.youtube.com', description: '動画サイト' }
                            ]
                        },
                        {
                            id: this.generateId(),
                            name: 'プライベート',
                            color: '#2196F3',
                            bookmarks: [
                                { id: this.generateId(), name: 'Gmail', url: 'https://mail.google.com', description: 'メール' }
                            ]
                        }
                    ]
                };
                await this.saveData();
            }
        }
    }

    async saveData() {
        if (!this.userId) return;
        await idbSet(`bookmarkData_${this.userId}`, this.data);
        showSaveIndicator();
    }

    // ── カテゴリー操作 ──────────────────────────────────
    async addCategory(name, color) {
        const category = { id: this.generateId(), name, color: color || '#4CAF50', bookmarks: [] };
        this.data.categories.push(category);
        await this.saveData();
        return category;
    }

    async updateCategory(categoryId, name, color) {
        const cat = this.data.categories.find(c => c.id === categoryId);
        if (cat) { cat.name = name; cat.color = color; await this.saveData(); }
    }

    async deleteCategory(categoryId) {
        this.data.categories = this.data.categories.filter(c => c.id !== categoryId);
        await this.saveData();
    }

    async moveCategory(fromIndex, toIndex) {
        const [removed] = this.data.categories.splice(fromIndex, 1);
        this.data.categories.splice(toIndex, 0, removed);
        await this.saveData();
    }

    // ── ブックマーク操作 ────────────────────────────────
    async addBookmark(categoryId, name, url, description) {
        const cat = this.data.categories.find(c => c.id === categoryId);
        if (cat) {
            const bookmark = { id: this.generateId(), name, url, description: description || '' };
            cat.bookmarks.push(bookmark);
            await this.saveData();
            return bookmark;
        }
    }

    async updateBookmark(categoryId, bookmarkId, name, url, description) {
        const cat = this.data.categories.find(c => c.id === categoryId);
        if (cat) {
            const bm = cat.bookmarks.find(b => b.id === bookmarkId);
            if (bm) { bm.name = name; bm.url = url; bm.description = description || ''; await this.saveData(); }
        }
    }

    async deleteBookmark(categoryId, bookmarkId) {
        const cat = this.data.categories.find(c => c.id === categoryId);
        if (cat) {
            cat.bookmarks = cat.bookmarks.filter(b => b.id !== bookmarkId);
            await this.saveData();
        }
    }

    async moveBookmark(categoryId, fromIndex, toIndex) {
        const cat = this.data.categories.find(c => c.id === categoryId);
        if (cat) {
            const [removed] = cat.bookmarks.splice(fromIndex, 1);
            cat.bookmarks.splice(toIndex, 0, removed);
            await this.saveData();
        }
    }

    // ── エクスポート / インポート ───────────────────────
    exportData() {
        const dataStr = JSON.stringify(this.data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `bookmarks_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async importData(jsonData) {
        try {
            this.data = Array.isArray(jsonData) ? { categories: jsonData } : jsonData;
            await this.saveData();
            return true;
        } catch (e) {
            console.error('インポートエラー:', e);
            return false;
        }
    }
}

// =============================================
// セーブインジケーター（右下に一時表示）
// =============================================
function showSaveIndicator() {
    let el = document.getElementById('saveIndicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'saveIndicator';
        el.style.cssText = `
            position:fixed; bottom:16px; right:16px; z-index:9999;
            background:#4CAF50; color:#fff; padding:8px 16px;
            border-radius:8px; font-size:13px; font-weight:bold;
            box-shadow:0 2px 8px rgba(0,0,0,.25);
            transition:opacity .5s;
        `;
        document.body.appendChild(el);
    }
    el.textContent = '✅ 保存しました';
    el.style.opacity = '1';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

// =============================================
// UIマネージャー
// =============================================
class UIManager {
    constructor(authManager, bookmarkManager) {
        this.authManager = authManager;
        this.manager     = bookmarkManager;
        this.currentCategoryId = null;
        this.currentBookmarkId = null;

        this.initElements();
        this.initEventListeners();
    }

    initElements() {
        this.loginScreen  = document.getElementById('loginScreen');
        this.loginForm    = document.getElementById('loginForm');
        this.registerForm = document.getElementById('registerForm');

        this.loginUsername  = document.getElementById('loginUsername');
        this.loginPassword  = document.getElementById('loginPassword');
        this.loginBtn       = document.getElementById('loginBtn');
        this.showRegisterBtn = document.getElementById('showRegisterBtn');

        this.registerUsername        = document.getElementById('registerUsername');
        this.registerPassword        = document.getElementById('registerPassword');
        this.registerConfirmPassword = document.getElementById('registerConfirmPassword');
        this.registerBtn    = document.getElementById('registerBtn');
        this.showLoginBtn   = document.getElementById('showLoginBtn');

        this.appScreen    = document.getElementById('appScreen');
        this.currentUserEl = document.getElementById('currentUser');
        this.logoutBtn    = document.getElementById('logoutBtn');
        this.mainContent  = document.getElementById('mainContent');

        this.addCategoryBtn = document.getElementById('addCategoryBtn');
        this.exportBtn      = document.getElementById('exportBtn');
        this.importBtn      = document.getElementById('importBtn');

        this.categoryModal = document.getElementById('categoryModal');
        this.bookmarkModal = document.getElementById('bookmarkModal');
        this.importModal   = document.getElementById('importModal');
    }

    initEventListeners() {
        this.loginBtn.addEventListener('click', () => this.handleLogin());
        this.loginPassword.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handleLogin(); });

        this.registerBtn.addEventListener('click', () => this.handleRegister());
        this.showRegisterBtn.addEventListener('click', () => this.showRegisterForm());
        this.showLoginBtn.addEventListener('click',   () => this.showLoginForm());

        this.logoutBtn.addEventListener('click', () => this.handleLogout());

        this.addCategoryBtn.addEventListener('click', () => this.openCategoryModal());
        this.exportBtn.addEventListener('click', () => {
            this.manager.exportData();
            this.showNotification('データをエクスポートしました！');
        });
        this.importBtn.addEventListener('click', () => this.openImportModal());

        document.querySelectorAll('.modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAllModals());
        });

        document.getElementById('saveCategoryBtn').addEventListener('click',  () => this.saveCategory());
        document.getElementById('cancelCategoryBtn').addEventListener('click', () => this.closeAllModals());
        document.getElementById('saveBookmarkBtn').addEventListener('click',   () => this.saveBookmark());
        document.getElementById('cancelBookmarkBtn').addEventListener('click', () => this.closeAllModals());
        document.getElementById('confirmImportBtn').addEventListener('click',  () => this.handleImport());
        document.getElementById('cancelImportBtn').addEventListener('click',   () => this.closeAllModals());
    }

    async handleLogin() {
        const username = this.loginUsername.value.trim();
        const password = this.loginPassword.value;
        try {
            await this.authManager.login(username, password);
            location.reload();
        } catch (error) {
            alert(error.message);
        }
    }

    async handleRegister() {
        const username        = this.registerUsername.value.trim();
        const password        = this.registerPassword.value;
        const confirmPassword = this.registerConfirmPassword.value;
        if (password !== confirmPassword) { alert('パスワードが一致しません'); return; }
        try {
            await this.authManager.register(username, password);
            location.reload();
        } catch (error) {
            alert(error.message);
        }
    }

    handleLogout() {
        if (confirm('ログアウトしますか？')) {
            this.authManager.logout();
            location.reload();
        }
    }

    showLoginForm() {
        this.loginForm.style.display    = 'block';
        this.registerForm.style.display = 'none';
    }

    showRegisterForm() {
        this.loginForm.style.display    = 'none';
        this.registerForm.style.display = 'block';
    }

    showApp() {
        this.loginScreen.style.display = 'none';
        this.appScreen.style.display   = 'block';
        this.currentUserEl.textContent = `👤 ${this.authManager.currentUser}`;
        this.renderCategories();
    }

    renderCategories() {
        this.mainContent.innerHTML = '';

        if (this.manager.data.categories.length === 0) {
            this.mainContent.innerHTML = '<p class="empty-message">カテゴリーがありません。「カテゴリー追加」ボタンから追加してください。</p>';
            return;
        }

        this.manager.data.categories.forEach(category => {
            const card = this.createCategoryCard(category);
            this.mainContent.appendChild(card);
        });
    }

    createCategoryCard(category) {
        const card = document.createElement('div');
        card.className  = 'category-card';
        card.draggable  = true;
        card.dataset.categoryId = category.id;

        card.innerHTML = `
            <div class="category-header" style="background-color: ${category.color};">
                <h3>${category.name}</h3>
                <div class="category-actions">
                    <button class="icon-btn add-bookmark"    data-id="${category.id}" title="ブックマーク追加">➕</button>
                    <button class="icon-btn edit-category"   data-id="${category.id}" title="編集">✏️</button>
                    <button class="icon-btn delete-category" data-id="${category.id}" title="削除">🗑️</button>
                </div>
            </div>
            <div class="category-body">
                ${category.bookmarks.map((bookmark, index) => `
                    <div class="bookmark-item" draggable="true"
                         data-bookmark-id="${bookmark.id}" data-bookmark-index="${index}">
                        <a href="${bookmark.url}" target="_blank" class="bookmark-link">${bookmark.name}</a>
                        <div class="bookmark-actions">
                            <button class="icon-btn copy-url"
                                    data-url="${bookmark.url}" title="URLコピー">📋</button>
                            <button class="icon-btn edit-bookmark"
                                    data-category-id="${category.id}" data-id="${bookmark.id}" title="編集">✏️</button>
                            <button class="icon-btn delete-bookmark"
                                    data-category-id="${category.id}" data-id="${bookmark.id}" title="削除">🗑️</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        // ── カテゴリー D&D ──────────────────────────
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', card.dataset.categoryId);
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingCard = document.querySelector('.category-card.dragging');
            if (draggingCard && draggingCard !== card) {
                const grid = card.parentElement;
                if (e.clientX > card.getBoundingClientRect().left + card.offsetWidth / 2) {
                    grid.insertBefore(draggingCard, card.nextSibling);
                } else {
                    grid.insertBefore(draggingCard, card);
                }
            }
        });
        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            const allCards = [...card.parentElement.querySelectorAll('.category-card')];
            const newOrder = allCards.map(c => c.dataset.categoryId);
            this.manager.data.categories =
                newOrder.map(id => this.manager.data.categories.find(cat => cat.id === id));
            await this.manager.saveData();
        });

        // ── ブックマーク D&D ────────────────────────
        card.querySelectorAll('.bookmark-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.dataset.bookmarkId);
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => item.classList.remove('dragging'));
            item.addEventListener('dragover', (e) => {
                e.preventDefault(); e.stopPropagation();
                const dragging = card.querySelector('.bookmark-item.dragging');
                if (dragging && dragging !== item) {
                    const body = item.parentElement;
                    if (e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2) {
                        body.insertBefore(dragging, item.nextSibling);
                    } else {
                        body.insertBefore(dragging, item);
                    }
                }
            });
            item.addEventListener('drop', async (e) => {
                e.preventDefault(); e.stopPropagation();
                const allItems = [...item.parentElement.querySelectorAll('.bookmark-item')];
                const newOrder = allItems.map(it => it.dataset.bookmarkId);
                const cat = this.manager.data.categories.find(c => c.id === card.dataset.categoryId);
                cat.bookmarks = newOrder.map(id => cat.bookmarks.find(bm => bm.id === id));
                await this.manager.saveData();
            });
        });

        // ── URLコピー ────────────────────────────────
        card.querySelectorAll('.copy-url').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const url = e.target.dataset.url;
                try {
                    await navigator.clipboard.writeText(url);
                } catch {
                    const ta = document.createElement('textarea');
                    ta.value = url;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                this.showNotification('URLをコピーしました！');
            });
        });

        // ── ボタン ───────────────────────────────────
        card.querySelector('.add-bookmark').addEventListener('click', (e) => {
            this.openBookmarkModal(e.target.dataset.id);
        });
        card.querySelector('.edit-category').addEventListener('click', (e) => {
            this.openCategoryModal(e.target.dataset.id);
        });
        card.querySelector('.delete-category').addEventListener('click', async (e) => {
            if (confirm('このカテゴリーを削除しますか？')) {
                await this.manager.deleteCategory(e.target.dataset.id);
                this.renderCategories();
                this.showNotification('カテゴリーを削除しました');
            }
        });
        card.querySelectorAll('.edit-bookmark').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.openBookmarkModal(e.target.dataset.categoryId, e.target.dataset.id);
            });
        });
        card.querySelectorAll('.delete-bookmark').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (confirm('このブックマークを削除しますか？')) {
                    await this.manager.deleteBookmark(e.target.dataset.categoryId, e.target.dataset.id);
                    this.renderCategories();
                    this.showNotification('ブックマークを削除しました');
                }
            });
        });

        return card;
    }

    openCategoryModal(categoryId = null) {
        this.currentCategoryId = categoryId;
        const nameInput  = document.getElementById('categoryNameInput');
        const colorInput = document.getElementById('categoryColorInput');
        const title      = document.getElementById('categoryModalTitle');

        if (categoryId) {
            const cat = this.manager.data.categories.find(c => c.id === categoryId);
            if (cat) { title.textContent = 'カテゴリーを編集'; nameInput.value = cat.name; colorInput.value = cat.color; }
        } else {
            title.textContent = 'カテゴリーを追加';
            nameInput.value   = '';
            colorInput.value  = '#4CAF50';
        }
        this.categoryModal.classList.add('active');
    }

    async saveCategory() {
        const name  = document.getElementById('categoryNameInput').value.trim();
        const color = document.getElementById('categoryColorInput').value;
        if (!name) { alert('カテゴリー名を入力してください'); return; }

        if (this.currentCategoryId) {
            await this.manager.updateCategory(this.currentCategoryId, name, color);
            this.showNotification('カテゴリーを更新しました');
        } else {
            await this.manager.addCategory(name, color);
            this.showNotification('カテゴリーを追加しました');
        }
        this.closeAllModals();
        this.renderCategories();
    }

    openBookmarkModal(categoryId, bookmarkId = null) {
        this.currentCategoryId = categoryId;
        this.currentBookmarkId = bookmarkId;

        const title   = document.getElementById('bookmarkModalTitle');
        const nameInput = document.getElementById('bookmarkNameInput');
        const urlInput  = document.getElementById('bookmarkUrlInput');
        const descInput = document.getElementById('bookmarkDescInput');

        if (bookmarkId) {
            const cat = this.manager.data.categories.find(c => c.id === categoryId);
            const bm  = cat.bookmarks.find(b => b.id === bookmarkId);
            if (bm) {
                title.textContent   = 'ブックマークを編集';
                nameInput.value     = bm.name;
                urlInput.value      = bm.url;
                descInput.value     = bm.description || '';
            }
        } else {
            title.textContent = 'ブックマークを追加';
            nameInput.value   = '';
            urlInput.value    = '';
            descInput.value   = '';
        }
        this.bookmarkModal.classList.add('active');
    }

    async saveBookmark() {
        const name        = document.getElementById('bookmarkNameInput').value.trim();
        const url         = document.getElementById('bookmarkUrlInput').value.trim();
        const description = document.getElementById('bookmarkDescInput').value.trim();
        if (!name || !url) { alert('サイト名とURLを入力してください'); return; }

        if (this.currentBookmarkId) {
            await this.manager.updateBookmark(this.currentCategoryId, this.currentBookmarkId, name, url, description);
            this.showNotification('ブックマークを更新しました');
        } else {
            await this.manager.addBookmark(this.currentCategoryId, name, url, description);
            this.showNotification('ブックマークを追加しました');
        }
        this.closeAllModals();
        this.renderCategories();
    }

    openImportModal() {
        this.importModal.classList.add('active');
    }

    handleImport() {
        const fileInput = document.getElementById('importFileInput');
        const file = fileInput.files[0];
        if (!file) { alert('ファイルを選択してください'); return; }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (await this.manager.importData(data)) {
                    this.showNotification('データをインポートしました！');
                    this.closeAllModals();
                    this.renderCategories();
                } else {
                    alert('インポートに失敗しました');
                }
            } catch {
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

    showNotification(message) {
        // セーブインジケーターと重複する場合もあるためシンプルに alert
        alert(message);
    }
}

// =============================================
// ローディングオーバーレイ
// =============================================
function showLoading(visible) {
    let el = document.getElementById('loadingOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'loadingOverlay';
        el.style.cssText = `
            position:fixed; inset:0; z-index:10000;
            background:rgba(255,255,255,.85);
            display:flex; align-items:center; justify-content:center;
            font-size:1.2rem; font-weight:bold; color:#333;
        `;
        el.innerHTML = '⏳ 読み込み中...';
        document.body.appendChild(el);
    }
    el.style.display = visible ? 'flex' : 'none';
}

// =============================================
// アプリ初期化
// =============================================
document.addEventListener('DOMContentLoaded', async () => {
    showLoading(true);

    const authManager     = new SimpleAuthManager();
    const bookmarkManager = new BookmarkManager();

    if (authManager.isLoggedIn()) {
        const userId = authManager.getCurrentUserId();
        await bookmarkManager.init(userId);
    }

    showLoading(false);

    const ui = new UIManager(authManager, bookmarkManager);

    if (authManager.isLoggedIn()) {
        ui.showApp();
    }
});
