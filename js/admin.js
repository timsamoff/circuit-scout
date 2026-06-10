/*
 * ============================================================================
 * Circuit Scout - Admin Dashboard
 * Version 1.0.0
 * Designed & Developed by Tim Samoff
 * 
 * A DIY guitar pedal circuit database and search tool
 * 
 * Features: RSS feed management, circuit editor, lazy loading, filtering
 * 
 * @license MIT
 * @see https://samoff.com/circuit-scout
 * ============================================================================
 */

const API_BASE = '/api';

// Pagination state
let currentPage = 1;
let totalPages = 1;
let isLoading = false;
let hasMore = true;
let totalResults = 0;
let statusInterval = null;

let filterState = {
    search: '',
    type: '',
    difficulty: '',
    category: 'all',
    verified: 'all'
};

// DOM Elements
const circuitsContainer = document.getElementById('admin-circuits-list');
const loadingTrigger = document.getElementById('admin-loading-trigger');
const searchInput = document.getElementById('admin-search-input');
const typeSelect = document.getElementById('admin-type-select');
const difficultySelect = document.getElementById('admin-difficulty-select');
const categoryAllBtn = document.getElementById('admin-category-all-btn');
const categoryCircuitBtn = document.getElementById('admin-category-circuit-btn');
const categoryReferenceBtn = document.getElementById('admin-category-reference-btn');
const verifiedAllBtn = document.getElementById('admin-verified-all-btn');
const verifiedOnlyBtn = document.getElementById('admin-verified-only-btn');
const unverifiedOnlyBtn = document.getElementById('admin-unverified-only-btn');
const resetFiltersBtn = document.getElementById('admin-reset-filters');

// ========== SCRAPER STATUS POLLING ==========
async function checkScraperStatus() {
    try {
        const res = await fetch(`${API_BASE}/scrape/status`);
        const status = await res.json();
        
        const statusBar = document.getElementById('scraper-status-bar');
        const statusText = document.getElementById('scraper-status-text');
        const cancelBtn = document.getElementById('scraper-cancel-btn');
        const runBtn = document.getElementById('run-scraper-btn');
        
        if (status.running) {
            // Show status bar
            if (statusBar) statusBar.style.display = 'flex';
            if (statusText) {
                const elapsed = status.startTime ? Math.floor((Date.now() - status.startTime) / 1000) : 0;
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                let statusMsg = `${status.currentFeed || 'Initializing'} - Page ${status.currentPage || 0} - ${status.itemsAdded} added (${minutes}:${seconds.toString().padStart(2, '0')})`;
                if (status.error === 'Cancelled by user') {
                    statusMsg = 'Cancelled by user';
                }
                statusText.innerHTML = statusMsg;
            }
            if (cancelBtn) cancelBtn.disabled = false;
            if (runBtn) runBtn.disabled = true;
        } else {
            // Hide status bar when not running
            if (statusBar && statusBar.style.display !== 'none') {
                statusBar.style.display = 'none';
                if (statusInterval) {
                    clearInterval(statusInterval);
                    statusInterval = null;
                }
                // Re-enable run button
                if (runBtn) runBtn.disabled = false;
                // Refresh data when scraper stops
                resetAndReload();
                loadStats();
                loadFeeds();
                
                // Show completion message if it wasn't an error
                if (status.error === 'Cancelled by user') {
                    await showAlert('Scraping cancelled by user.', 'Cancelled');
                } else if (status.itemsAdded > 0 || status.itemsSkipped > 0) {
                    await showAlert(`Scraping complete!\n\nAdded: ${status.itemsAdded} circuits\nSkipped: ${status.itemsSkipped} duplicates`, 'Complete');
                }
            }
        }
    } catch (err) {
        console.error("Status check error:", err);
    }
}

function startStatusPolling() {
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(checkScraperStatus, 2000);
}

