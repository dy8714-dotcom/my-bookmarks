// 認証マネージャー
class AuthManager {
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

        const userId = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);

        // Firestoreでユーザーが存在するか確認
        if (window.firebaseDB) {
            const userDoc = window.firebaseDoc(window.firebaseDB, 'users', userId);
            const docSnap = await window.firebaseGetDoc(userDoc);

            if (docSnap.exists()) {
                throw new Error('このユーザー名は既に使用されています');
            }

            // 新規ユーザーを登録
            await window.firebaseSetDoc(userDoc, {
                username: username,
                passwordHash: passwordHash,
                createdAt: Date.now()
            });
        }

        // ローカルに保存
        localStorage.setItem('currentUser', username);
        localStorage.setItem('userId', userId);
        this.currentUser = username;

        return userId;
    }

    async login(username, password) {
        if (!username || !password) {
            throw new Error('ユーザー名とパスワードを入力してください');
        }

        const userId = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);

        // Firestoreでユーザーを確認
        if (window.firebaseDB) {
            const userDoc = window.firebaseDoc(window.firebaseDB, 'users', userId);
            const docSnap = await window.firebaseGetDoc(userDoc);

            if (!docSnap.exists()) {
                throw new Error('ユーザー名またはパスワードが正しくありません');
            }

            const userData = docSnap.data();
            if (userData.passwordHash !== passwordHash) {
                throw new Error('ユーザー名またはパスワードが正しくありません');
            }
        }

        // ローカルに保存
        localStorage.setItem('currentUser', username);
        localStorage.setItem('userId', userId);
        this.currentUser = username;

        return userId;
    }

    logout() {
        localStorage.removeItem('currentUser');
        this.currentUser = null;
        // userIdは保持（次回ログイン時に同じIDを使用）
    }

    isLoggedIn() {
        const user = localStorage.getItem('currentUser');
        if (user) {
            this.currentUser = user;
            return true;
        }
        return false;
    }

    getCurrentUser() {
        return this.currentUser || localStorage.getItem('currentUser');
    }
}

// Firebase同期マネージャー
class FirebaseSyncManager {
    constructor(bookmarkManager) {
        this.manager = bookmarkManager;
        this.userId = localStorage.getItem('userId');
        this.syncEnabled = false;
        this.lastSyncTime = null;
        this.unsubscribe = null;
    }

    setUserId(userId) {
        this.userId = userId;
    }

    async enableSync() {
        if (!window.firebaseDB || !this.userId) {
            console.error('Firebase not initialized or no user ID');
            return false;
        }

        try {
            this.syncEnabled = true;
            await this.uploadToCloud();
            this.listenToChanges();
            return true;
        } catch (error) {
            console.error('Sync enable error:', error);
            this.syncEnabled = false;
            return false;
        }
    }

    async uploadToCloud() {
        if (!window.firebaseDB || !this.userId) return;

        try {
            const docRef = window.firebaseDoc(window.firebaseDB, 'bookmarks', this.userId);
            await window.firebaseSetDoc(docRef, {
                categories: this.manager.categories,
                lastModified: Date.now()
            });
            this.lastSyncTime = Date.now();
            console.log('Data uploaded to cloud');
        } catch (error) {
            console.error('Upload error:', error);
            throw error;
        }
    }

    async downloadFromCloud() {
        if (!window.firebaseDB || !this.userId) return null;

        try {
            const docRef = window.firebaseDoc(window.firebaseDB, 'bookmarks', this.userId);
            const docSnap = await window.firebaseGetDoc(docRef);

            if (docSnap.exists()) {
                const data = docSnap.data();
                return data.categories;
            }
            return null;
        } catch (error) {
            console.error('Download error:', error);
            return null;
        }
    }

