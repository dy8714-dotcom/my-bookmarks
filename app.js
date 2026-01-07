// シンプル認証マネージャー（Firebaseなし）
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

        const userId = this.generateUserId(username);
        const passwordHash = await this.hashPassword(password);

        // ローカルストレージで確認
        const existingUser = localStorage.getItem(`auth_${userId}`);
        if (existingUser) {
            throw new Error('このユーザー名は既に使用されています');
        }

        // ユーザー情報を保存
        const userData = {
            username: username,
            passwordHash: passwordHash,
            createdAt: Date.now()
        };

        localStorage.setItem(`auth_${userId}`, JSON.stringify(userData));
        localStorage.setItem('currentUserId', userId);
        this.currentUser = username;

        return true;
    }

    async login(username, password) {
        if (!username || !password) {
            throw new Error('ユーザー名とパスワードを入力してください');
        }

        const userId = this.generateUserId(username);
        const userDataStr = localStorage.getItem(`auth_${userId}`);

        if (!userDataStr) {
            throw new Error('ユーザー名またはパスワードが間違っています');
        }

        const userData = JSON.parse(userDataStr);
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

// ブックマークマネージャー
class BookmarkManager {
    constructor() {
        this.data = { categories: [] };
        this.loadData();
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    loadData() {
        const userId = localStorage.getItem('currentUserId');
        if (!userId) return;

        const dataStr = localStorage.getItem(`bookmarkData_${userId}`);
        if (dataStr) {
            try {
                this.data = JSON.parse(dataStr);
            } catch (e) {
                console.error('データの読み込みに失敗しました:', e);
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
                            {
                                id: this.generateId(),
                                name: 'YouTube',
                                url: 'https://www.youtube.com',
                                description: '動画サイト'
                            }
                        ]
                    },
                    {
                        id: this.generateId(),
                        name: 'プライベート',
                        color: '#2196F3',
                        bookmarks: [
                            {
                                id: this.generateId(),
                                name: 'Gmail',
                                url: 'https://mail.google.com',
                                description: 'メール'
                            }
                        ]
                    }
                ]
            };
        }
        this.saveData();
    }

    saveData() {
        const userId = localStorage.getItem('currentUserId');
        if (!userId) return;

        localStorage.setItem(`bookmarkData_${userId}`, JSON.stringify(this.data));
    }

    // カテゴリー操作
    addCategory(name, color) {
        const category = {
            id: this.generateId(),
            name: name,
            color: color || '#4CAF50',
            bookmarks: []
        };
        this.data.categories.push(category);
        this.saveData();
        return category;
    }

    updateCategory(categoryId, name, color) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            category.name = name;
            category.color = color;
            this.saveData();
        }
    }

    deleteCategory(categoryId) {
        this.data.categories = this.data.categories.filter(c => c.id !== categoryId);
        this.saveData();
    }

    // ブックマーク操作
    addBookmark(categoryId, name, url, description) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
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
    }

    updateBookmark(categoryId, bookmarkId, name, url, description) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            const bookmark = category.bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) {
                bookmark.name = name;
                bookmark.url = url;
                bookmark.description = description || '';
                this.saveData();
            }
        }
    }

    deleteBookmark(categoryId, bookmarkId) {
        const category = this.data.categories.find(c => c.id === categoryId);
        if (category) {
            category.bookmarks = category.bookmarks.filter(b => b.id !== bookmarkId);
            this.saveData();
        }
    }

    // エクスポート/インポート
    exportData() {
        const dataStr = JSON.stringify(this.data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bookmarks_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    importData(jsonData) {
        try {
            if (Array.isArray(jsonData)) {
                // 古い形式
                this.data = { categories: jsonData };
            } else {
                this.data = jsonData;
            }
            this.saveData();
            return true;
        } catch (e) {
            console.error('インポートエラー:', e);
            return false;
        }
    }
}

// UIマネージャー
class UIManager {
    constructor(authManager, bookmarkManager) {
        this.authManager = authManager;
        this.manager = bookmarkManager;
        this.currentCategoryId = null;
        this.currentBookmarkId = null;

        this.initElements();
        this.initEventListeners();

        if (this.authManager.isLoggedIn()) {
            this.showApp();
        }
    }

    initElements() {
        // ログイン画面
        this.loginScreen = document.getElementById('loginScreen');
        this.loginForm = document.getElementById('loginForm');
        this.registerForm = document.getElementById('registerForm');
        
        // ログインフォーム
        this.loginUsername = document.getElementById('loginUsername');
        this.loginPassword = document.getElementById('loginPassword');
        this.loginBtn = document.getElementById('loginBtn');
        this.showRegisterBtn = document.getElementById('showRegisterBtn');
        
        // 登録フォーム
        this.registerUsername = document.getElementById('registerUsername');
        this.registerPassword = document.getElementById('registerPassword');
        this.registerConfirmPassword = document.getElementById('registerConfirmPassword');
        this.registerBtn = document.getElementById('registerBtn');
        this.showLoginBtn = document.getElementById('showLoginBtn');

        // アプリ画面
        this.appScreen = document.getElementById('appScreen');
        this.currentUserEl = document.getElementById('currentUser');
        this.logoutBtn = document.getElementById('logoutBtn');
        this.mainContent = document.getElementById('mainContent');

        // コントロール
        this.addCategoryBtn = document.getElementById('addCategoryBtn');
        this.exportBtn = document.getElementById('exportBtn');
        this.importBtn = document.getElementById('importBtn');

        // モーダル
        this.categoryModal = document.getElementById('categoryModal');
        this.bookmarkModal = document.getElementById('bookmarkModal');
        this.importModal = document.getElementById('importModal');
    }

    initEventListeners() {
        // ログイン
        this.loginBtn.addEventListener('click', () => this.handleLogin());
        this.loginPassword.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });

        // 登録
        this.registerBtn.addEventListener('click', () => this.handleRegister());
        this.showRegisterBtn.addEventListener('click', () => this.showRegisterForm());
        this.showLoginBtn.addEventListener('click', () => this.showLoginForm());

        // ログアウト
        this.logoutBtn.addEventListener('click', () => this.handleLogout());

        // コントロール
        this.addCategoryBtn.addEventListener('click', () => this.openCategoryModal());
        this.exportBtn.addEventListener('click', () => {
            this.manager.exportData();
            this.showNotification('データをエクスポートしました！');
        });
        this.importBtn.addEventListener('click', () => this.openImportModal());

        // モーダルclose
        document.querySelectorAll('.modal .close').forEach(closeBtn => {
            closeBtn.addEventListener('click', () => this.closeAllModals());
        });

        document.getElementById('saveCategoryBtn').addEventListener('click', () => this.saveCategory());
        document.getElementById('cancelCategoryBtn').addEventListener('click', () => this.closeAllModals());
        document.getElementById('saveBookmarkBtn').addEventListener('click', () => this.saveBookmark());
        document.getElementById('cancelBookmarkBtn').addEventListener('click', () => this.closeAllModals());
        document.getElementById('confirmImportBtn').addEventListener('click', () => this.handleImport());
        document.getElementById('cancelImportBtn').addEventListener('click', () => this.closeAllModals());
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
        const username = this.registerUsername.value.trim();
        const password = this.registerPassword.value;
        const confirmPassword = this.registerConfirmPassword.value;

        if (password !== confirmPassword) {
            alert('パスワードが一致しません');
            return;
        }

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
        this.loginForm.style.display = 'block';
        this.registerForm.style.display = 'none';
    }

    showRegisterForm() {
        this.loginForm.style.display = 'none';
        this.registerForm.style.display = 'block';
    }

    showApp() {
        this.loginScreen.style.display = 'none';
        this.appScreen.style.display = 'block';
        this.currentUserEl.textContent = `👤 ${this.authManager.currentUser}`;
        this.renderCategories();
    }

    renderCategories() {
        this.mainContent.innerHTML = '';
        
        if (this.manager.data.categories.length === 0) {
            this.mainContent.innerHTML = '<p class="empty-message">カテゴリーがありません。「カテゴリー追加」ボタンから追加してください。</p>';
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'category-grid';

        this.manager.data.categories.forEach(category => {
            const card = this.createCategoryCard(category);
            grid.appendChild(card);
        });

        this.mainContent.appendChild(grid);
    }

    createCategoryCard(category) {
        const card = document.createElement('div');
        card.className = 'category-card';
        card.innerHTML = `
            <div class="category-header" style="background-color: ${category.color};">
                <h3>${category.name}</h3>
                <div class="category-actions">
                    <button class="icon-btn add-bookmark" data-id="${category.id}" title="ブックマーク追加">➕</button>
                    <button class="icon-btn edit-category" data-id="${category.id}" title="編集">✏️</button>
                    <button class="icon-btn delete-category" data-id="${category.id}" title="削除">🗑️</button>
                </div>
            </div>
            <div class="category-body">
                ${category.bookmarks.map(bookmark => `
                    <div class="bookmark-item">
                        <a href="${bookmark.url}" target="_blank" class="bookmark-link">${bookmark.name}</a>
                        <div class="bookmark-actions">
                            <button class="icon-btn edit-bookmark" data-category-id="${category.id}" data-id="${bookmark.id}">✏️</button>
                            <button class="icon-btn delete-bookmark" data-category-id="${category.id}" data-id="${bookmark.id}">🗑️</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        // イベントリスナー
        card.querySelector('.add-bookmark').addEventListener('click', (e) => {
            this.openBookmarkModal(e.target.dataset.id);
        });
        
        card.querySelector('.edit-category').addEventListener('click', (e) => {
            this.openCategoryModal(e.target.dataset.id);
        });
        
        card.querySelector('.delete-category').addEventListener('click', (e) => {
            if (confirm('このカテゴリーを削除しますか？')) {
                this.manager.deleteCategory(e.target.dataset.id);
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
            btn.addEventListener('click', (e) => {
                if (confirm('このブックマークを削除しますか？')) {
                    this.manager.deleteBookmark(e.target.dataset.categoryId, e.target.dataset.id);
                    this.renderCategories();
                    this.showNotification('ブックマークを削除しました');
                }
            });
        });

        return card;
    }

    openCategoryModal(categoryId = null) {
        this.currentCategoryId = categoryId;
        
        const nameInput = document.getElementById('categoryNameInput');
        const colorInput = document.getElementById('categoryColorInput');
        const title = document.getElementById('categoryModalTitle');

        if (categoryId) {
            const category = this.manager.data.categories.find(c => c.id === categoryId);
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

        this.categoryModal.classList.add('active');
    }

    saveCategory() {
        const name = document.getElementById('categoryNameInput').value.trim();
        const color = document.getElementById('categoryColorInput').value;

        if (!name) {
            alert('カテゴリー名を入力してください');
            return;
        }

        if (this.currentCategoryId) {
            this.manager.updateCategory(this.currentCategoryId, name, color);
            this.showNotification('カテゴリーを更新しました');
        } else {
            this.manager.addCategory(name, color);
            this.showNotification('カテゴリーを追加しました');
        }

        this.closeAllModals();
        this.renderCategories();
    }

    openBookmarkModal(categoryId, bookmarkId = null) {
        this.currentCategoryId = categoryId;
        this.currentBookmarkId = bookmarkId;

        const title = document.getElementById('bookmarkModalTitle');
        const nameInput = document.getElementById('bookmarkNameInput');
        const urlInput = document.getElementById('bookmarkUrlInput');
        const descInput = document.getElementById('bookmarkDescInput');

        if (bookmarkId) {
            const category = this.manager.data.categories.find(c => c.id === categoryId);
            const bookmark = category.bookmarks.find(b => b.id === bookmarkId);
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

        this.bookmarkModal.classList.add('active');
    }

    saveBookmark() {
        const name = document.getElementById('bookmarkNameInput').value.trim();
        const url = document.getElementById('bookmarkUrlInput').value.trim();
        const description = document.getElementById('bookmarkDescInput').value.trim();

        if (!name || !url) {
            alert('サイト名とURLを入力してください');
            return;
        }

        if (this.currentBookmarkId) {
            this.manager.updateBookmark(this.currentCategoryId, this.currentBookmarkId, name, url, description);
            this.showNotification('ブックマークを更新しました');
        } else {
            this.manager.addBookmark(this.currentCategoryId, name, url, description);
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

        if (!file) {
            alert('ファイルを選択してください');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (this.manager.importData(data)) {
                    this.showNotification('データをインポートしました！');
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

    showNotification(message) {
        alert(message);
    }
}

// アプリ初期化
document.addEventListener('DOMContentLoaded', () => {
    const authManager = new SimpleAuthManager();
    const bookmarkManager = new BookmarkManager();
    const ui = new UIManager(authManager, bookmarkManager);
});