// ========== COLLAPSIBLE SECTIONS ==========
function initCollapsible() {
    const collapsibles = document.querySelectorAll('.collapsible');
    
    collapsibles.forEach(collapsible => {
        const header = collapsible.querySelector('.card-header');
        const collapseBtn = collapsible.querySelector('.collapse-btn');
        const content = collapsible.querySelector('.card-content');
        
        if (!header || !content) return;
        
        const toggleCollapse = (e) => {
            e.stopPropagation();
            collapsible.classList.toggle('collapsed');
        };
        
        header.addEventListener('click', toggleCollapse);
        
        if (collapseBtn) {
            collapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                collapsible.classList.toggle('collapsed');
            });
        }
    });
}

// ========== LAZY LOADING ==========
async function loadMoreCircuits(reset = false) {
    if (isLoading) return;
    if (!reset && !hasMore) return;
    
    if (reset) {
        currentPage = 1;
        hasMore = true;
        if (circuitsContainer) circuitsContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-pulse"></i> Loading circuits...</div>';
        if (loadingTrigger) loadingTrigger.style.display = 'block';
    }
    
    isLoading = true;
    
    try {
        const params = new URLSearchParams({
            page: currentPage,
            limit: 20,
            search: filterState.search,
            category: filterState.category !== 'all' ? filterState.category : '',
            verified: filterState.verified === 'verified' ? 'true' : 
                     filterState.verified === 'unverified' ? 'false' : ''
        });
        
        if (filterState.type) params.append('type', filterState.type);
        if (filterState.difficulty) params.append('difficulty', filterState.difficulty);
        
        const response = await fetch(`${API_BASE}/circuits?${params}`);
        const data = await response.json();
        
        totalResults = data.total;
        
        renderCircuitsList(data.circuits, !reset);
        
        totalPages = data.totalPages;
        hasMore = currentPage < totalPages;
        currentPage++;
        
        if (loadingTrigger && !hasMore) loadingTrigger.style.display = 'none';
        
    } catch (error) {
        console.error('Failed to load circuits:', error);
        if (circuitsContainer && reset) {
            circuitsContainer.innerHTML = '<div class="loading">Error loading circuits. Make sure the server is running.</div>';
        }
    } finally {
        isLoading = false;
    }
}

function resetAndReload() {
    loadMoreCircuits(true);
}

function setupInfiniteScroll() {
    if (!loadingTrigger) return;
    
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !isLoading && hasMore) {
            loadMoreCircuits(false);
        }
    }, { threshold: 0.1, rootMargin: '100px' });
    
    observer.observe(loadingTrigger);
}

function renderCircuitsList(circuits, append = false) {
    if (!circuitsContainer) return;
    
    if (!circuits.length && !append) {
        circuitsContainer.innerHTML = '<div class="loading">No circuits found. Run the scraper or add one manually!</div>';
        return;
    }
    
    const html = circuits.map(circuit => {
        let categoryBadge = '';
        switch (circuit.category) {
            case 'reference':
                categoryBadge = '<span class="category-badge-small reference">Reference</span>';
                break;
            default:
                categoryBadge = '<span class="category-badge-small circuit">Circuit</span>';
        }
        
        let verificationBadge = circuit.verified ? 
            '<span class="verified-badge-small">Verified</span>' : 
            '<span class="unverified-badge-small">Unverified</span>';
        
        return `
        <div class="admin-circuit-item" data-id="${circuit.id}">
            <div class="admin-circuit-info">
                <h4>${escapeHtml(circuit.effect_name || 'Untitled')} ${categoryBadge} ${verificationBadge}</h4>
                <p>${escapeHtml(circuit.type || 'No type')} | ${circuit.parts_count || '?'} parts | ${circuit.difficulty || 'Not set'}</p>
                <small>${circuit.url ? escapeHtml(circuit.url.substring(0, 60)) + '...' : ''}</small>
            </div>
            <div class="admin-circuit-actions">
                <button class="edit-btn" data-id="${circuit.id}"><i class="fas fa-edit"></i> Edit</button>
                <button class="delete-btn" data-id="${circuit.id}"><i class="fas fa-trash"></i> Delete</button>
            </div>
        </div>
    `}).join('');
    
    if (append) {
        circuitsContainer.insertAdjacentHTML('beforeend', html);
    } else {
        circuitsContainer.innerHTML = html;
    }
    
    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.removeEventListener('click', () => {});
        btn.addEventListener('click', () => editCircuit(btn.dataset.id));
    });
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.removeEventListener('click', () => {});
        btn.addEventListener('click', () => deleteCircuit(btn.dataset.id));
    });
}