    listenToChanges() {
        if (!window.firebaseDB || this.unsubscribe || !this.userId) return;

        const docRef = window.firebaseDoc(window.firebaseDB, 'bookmarks', this.userId);
        this.unsubscribe = window.firebaseOnSnapshot(docRef, (doc) => {
            if (doc.exists()) {
                const data = doc.data();
                const cloudTime = data.lastModified || 0;
                
                // 自分の変更は無視
                if (cloudTime <= this.lastSyncTime) return;

                // クラウドのデータが新しい場合のみ更新
                const localTime = parseInt(localStorage.getItem('lastLocalChange') || '0');
                if (cloudTime > localTime) {
                    this.manager.categories = data.categories;
                    this.manager.saveData();
                    if (window.ui) {
                        window.ui.render();
                        window.ui.showNotification('☁️ クラウドから同期しました', 'success');
                    }
                }
            }
        });
    }

    stopListening() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }

    async syncNow() {
        if (!this.syncEnabled) {
            // 初回同期：クラウドにデータがあれば取得
            const cloudData = await this.downloadFromCloud();
            if (cloudData && cloudData.length > 0) {
                const merge = confirm('クラウドにデータが見つかりました。クラウドのデータを使用しますか？\n\n「OK」→ クラウドのデータを使用\n「キャンセル」→ このデバイスのデータを使用');
                if (merge) {
                    this.manager.categories = cloudData;
                    this.manager.saveData();
                    if (window.ui) window.ui.render();
                }
            }
            await this.enableSync();
            return true;
        } else {
            await this.uploadToCloud();
            return true;
        }
    }
}

// データ管理
class BookmarkManager {
    constructor() {
        this.categories = this.loadData() || this.getDefaultData();
        this.currentCategoryId = null;
        this.currentBookmarkId = null;
        this.editMode = false;
        this.syncManager = new FirebaseSyncManager(this);
    }

    getDefaultData() {
        return [
            {
                id: this.generateId(),
                name: '趣味',
                color: '#4CAF50',
                bookmarks: [
                    { id: this.generateId(), name: 'YouTube', url: 'https://www.youtube.com', description: '動画共有サイト' },
                    { id: this.generateId(), name: 'Netflix', url: 'https://www.netflix.com', description: '動画ストリーミング' }
                ]
            },
            {
                id: this.generateId(),
                name: 'プライベート',
                color: '#2196F3',
                bookmarks: [
                    { id: this.generateId(), name: 'Gmail', url: 'https://mail.google.com', description: 'メール' },
                    { id: this.generateId(), name: 'カレンダー', url: 'https://calendar.google.com', description: 'スケジュール管理' }
                ]
            },
            {
                id: this.generateId(),
                name: '仕事',
                color: '#FF5722',
                bookmarks: [
                    { id: this.generateId(), name: 'Slack', url: 'https://slack.com', description: 'チームコミュニケーション' },
                    { id: this.generateId(), name: 'Zoom', url: 'https://zoom.us', description: 'ビデオ会議' }
                ]
            },
            {
                id: this.generateId(),
                name: '勉強',
                color: '#9C27B0',
                bookmarks: [
                    { id: this.generateId(), name: 'Google', url: 'https://www.google.com', description: '検索エンジン' },
                    { id: this.generateId(), name: 'Wikipedia', url: 'https://ja.wikipedia.org', description: 'オンライン百科事典' }
                ]
            }
        ];
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    loadData() {
        try {
            const userId = localStorage.getItem('userId');
            const data = localStorage.getItem(`bookmarkData_${userId}`);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('データの読み込みに失敗しました:', error);
            return null;
        }
    }

    saveData() {
        try {
            const userId = localStorage.getItem('userId');
            localStorage.setItem(`bookmarkData_${userId}`, JSON.stringify(this.categories));
            localStorage.setItem('lastLocalChange', Date.now().toString());
            
            // 自動クラウド同期
            if (this.syncManager && this.syncManager.syncEnabled) {
                this.syncManager.uploadToCloud();
            }
        } catch (error) {
            console.error('データの保存に失敗しました:', error);
            alert('データの保存に失敗しました。ストレージの容量を確認してください。');
        }
    }

    addCategory(name, color) {
        const category = {
            id: this.generateId(),
            name: name,
            color: color,
            bookmarks: []
        };
        this.categories.push(category);
        this.saveData();
        return category;
    }

    updateCategory(categoryId, name, color) {
        const category = this.categories.find(c => c.id === categoryId);
        if (category) {
            category.name = name;
            category.color = color;
            this.saveData();
            return true;
        }
        return false;
    }

    deleteCategory(categoryId) {
        const index = this.categories.findIndex(c => c.id === categoryId);
        if (index !== -1) {
            this.categories.splice(index, 1);
            this.saveData();
            return true;
        }
        return false;
    }

    addBookmark(categoryId, name, url, description) {
        const category = this.categories.find(c => c.id === categoryId);
        if (category) {
            // URLの正規化
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            
            const bookmark = {
                id: this.generateId(),
                name: name,
                url: url,
                description: description || ''
            };
            category.bookmarks.push(bookmark);
            this.saveData();
            return bookmark;
        }
        return null;
    }

    updateBookmark(categoryId, bookmarkId, name, url, description) {
        const category = this.categories.find(c => c.id === categoryId);
        if (category) {
            const bookmark = category.bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) {
                // URLの正規化
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                
                bookmark.name = name;
                bookmark.url = url;
                bookmark.description = description || '';
                this.saveData();
                return true;
            }
        }
        return false;
    }