// ========== FILTER UI ==========
function updateCategoryButtonsUI() {
    if (categoryAllBtn) categoryAllBtn.classList.toggle('active', filterState.category === 'all');
    if (categoryCircuitBtn) categoryCircuitBtn.classList.toggle('active', filterState.category === 'circuit');
    if (categoryReferenceBtn) categoryReferenceBtn.classList.toggle('active', filterState.category === 'reference');
}

function setCategory(category) {
    filterState.category = category;
    updateCategoryButtonsUI();
    resetAndReload();
}

function updateVerifiedButtonsUI() {
    if (verifiedAllBtn) verifiedAllBtn.classList.toggle('active', filterState.verified === 'all');
    if (verifiedOnlyBtn) verifiedOnlyBtn.classList.toggle('active', filterState.verified === 'verified');
    if (unverifiedOnlyBtn) unverifiedOnlyBtn.classList.toggle('active', filterState.verified === 'unverified');
}

function setVerified(verified) {
    filterState.verified = verified;
    updateVerifiedButtonsUI();
    resetAndReload();
}

// ========== LOAD FILTER OPTIONS ==========
// ========== LOAD FILTER OPTIONS ==========
async function loadFilterOptions() {
    try {
        const res = await fetch(`${API_BASE}/filters`);
        const filters = await res.json();
        
        // Sort difficulties in proper order: Beginner, Intermediate, Advanced, Expert
        const difficultyOrder = { 'Beginner': 1, 'Intermediate': 2, 'Advanced': 3, 'Expert': 4 };
        const sortedDifficulties = (filters.difficulties || []).sort((a, b) => (difficultyOrder[a] || 99) - (difficultyOrder[b] || 99));
        
        if (typeSelect) {
            typeSelect.innerHTML = '<option value="">All types</option>' + 
                (filters.types || []).sort().map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        }
        
        if (difficultySelect) {
            difficultySelect.innerHTML = '<option value="">Any level</option>' + 
                sortedDifficulties.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
        }
    } catch (error) {
        console.error('Failed to load filter options:', error);
    }
}

// ========== STATS AND FEEDS ==========
async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const stats = await res.json();
        const totalElem = document.getElementById('total-count');
        if (totalElem) totalElem.textContent = stats.total || 0;
    } catch (err) {
        const totalElem = document.getElementById('total-count');
        if (totalElem) totalElem.textContent = '?';
    }
}

async function loadFeeds() {
    try {
        const res = await fetch(`${API_BASE}/feeds`);
        const feeds = await res.json();
        const feedCountElem = document.getElementById('feed-count');
        if (feedCountElem) feedCountElem.textContent = feeds.length || 0;
        
        const container = document.getElementById('feeds-list');
        if (!container) return;
        
        if (!feeds.length) {
            container.innerHTML = '<div class="empty">No RSS feeds added yet. Add one above.</div>';
            return;
        }
        
        container.innerHTML = feeds.map(feed => `
            <div class="feed-item" data-id="${feed.id}">
                <div class="feed-info">
                    <strong>${escapeHtml(feed.name)}</strong>
                    <small>${escapeHtml(feed.blog_url || feed.url)}</small>
                    ${feed.last_scraped ? `<small>Last scraped: ${new Date(feed.last_scraped).toLocaleString()}</small>` : ''}
                </div>
                <div class="feed-actions">
                    <button class="toggle-feed-btn ${feed.enabled ? 'enabled' : 'disabled'}" data-id="${feed.id}">${feed.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="delete-feed-btn" data-id="${feed.id}"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `).join('');
        
        document.querySelectorAll('.toggle-feed-btn').forEach(btn => btn.addEventListener('click', () => toggleFeed(btn.dataset.id)));
        document.querySelectorAll('.delete-feed-btn').forEach(btn => btn.addEventListener('click', () => deleteFeed(btn.dataset.id)));
    } catch (err) { console.error(err); }
}

async function addFeed() {
    const url = document.getElementById('feed-url').value.trim();
    const name = document.getElementById('feed-name').value.trim();
    const label = document.getElementById('feed-label')?.value.trim() || null;
    if (!url) return showAlert('Please enter a URL', 'Error');
    
    const button = document.getElementById('add-feed-btn');
    const originalText = button.innerHTML;
    button.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Adding...';
    button.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/feeds`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, name, label })
        });
        const result = await res.json();
        if (res.ok) {
            document.getElementById('feed-url').value = '';
            document.getElementById('feed-name').value = '';
            if (document.getElementById('feed-label')) document.getElementById('feed-label').value = '';
            await loadFeeds();
            button.innerHTML = '<i class="fas fa-check"></i> Added!';
            
            // Force the status bar to appear immediately
            const statusBar = document.getElementById('scraper-status-bar');
            const statusText = document.getElementById('scraper-status-text');
            if (statusBar) {
                statusBar.style.display = 'flex';
                if (statusText) statusText.innerHTML = label ? `Starting scrape for "${label}" feed...` : 'Starting scrape for new feed...';
            }
            
            // Start polling for status
            startStatusPolling();
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            }, 2000);
            
        } else {
            button.innerHTML = originalText;
            button.disabled = false;
            await showAlert(result.error || 'Failed to add feed', 'Error');
        }
    } catch (err) {
        button.innerHTML = originalText;
        button.disabled = false;
        await showAlert('Failed to add feed: ' + err.message, 'Error');
    }
}

async function toggleFeed(id) {
    await fetch(`${API_BASE}/feeds/${id}/toggle`, { method: 'PATCH' });
    await loadFeeds();
}

async function deleteFeed(id) {
    const confirmed = await showConfirm('Remove this RSS feed?', 'Confirm');
    if (confirmed) {
        await fetch(`${API_BASE}/feeds/${id}`, { method: 'DELETE' });
        await loadFeeds();
        await showAlert('Feed removed', 'Deleted');
    }
}

async function addCircuit(data) {
    const res = await fetch(`${API_BASE}/circuits`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if (res.ok) {
        resetAndReload();
        loadStats();
        const form = document.getElementById('add-circuit-form');
        if (form) form.reset();
        await showAlert('Circuit saved!', 'Success');
    }
}

async function deleteCircuit(id) {
    if (await showConfirm('Delete this circuit?', 'Confirm')) {
        await fetch(`${API_BASE}/circuits/${id}`, { method: 'DELETE' });
        resetAndReload();
        loadStats();
        await showAlert('Circuit deleted', 'Deleted');
    }
}

async function editCircuit(id) {
    const response = await fetch(`${API_BASE}/circuits/${id}`);
    const circuit = await response.json();
    if (!circuit) return;
    const newName = await showPrompt('Edit circuit name:', circuit.effect_name, 'Edit Circuit');
    if (newName && newName.trim()) {
        circuit.effect_name = newName.trim();
        await fetch(`${API_BASE}/circuits/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(circuit)
        });
        resetAndReload();
        await showAlert('Circuit updated', 'Updated');
    }
}