    deleteBookmark(categoryId, bookmarkId) {
        const category = this.categories.find(c => c.id === categoryId);
        if (category) {
            const index = category.bookmarks.findIndex(b => b.id === bookmarkId);
            if (index !== -1) {
                category.bookmarks.splice(index, 1);
                this.saveData();
                return true;
            }
        }
        return false;
    }

    searchBookmarks(query) {
        if (!query.trim()) return this.categories;

        const lowerQuery = query.toLowerCase();
        return this.categories.map(category => ({
            ...category,
            bookmarks: category.bookmarks.filter(bookmark =>
                bookmark.name.toLowerCase().includes(lowerQuery) ||
                bookmark.url.toLowerCase().includes(lowerQuery) ||
                (bookmark.description && bookmark.description.toLowerCase().includes(lowerQuery))
            )
        })).filter(category => category.bookmarks.length > 0);
    }

    exportData() {
        const dataStr = JSON.stringify(this.categories, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `bookmarks_${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        URL.revokeObjectURL(url);
    }

    importData(jsonData) {
        try {
            const data = JSON.parse(jsonData);
            if (Array.isArray(data) && data.every(cat => cat.name && cat.bookmarks)) {
                this.categories = data;
                this.saveData();
                return true;
            }
            return false;
        } catch (error) {
            console.error('インポートエラー:', error);
            return false;
        }
    }

    getStats() {
        const categoryCount = this.categories.length;
        const bookmarkCount = this.categories.reduce((sum, cat) => sum + cat.bookmarks.length, 0);
        return { categoryCount, bookmarkCount };
    }
}

// UI管理
class UIManager {
    constructor(bookmarkManager, authManager) {
        this.manager = bookmarkManager;
        this.authManager = authManager;
        this.initElements();
        this.initEventListeners();
        
        // ログイン状態を確認
        if (this.authManager.isLoggedIn()) {
            this.showApp();
        } else {
            this.showLogin();
        }
    }

    initElements() {
        // ログイン画面
        this.loginScreen = document.getElementById('loginScreen');
        this.appScreen = document.getElementById('appScreen');
        this.usernameInput = document.getElementById('loginUsername');
        this.passwordInput = document.getElementById('loginPassword');
        this.loginBtn = document.getElementById('loginBtn');
        this.showRegisterBtn = document.getElementById('showRegister');
        this.loginTitle = document.getElementById('loginTitle');

        // モーダル要素
        this.categoryModal = document.getElementById('categoryModal');
        this.bookmarkModal = document.getElementById('bookmarkModal');
        this.importModal = document.getElementById('importModal');

        // ボタン
        this.addCategoryBtn = document.getElementById('addCategoryBtn');
        this.exportBtn = document.getElementById('exportBtn');
        this.importBtn = document.getElementById('importBtn');
        this.syncBtn = document.getElementById('syncBtn');
        this.logoutBtn = document.getElementById('logoutBtn');

        // 入力フィールド
        this.searchInput = document.getElementById('searchInput');

        // メインコンテンツ
        this.mainContent = document.getElementById('mainContent');

        // 統計
        this.categoryCountEl = document.getElementById('categoryCount');
        this.bookmarkCountEl = document.getElementById('bookmarkCount');
        this.syncStatusEl = document.getElementById('syncStatus');
        this.currentUserEl = document.getElementById('currentUser');
    }

    initEventListeners() {
        // 要素の存在確認（デバッグ用）
        const elements = {
            loginBtn: this.loginBtn,
            showRegisterBtn: this.showRegisterBtn,
            passwordInput: this.passwordInput,
            logoutBtn: this.logoutBtn,
            addCategoryBtn: this.addCategoryBtn,
            exportBtn: this.exportBtn,
            importBtn: this.importBtn,
            syncBtn: this.syncBtn,
            searchInput: this.searchInput
        };
        
        for (const [name, element] of Object.entries(elements)) {
            if (!element) {
                console.error(`❗ ${name} が見つかりません`);
            }
        }

        // ログインボタン
        if (this.loginBtn) {
            this.loginBtn.addEventListener('click', () => this.handleLogin());
        }

        // 新規登録ボタン
        if (this.showRegisterBtn) {
            this.showRegisterBtn.addEventListener('click', () => this.toggleLoginRegister());
        }

        // Enterキーでログイン
        if (this.passwordInput) {
            this.passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.handleLogin();
            });
        }

        // ログアウトボタン
        if (this.logoutBtn) {
            this.logoutBtn.addEventListener('click', () => this.handleLogout());
        }

        // カテゴリー追加ボタン
        if (this.addCategoryBtn) {
            this.addCategoryBtn.addEventListener('click', () => this.openCategoryModal());
        }

        // エクスポート
        if (this.exportBtn) {
            this.exportBtn.addEventListener('click', () => {
                this.manager.exportData();
                this.showNotification('データをエクスポートしました！', 'success');
            });
        }

        // インポート
        if (this.importBtn) {
            this.importBtn.addEventListener('click', () => this.openImportModal());
        }

        // 同期ボタン
        if (this.syncBtn) {
            this.syncBtn.addEventListener('click', () => this.handleSync());
        }

        // 検索
        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        // モーダルのクローズボタン
        document.querySelectorAll('.modal .close').forEach(closeBtn => {
            closeBtn.addEventListener('click', () => this.closeAllModals());
        });

        // モーダル外クリックで閉じる
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.closeAllModals();
            }
        });

        // カテゴリーモーダルのボタン
        const saveCategoryBtn = document.getElementById('saveCategoryBtn');
        const cancelCategoryBtn = document.getElementById('cancelCategoryBtn');
        
        if (saveCategoryBtn) {
            saveCategoryBtn.addEventListener('click', () => this.saveCategory());
        }
        if (cancelCategoryBtn) {
            cancelCategoryBtn.addEventListener('click', () => this.closeAllModals());
        }

        // ブックマークモーダルのボタン
        document.getElementById('saveBookmarkBtn').addEventListener('click', () => this.saveBookmark());
        document.getElementById('cancelBookmarkBtn').addEventListener('click', () => this.closeAllModals());

        // インポートモーダルのボタン
        document.getElementById('confirmImportBtn').addEventListener('click', () => this.handleImport());
        document.getElementById('cancelImportBtn').addEventListener('click', () => this.closeAllModals());
    }

    toggleLoginRegister() {
        if (this.loginTitle.textContent === 'ログイン') {
            this.loginTitle.textContent = '新規登録';
            this.loginBtn.textContent = '登録';
            this.showRegisterBtn.textContent = 'ログインに戻る';
        } else {
            this.loginTitle.textContent = 'ログイン';
            this.loginBtn.textContent = 'ログイン';
            this.showRegisterBtn.textContent = '新規登録';
        }
    }

    async handleLogin() {
        const username = this.usernameInput.value.trim();
        const password = this.passwordInput.value;
        const isRegister = this.loginTitle.textContent === '新規登録';

        this.loginBtn.disabled = true;
        this.loginBtn.textContent = '処理中...';

        try {
            let userId;
            if (isRegister) {
                userId = await this.authManager.register(username, password);
                this.showNotification('登録が完了しました！', 'success');
            } else {
                userId = await this.authManager.login(username, password);
                this.showNotification('ログインしました！', 'success');
            }

            // ユーザーIDを設定
            this.manager.syncManager.setUserId(userId);
            
            // データを再読み込み
            this.manager.categories = this.manager.loadData() || this.manager.getDefaultData();
            
            // 自動同期を有効化
            await this.handleSync();
            
            this.showApp();
        } catch (error) {
            this.showNotification(error.message, 'error');
        }

        this.loginBtn.disabled = false;
        this.loginBtn.textContent = isRegister ? '登録' : 'ログイン';
    }

    handleLogout() {
        if (confirm('ログアウトしますか？\n（データはクラウドに保存されています）')) {
            this.manager.syncManager.stopListening();
            this.authManager.logout();
            this.showLogin();
            this.showNotification('ログアウトしました', 'success');
        }
    }

    showLogin() {
        this.loginScreen.style.display = 'flex';
        this.appScreen.style.display = 'none';
        this.usernameInput.value = '';
        this.passwordInput.value = '';
        this.usernameInput.focus();
    }

    showApp() {
        this.loginScreen.style.display = 'none';
        this.appScreen.style.display = 'block';
        this.currentUserEl.textContent = this.authManager.getCurrentUser();
        this.render();
        this.updateSyncStatus();
    }

    async handleSync() {
        this.syncBtn.disabled = true;
        this.syncBtn.textContent = '⏳ 同期中...';

        try {
            const success = await this.manager.syncManager.syncNow();
            if (success) {
                this.showNotification('☁️ クラウド同期が有効になりました！', 'success');
                this.updateSyncStatus();
            } else {
                this.showNotification('同期に失敗しました', 'error');
            }
        } catch (error) {
            console.error('Sync error:', error);
            this.showNotification('同期エラーが発生しました', 'error');
        }

        this.syncBtn.disabled = false;
        this.syncBtn.textContent = '☁️ 同期';
    }

    updateSyncStatus() {
        if (!this.syncStatusEl) return;

        if (this.manager.syncManager.syncEnabled) {
            this.syncStatusEl.textContent = '☁️ クラウド同期中';
            this.syncStatusEl.style.color = '#4CAF50';
            if (this.syncBtn) {
                this.syncBtn.style.background = '#4CAF50';
            }
        } else {
            this.syncStatusEl.textContent = '💾 ローカル保存';
            this.syncStatusEl.style.color = '#666';
        }
    }

    render(categories = this.manager.categories) {
        this.mainContent.innerHTML = '';

        if (categories.length === 0) {
            this.mainContent.innerHTML = `
                <div class="empty-state">
                    <h2>📭 カテゴリーがありません</h2>
                    <p>「カテゴリー追加」ボタンからカテゴリーを作成してください</p>
                </div>
            `;
        } else {
            categories.forEach((category, index) => {
                const categoryCard = this.createCategoryCard(category, index);
                this.mainContent.appendChild(categoryCard);
            });
        }

        this.updateStats();
    }

    createCategoryCard(category, index) {
        const card = document.createElement('div');
        card.className = 'category-card';
        card.draggable = true;
        card.ondragstart = (e) => this.handleCategoryDragStart(e, index);
        card.ondragover = (e) => this.handleCategoryDragOver(e);
        card.ondrop = (e) => this.handleCategoryDrop(e, index);
        card.ondragend = (e) => this.handleDragEnd(e);
        card.innerHTML = `
            <div class="category-header" style="background: ${category.color};">
                <div class="category-title" style="cursor: move;">
                    <span>⋮⋮</span>
                    <span>📂</span>
                    <span>${this.escapeHtml(category.name)}</span>
                </div>
                <div class="category-actions">
                    <button class="icon-btn" onclick="event.stopPropagation(); ui.openCategoryModal('${category.id}')" title="編集">✏️</button>
                    <button class="icon-btn" onclick="event.stopPropagation(); ui.deleteCategory('${category.id}')" title="削除">🗑️</button>
                </div>
            </div>
            <div class="category-body">
                <div class="bookmark-list" id="bookmarks-${category.id}">
                    ${this.renderBookmarks(category)}
                </div>
                <button class="add-bookmark-btn" onclick="ui.openBookmarkModal('${category.id}')">
                    ➕ ブックマークを追加
                </button>
            </div>
        `;
        return card;
    }

    renderBookmarks(category) {
        if (category.bookmarks.length === 0) {
            return '<div class="empty-state">ブックマークがありません</div>';
        }

        return category.bookmarks.map((bookmark, index) => `
            <div class="bookmark-item" onclick="ui.openBookmark('${this.escapeHtml(bookmark.url)}')" draggable="true" ondragstart="ui.handleBookmarkDragStart(event, '${category.id}', ${index})" ondragover="ui.handleBookmarkDragOver(event)" ondrop="ui.handleBookmarkDrop(event, '${category.id}', ${index})" ondragend="ui.handleDragEnd(event)">
                <div class="bookmark-info">
                    <div class="bookmark-name">⋮⋮ ${this.escapeHtml(bookmark.name)}</div>
                    <div class="bookmark-url">${this.escapeHtml(bookmark.url)}</div>
                    ${bookmark.description ? `<div class="bookmark-desc">${this.escapeHtml(bookmark.description)}</div>` : ''}
                </div>
                <div class="bookmark-actions">
                    <button class="bookmark-item-btn" onclick="event.stopPropagation(); ui.copyUrl('${this.escapeHtml(bookmark.url)}')" title="URLをコピー">📋</button>
                    <button class="bookmark-item-btn" onclick="event.stopPropagation(); ui.openBookmarkModal('${category.id}', '${bookmark.id}')" title="編集">✏️</button>
                    <button class="bookmark-item-btn" onclick="event.stopPropagation(); ui.deleteBookmark('${category.id}', '${bookmark.id}')" title="削除">🗑️</button>
                </div>
            </div>
        `).join('');
    }

    openBookmark(url) {
        try {
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error('ブックマークを開けませんでした:', error);
            this.showNotification('ブックマークを開けませんでした', 'error');
        }
    }

    openCategoryModal(categoryId = null) {
        this.manager.currentCategoryId = categoryId;
        this.manager.editMode = !!categoryId;

        const modal = this.categoryModal;
        const title = document.getElementById('categoryModalTitle');
        const nameInput = document.getElementById('categoryNameInput');
        const colorInput = document.getElementById('categoryColorInput');

        if (categoryId) {
            const category = this.manager.categories.find(c => c.id === categoryId);
            if (category) {
                title.textContent = 'カテゴリーを編集';
                nameInput.value = category.name;
                colorInput.value = category.color;
            }
        } else {
            title.textContent = 'カテゴリーを追加';
            nameInput.value = '';
            colorInput.value = '#4CAF50';
        }

        modal.style.display = 'block';
        nameInput.focus();
    }

    saveCategory() {
        const name = document.getElementById('categoryNameInput').value.trim();
        const color = document.getElementById('categoryColorInput').value;

        if (!name) {
            this.showNotification('カテゴリー名を入力してください', 'error');
            return;
        }

        if (this.manager.editMode && this.manager.currentCategoryId) {
            this.manager.updateCategory(this.manager.currentCategoryId, name, color);
            this.showNotification('カテゴリーを更新しました', 'success');
        } else {
            this.manager.addCategory(name, color);
            this.showNotification('カテゴリーを追加しました', 'success');
        }

        this.closeAllModals();
        this.render();
    }

    deleteCategory(categoryId) {
        const category = this.manager.categories.find(c => c.id === categoryId);
        if (!category) return;

        if (confirm(`「${category.name}」カテゴリーとその中のブックマークをすべて削除しますか？`)) {
            this.manager.deleteCategory(categoryId);
            this.showNotification('カテゴリーを削除しました', 'success');
            this.render();
        }
    }

    openBookmarkModal(categoryId, bookmarkId = null) {
        this.manager.currentCategoryId = categoryId;
        this.manager.currentBookmarkId = bookmarkId;
        this.manager.editMode = !!bookmarkId;

        const modal = this.bookmarkModal;
        const title = document.getElementById('bookmarkModalTitle');
        const nameInput = document.getElementById('bookmarkNameInput');
        const urlInput = document.getElementById('bookmarkUrlInput');
        const descInput = document.getElementById('bookmarkDescInput');

        if (bookmarkId) {
            const category = this.manager.categories.find(c => c.id === categoryId);
            const bookmark = category?.bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) {
                title.textContent = 'ブックマークを編集';
                nameInput.value = bookmark.name;
                urlInput.value = bookmark.url;
                descInput.value = bookmark.description || '';
            }
        } else {
            title.textContent = 'ブックマークを追加';
            nameInput.value = '';
            urlInput.value = '';
            descInput.value = '';
        }

        modal.style.display = 'block';
        nameInput.focus();
    }

    saveBookmark() {
        const name = document.getElementById('bookmarkNameInput').value.trim();
        const url = document.getElementById('bookmarkUrlInput').value.trim();
        const description = document.getElementById('bookmarkDescInput').value.trim();

        if (!name) {
            this.showNotification('サイト名を入力してください', 'error');
            return;
        }

        if (!url) {
            this.showNotification('URLを入力してください', 'error');
            return;
        }

        // URL検証
        try {
            let testUrl = url;
            if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
                testUrl = 'https://' + testUrl;
            }
            new URL(testUrl);
        } catch (error) {
            this.showNotification('有効なURLを入力してください', 'error');
            return;
        }

        if (this.manager.editMode && this.manager.currentBookmarkId) {
            this.manager.updateBookmark(
                this.manager.currentCategoryId,
                this.manager.currentBookmarkId,
                name,
                url,
                description
            );
            this.showNotification('ブックマークを更新しました', 'success');
        } else {
            this.manager.addBookmark(
                this.manager.currentCategoryId,
                name,
                url,
                description
            );
            this.showNotification('ブックマークを追加しました', 'success');
        }

        this.closeAllModals();
        this.render();
    }

    deleteBookmark(categoryId, bookmarkId) {
        const category = this.manager.categories.find(c => c.id === categoryId);
        const bookmark = category?.bookmarks.find(b => b.id === bookmarkId);
        
        if (!bookmark) return;

        if (confirm(`「${bookmark.name}」を削除しますか？`)) {
            this.manager.deleteBookmark(categoryId, bookmarkId);
            this.showNotification('ブックマークを削除しました', 'success');
            this.render();
        }
    }

    handleSearch(query) {
        const results = this.manager.searchBookmarks(query);
        this.render(results);
    }

    openImportModal() {
        this.importModal.style.display = 'block';
        document.getElementById('importFileInput').value = '';
    }

    handleImport() {
        const fileInput = document.getElementById('importFileInput');
        const file = fileInput.files[0];

        if (!file) {
            this.showNotification('ファイルを選択してください', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const success = this.manager.importData(e.target.result);
            if (success) {
                this.showNotification('データをインポートしました', 'success');
                this.closeAllModals();
                this.render();
            } else {
                this.showNotification('無効なファイル形式です', 'error');
            }
        };
        reader.readAsText(file);
    }

    closeAllModals() {
        this.categoryModal.style.display = 'none';
        this.bookmarkModal.style.display = 'none';
        this.importModal.style.display = 'none';
    }

    updateStats() {
        const stats = this.manager.getStats();
        this.categoryCountEl.textContent = stats.categoryCount;
        this.bookmarkCountEl.textContent = stats.bookmarkCount;
    }

    showNotification(message, type = 'info') {
        // 既存の通知を削除
        const existing = document.querySelector('.notification');
        if (existing) {
            existing.remove();
        }

        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#2196F3'};
            color: white;
            border-radius: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10000;
            animation: slideIn 0.3s ease;
            font-weight: 600;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    copyUrl(url) {
        navigator.clipboard.writeText(url).then(() => {
            this.showNotification('URLをコピーしました！', 'success');
        }).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = url;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                this.showNotification('URLをコピーしました！', 'success');
            } catch (err) {
                this.showNotification('コピーに失敗しました', 'error');
            }
            document.body.removeChild(textarea);
        });
    }

    handleCategoryDragStart(e, index) {
        e.stopPropagation();
        this.draggedCategoryIndex = index;
        e.target.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
    }

    handleCategoryDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    handleCategoryDrop(e, targetIndex) {
        e.preventDefault();
        e.stopPropagation();
        
        if (this.draggedCategoryIndex !== undefined && this.draggedCategoryIndex !== targetIndex) {
            const categories = this.manager.categories;
            const draggedCategory = categories[this.draggedCategoryIndex];
            categories.splice(this.draggedCategoryIndex, 1);
            categories.splice(targetIndex, 0, draggedCategory);
            this.manager.saveData();
            this.render();
            this.showNotification('カテゴリーを移動しました', 'success');
        }
        return false;
    }

    handleBookmarkDragStart(e, categoryId, index) {
        e.stopPropagation();
        this.draggedBookmark = { categoryId, index };
        e.target.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
    }

    handleBookmarkDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    handleBookmarkDrop(e, categoryId, targetIndex) {
        e.preventDefault();
        e.stopPropagation();
        
        if (this.draggedBookmark && this.draggedBookmark.categoryId === categoryId) {
            const sourceIndex = this.draggedBookmark.index;
            if (sourceIndex !== targetIndex) {
                const category = this.manager.categories.find(c => c.id === categoryId);
                if (category) {
                    const bookmark = category.bookmarks[sourceIndex];
                    category.bookmarks.splice(sourceIndex, 1);
                    category.bookmarks.splice(targetIndex, 0, bookmark);
                    this.manager.saveData();
                    this.render();
                    this.showNotification('ブックマークを移動しました', 'success');
                }
            }
        }
        return false;
    }

    handleDragEnd(e) {
        e.target.style.opacity = '1';
        this.draggedCategoryIndex = undefined;
        this.draggedBookmark = undefined;
    }
}

// アニメーション用CSS追加
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// アプリケーション初期化
const authManager = new AuthManager();
const bookmarkManager = new BookmarkManager();
const ui = new UIManager(bookmarkManager, authManager);

// グローバルからアクセス可能に
window.ui = ui;
window.authManager = authManager;