async function cleanDuplicates() {
    const button = document.getElementById('cleanup-btn');
    if (!button) return;
    
    const originalText = button.innerHTML;
    button.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Cleaning...';
    button.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE}/cleanup`, { method: 'POST' });
        const result = await response.json();
        
        await showAlert(`Cleanup complete! Removed ${result.dbRemoved} from DB and ${result.jsonRemoved} from JSON.`, 'Success');
        
        resetAndReload();
        loadStats();
        
    } catch (err) {
        await showAlert('Cleanup failed: ' + err.message, 'Error');
    } finally {
        button.innerHTML = originalText;
        button.disabled = false;
    }
}

async function cancelScraper() {
    const cancelBtn = document.getElementById('scraper-cancel-btn');
    if (!cancelBtn) return;
    
    const originalIcon = cancelBtn.innerHTML;
    cancelBtn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i>';
    cancelBtn.disabled = true;
    
    try {
        console.log("Sending cancel request...");
        const response = await fetch(`${API_BASE}/scrape/cancel`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const text = await response.text();
            console.error("Cancel response not OK:", response.status, text);
            throw new Error(`HTTP ${response.status}`);
        }
        
        const result = await response.json();
        console.log("Cancel response:", result);
        
        // Update status text immediately
        const statusText = document.getElementById('scraper-status-text');
        if (statusText) {
            statusText.innerHTML = 'Cancelling...';
        }
        
        // Show a brief alert to confirm cancellation was requested
        await showAlert('Cancellation requested. The scraper will stop after the current page completes.', 'Cancelling');
        
    } catch (err) {
        console.error("Cancel error:", err);
        await showAlert('Cancel failed: ' + err.message, 'Error');
    } finally {
        cancelBtn.innerHTML = originalIcon;
        cancelBtn.disabled = false;
    }
}

async function runScraper() {
    const button = document.getElementById('run-scraper-btn');
    const originalText = button.innerHTML;
    
    // Check if scraper is already running
    try {
        const statusRes = await fetch(`${API_BASE}/scrape/status`);
        const status = await statusRes.json();
        if (status.running) {
            await showAlert('Scraper is already running! Check the status bar below.', 'Already Running');
            return;
        }
    } catch (err) {
        console.error("Status check failed:", err);
    }
    
    button.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Starting...';
    button.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/scrape`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({}) 
        });
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        
        button.innerHTML = '<i class="fas fa-check"></i> Started!';
        
        // Start polling for status
        startStatusPolling();
        
        setTimeout(() => {
            button.innerHTML = originalText;
            // Don't re-enable here - status check will re-enable when scraper stops
        }, 2000);
        
    } catch (err) {
        console.error("Scrape error:", err);
        button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Failed';
        setTimeout(() => {
            button.innerHTML = originalText;
            button.disabled = false;
        }, 2000);
        await showAlert('Scraping failed: ' + err.message, 'Error');
    }
}

// ========== MODAL FUNCTIONS ==========
function showConfirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return resolve(false);
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-message').textContent = message;
        overlay.style.display = 'flex';
        const confirm = () => { overlay.style.display = 'none'; cleanup(); resolve(true); };
        const cancel = () => { overlay.style.display = 'none'; cleanup(); resolve(false); };
        const cleanup = () => {
            document.getElementById('modal-confirm')?.removeEventListener('click', confirm);
            document.getElementById('modal-cancel')?.removeEventListener('click', cancel);
        };
        document.getElementById('modal-confirm')?.addEventListener('click', confirm);
        document.getElementById('modal-cancel')?.addEventListener('click', cancel);
    });
}

function showAlert(message, title = 'Notice') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('alert-modal');
        if (!overlay) return resolve();
        const titleElem = overlay.querySelector('.modal-title');
        if (titleElem) titleElem.textContent = title;
        document.getElementById('alert-message').textContent = message;
        overlay.style.display = 'flex';
        const ok = () => { overlay.style.display = 'none'; document.getElementById('alert-ok')?.removeEventListener('click', ok); resolve(); };
        document.getElementById('alert-ok')?.addEventListener('click', ok);
    });
}

function showPrompt(message, defaultValue = '', title = 'Enter value') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('prompt-modal');
        if (!overlay) return resolve(null);
        document.getElementById('prompt-title').textContent = title;
        document.getElementById('prompt-message').textContent = message;
        const input = document.getElementById('prompt-input');
        if (input) input.value = defaultValue;
        overlay.style.display = 'flex';
        if (input) input.focus();
        const confirm = () => { overlay.style.display = 'none'; cleanup(); resolve(input?.value || ''); };
        const cancel = () => { overlay.style.display = 'none'; cleanup(); resolve(null); };
        const cleanup = () => {
            document.getElementById('prompt-confirm')?.removeEventListener('click', confirm);
            document.getElementById('prompt-cancel')?.removeEventListener('click', cancel);
            if (input) input.removeEventListener('keypress', enter);
        };
        const enter = (e) => { if (e.key === 'Enter') confirm(); };
        document.getElementById('prompt-confirm')?.addEventListener('click', confirm);
        document.getElementById('prompt-cancel')?.addEventListener('click', cancel);
        if (input) input.addEventListener('keypress', enter);
    });
}

// ========== HELPER FUNCTIONS ==========
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// ========== EVENT LISTENERS ==========
document.getElementById('add-feed-form')?.addEventListener('submit', (e) => { e.preventDefault(); addFeed(); });
document.getElementById('add-circuit-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(t => t);
    addCircuit({
        url: document.getElementById('url').value,
        effect_name: document.getElementById('effect_name').value,
        type: document.getElementById('type').value,
        parts_count: parseInt(document.getElementById('parts_count').value) || null,
        difficulty: document.getElementById('difficulty').value,
        tags: tags,
        category: document.getElementById('category').value,
        verified: document.getElementById('verified').value === 'true',
        image_url: document.getElementById('image_url').value || null
    });
});
document.getElementById('run-scraper-btn')?.addEventListener('click', runScraper);
document.getElementById('cleanup-btn')?.addEventListener('click', cleanDuplicates);

// Cancel button on status bar
document.getElementById('scraper-cancel-btn')?.addEventListener('click', cancelScraper);

// Refresh button on status bar
document.getElementById('scraper-refresh-btn')?.addEventListener('click', () => {
    resetAndReload();
    loadStats();
    loadFeeds();
});

// Filter event listeners
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        filterState.search = e.target.value;
        resetAndReload();
    });
}

if (typeSelect) {
    typeSelect.addEventListener('change', (e) => {
        filterState.type = e.target.value;
        resetAndReload();
    });
}

if (difficultySelect) {
    difficultySelect.addEventListener('change', (e) => {
        filterState.difficulty = e.target.value;
        resetAndReload();
    });
}

if (categoryAllBtn) categoryAllBtn.addEventListener('click', () => setCategory('all'));
if (categoryCircuitBtn) categoryCircuitBtn.addEventListener('click', () => setCategory('circuit'));
if (categoryReferenceBtn) categoryReferenceBtn.addEventListener('click', () => setCategory('reference'));

if (verifiedAllBtn) verifiedAllBtn.addEventListener('click', () => setVerified('all'));
if (verifiedOnlyBtn) verifiedOnlyBtn.addEventListener('click', () => setVerified('verified'));
if (unverifiedOnlyBtn) unverifiedOnlyBtn.addEventListener('click', () => setVerified('unverified'));

if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener('click', () => {
        filterState = {
            search: '',
            type: '',
            difficulty: '',
            category: 'all',
            verified: 'all'
        };
        if (searchInput) searchInput.value = '';
        if (typeSelect) typeSelect.value = '';
        if (difficultySelect) difficultySelect.value = '';
        updateCategoryButtonsUI();
        updateVerifiedButtonsUI();
        resetAndReload();
    });
}

// ========== INITIALIZE ==========
loadFilterOptions();
loadStats();
loadFeeds();
initCollapsible();
setupInfiniteScroll();
resetAndReload();

// Start status polling on page load
startStatusPolling();