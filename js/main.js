/*
 * ============================================================================
 * Circuit Scout - Public User Interface
 * Version 1.0.0
 * Designed & Developed by Tim Samoff
 * 
 * A DIY guitar pedal circuit database and search tool
 * 
 * Features: Lazy loading, favorites, dark/light mode, advanced filtering
 * 
 * @license MIT
 * @see https://samoff.com/circuit-scout
 * ============================================================================
 */

// Detect if running locally or on GitHub Pages
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE = isLocalhost ? 'http://localhost:3000/api' : '/data';

// Pagination state
let currentPage = 1;
let totalPages = 1;
let isLoading = false;
let hasMore = true;
let totalResults = 0;
let allCircuitsCache = null; // Cache for static JSON mode
let filteredCircuitsCache = null; // Cache for filtered results

let filterState = {
    search: '',
    type: '',
    difficulty: '',
    category: 'all',
    verified: 'all',
    favorites: false
};

// DOM Elements
const resultsGrid = document.getElementById('results-grid');
const loadingTrigger = document.getElementById('loading-trigger');
const searchInput = document.getElementById('search-input');
const typeSelect = document.getElementById('type-select');
const difficultySelect = document.getElementById('difficulty-select');
const categoryAllBtn = document.getElementById('category-all-btn');
const categoryCircuitBtn = document.getElementById('category-circuit-btn');
const categoryReferenceBtn = document.getElementById('category-reference-btn');
const verifiedAllBtn = document.getElementById('verified-all-btn');
const verifiedOnlyBtn = document.getElementById('verified-only-btn');
const unverifiedOnlyBtn = document.getElementById('unverified-only-btn');
const resetFiltersBtn = document.getElementById('reset-filters');
const favFilterBtn = document.getElementById('fav-filter-btn');
const themeToggle = document.getElementById('theme-toggle');
const resultCountSpan = document.getElementById('result-count');

// Favorites state - stored by circuit ID (as numbers)
// Clean up any NaN values when loading
let rawFavorites = JSON.parse(localStorage.getItem('circuitScoutFavorites') || '[]');
let favorites = new Set(rawFavorites.filter(id => !isNaN(id) && id !== null && id !== undefined).map(id => parseInt(id)));

// If we removed any NaN values, save the cleaned set back to localStorage
if (rawFavorites.length !== favorites.size) {
    console.log('Cleaned up NaN values from favorites. Old:', rawFavorites, 'New:', [...favorites]);
    localStorage.setItem('circuitScoutFavorites', JSON.stringify([...favorites]));
}

console.log('Loaded favorites:', [...favorites]);

// ========== HELPER FUNCTIONS ==========

// Fisher-Yates shuffle algorithm for randomness
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
}

// ========== DARK MODE ==========
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light-mode') {
        document.body.classList.remove('dark-mode');
        document.body.classList.add('light-mode');
        if (themeToggle) themeToggle.innerHTML = '<i class="fas fa-moon"></i> Dark Mode';
    } else {
        document.body.classList.add('dark-mode');
        document.body.classList.remove('light-mode');
        if (themeToggle) themeToggle.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
    }
}

function toggleTheme() {
    if (document.body.classList.contains('dark-mode')) {
        document.body.classList.remove('dark-mode');
        document.body.classList.add('light-mode');
        localStorage.setItem('theme', 'light-mode');
        if (themeToggle) themeToggle.innerHTML = '<i class="fas fa-moon"></i> Dark Mode';
    } else {
        document.body.classList.remove('light-mode');
        document.body.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark-mode');
        if (themeToggle) themeToggle.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
    }
}

// ========== FAVORITES MODAL ==========
function showFavoritesModal() {
    const existingModal = document.querySelector('.favorites-modal-overlay');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.className = 'favorites-modal-overlay';
    modal.innerHTML = `
        <div class="favorites-modal">
            <i class="far fa-star"></i>
            <h3>No Favorites Yet</h3>
            <p>Click the star icon on any circuit to add it to your favorites!</p>
            <button onclick="this.closest('.favorites-modal-overlay').remove()">Got it!</button>
        </div>
    `;
    document.body.appendChild(modal);
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// ========== APPLY ALL FILTERS ==========
function applyAllFilters(circuits) {
    let filtered = [...circuits];
    
    // Filter out ignored circuits
    filtered = filtered.filter(c => !c.ignored);
    
    // Search filter
    if (filterState.search) {
        const searchLower = filterState.search.toLowerCase();
        filtered = filtered.filter(c => 
            c.effect_name?.toLowerCase().includes(searchLower) ||
            c.type?.toLowerCase().includes(searchLower) ||
            c.tags?.some(t => t.toLowerCase().includes(searchLower))
        );
    }
    
    // Type filter
    if (filterState.type) {
        filtered = filtered.filter(c => c.type === filterState.type);
    }
    
    // Difficulty filter
    if (filterState.difficulty) {
        filtered = filtered.filter(c => c.difficulty === filterState.difficulty);
    }
    
    // Category filter
    if (filterState.category !== 'all') {
        filtered = filtered.filter(c => c.category === filterState.category);
    }
    
    // Verified filter
    if (filterState.verified === 'verified') {
        filtered = filtered.filter(c => c.verified === true);
    } else if (filterState.verified === 'unverified') {
        filtered = filtered.filter(c => c.verified === false);
    }
    
    // Favorites filter - ensure ID comparison works
    if (filterState.favorites) {
        console.log('Filtering by favorites. Favorites set:', [...favorites]);
        console.log('Before filter count:', filtered.length);
        
        filtered = filtered.filter(c => {
            const circuitId = parseInt(c.id);
            // Only include if circuitId is valid and in favorites
            return !isNaN(circuitId) && favorites.has(circuitId);
        });
        
        console.log('After filter count:', filtered.length);
        
        // When showing favorites, sort them by ID to maintain consistent order
        filtered.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    } else {
        // Only shuffle when not filtering by favorites
        filtered = shuffleArray(filtered);
    }
    
    return filtered;
}

// ========== LOAD CIRCUITS ==========
async function loadCircuitsFromJSON() {
    try {
        const paths = [
            '/data/circuits.json',
            'data/circuits.json',
            './data/circuits.json',
            '../data/circuits.json'
        ];
        
        let lastError = null;
        
        for (const path of paths) {
            try {
                console.log(`Trying to load from: ${path}`);
                const response = await fetch(path);
                if (response.ok) {
                    const data = await response.json();
                    console.log(`Successfully loaded ${data.length} circuits from ${path}`);
                    
                    // Debug: Check first few circuits for ID field
                    if (data.length > 0) {
                        console.log('Sample circuit from JSON:', data[0]);
                        console.log('ID type:', typeof data[0].id, 'Value:', data[0].id);
                    }
                    
                    return data;
                } else {
                    lastError = `HTTP ${response.status} for ${path}`;
                }
            } catch (e) {
                lastError = e.message;
                continue;
            }
        }
        
        throw new Error(`Could not load circuits.json. Tried multiple paths. Last error: ${lastError}`);
        
    } catch (error) {
        console.error('Failed to load JSON:', error);
        throw error;
    }
}

async function loadMoreCircuits(reset = false) {
    if (isLoading) return;
    if (!reset && !hasMore) return;
    
    if (reset) {
        currentPage = 1;
        hasMore = true;
        filteredCircuitsCache = null; // Clear filter cache on reset
        if (resultsGrid) resultsGrid.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-pulse"></i> Loading circuits...</div>';
        if (loadingTrigger) loadingTrigger.style.display = 'block';
    }
    
    isLoading = true;
    
    try {
        let circuits = [];
        
        if (isLocalhost) {
            // Use API when running locally - public endpoint (excludes ignored circuits)
            const params = new URLSearchParams({
                page: currentPage,
                limit: 20,
                search: filterState.search,
                type: filterState.type,
                difficulty: filterState.difficulty,
                category: filterState.category !== 'all' ? filterState.category : '',
                verified: filterState.verified === 'verified' ? 'true' : 
                         filterState.verified === 'unverified' ? 'false' : ''
            });
            
            for (const [key, value] of params.entries()) {
                if (!value) params.delete(key);
            }
            
            const response = await fetch(`${API_BASE}/circuits?${params}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            let filteredData = data.circuits;
            
            // Apply favorites filter client-side for API mode
            if (filterState.favorites) {
                filteredData = filteredData.filter(c => {
                    const circuitId = parseInt(c.id);
                    return !isNaN(circuitId) && favorites.has(circuitId);
                });
                totalResults = filteredData.length;
                totalPages = Math.ceil(totalResults / 20);
                
                // Sort favorites by ID
                filteredData.sort((a, b) => parseInt(a.id) - parseInt(b.id));
                const start = (currentPage - 1) * 20;
                circuits = filteredData.slice(start, start + 20);
                hasMore = currentPage < totalPages;
            } else {
                // Shuffle for random order
                circuits = shuffleArray(filteredData);
                totalResults = data.total;
                totalPages = data.totalPages;
                hasMore = currentPage < totalPages;
            }
        } else {
            // Use static JSON on GitHub Pages
            if (!allCircuitsCache) {
                allCircuitsCache = await loadCircuitsFromJSON();
            }
            
            // Apply filters and get cached results if available
            if (!filteredCircuitsCache || reset) {
                filteredCircuitsCache = applyAllFilters(allCircuitsCache);
                totalResults = filteredCircuitsCache.length;
                totalPages = Math.ceil(totalResults / 20);
                console.log(`Filtered ${totalResults} circuits from ${allCircuitsCache.length} total`);
            }
            
            const start = (currentPage - 1) * 20;
            circuits = filteredCircuitsCache.slice(start, start + 20);
            hasMore = currentPage < totalPages;
        }
        
        renderCircuitsList(circuits, !reset);
        
        if (hasMore) {
            currentPage++;
            if (loadingTrigger) loadingTrigger.style.display = 'block';
        } else {
            if (loadingTrigger) loadingTrigger.style.display = 'none';
        }
        
        if (resultCountSpan) resultCountSpan.textContent = `${totalResults} found`;
        
    } catch (error) {
        console.error('Failed to load circuits:', error);
        if (resultsGrid && reset) {
            resultsGrid.innerHTML = `<div class="error-state" style="text-align: center; grid-column: 1 / -1; padding: 3rem;">
                <i class="fas fa-exclamation-triangle" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">Error loading circuits</p>
                <p style="color: var(--text-muted);">${error.message}</p>
                <p style="color: var(--text-muted); margin-top: 1rem; font-size: 0.875rem;">
                    ${isLocalhost ? 'Make sure the server is running on port 3000.' : 'Make sure data/circuits.json exists in the data folder.'}
                </p>
                <button onclick="location.reload()" class="btn-secondary" style="margin-top: 1rem; width: auto; padding: 0.5rem 1rem;">
                    <i class="fas fa-sync-alt"></i> Retry
                </button>
            </div>`;
        }
        if (loadingTrigger) loadingTrigger.style.display = 'none';
    } finally {
        isLoading = false;
    }
}

function resetAndReload() {
    filteredCircuitsCache = null; // Clear cache
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
    if (!resultsGrid) return;
    
    if (!circuits.length && !append) {
        resultsGrid.innerHTML = '<div class="empty-state" style="text-align: center; grid-column: 1 / -1; padding: 3rem;"><i class="fas fa-search" style="font-size: 2rem; margin-bottom: 1rem; display: block; opacity: 0.5;"></i><p>No circuits found. Try adjusting your filters.</p></div>';
        return;
    }
    
    const html = circuits.map(circuit => {
        const circuitId = parseInt(circuit.id);
        const isStarred = !isNaN(circuitId) && favorites.has(circuitId);
        const categoryClass = circuit.category === 'reference' ? 'reference' : 'circuit';
        const verifiedClass = circuit.verified ? 'verified-badge-small' : 'unverified-badge-small';
        
        return `
        <div class="circuit-card" data-id="${circuit.id}">
            ${circuit.image_url ? `<img class="circuit-image" src="${escapeHtml(circuit.image_url)}" alt="${escapeHtml(circuit.effect_name)}" loading="lazy" onerror="this.style.display='none'">` : ''}
            <div class="circuit-header">
                <h3 class="circuit-name">${escapeHtml(circuit.effect_name || 'Untitled')}</h3>
                <button class="star-btn ${isStarred ? 'starred' : ''}" data-id="${circuit.id}">
                    <i class="${isStarred ? 'fas fa-star' : 'far fa-star'}"></i>
                </button>
            </div>
            <div class="circuit-type-row">
                <span class="circuit-type">${escapeHtml(circuit.type || 'Uncategorized')}</span>
                <span class="category-badge ${categoryClass}"><i class="fas ${circuit.category === 'reference' ? 'fa-book' : 'fa-microchip'}"></i> ${circuit.category === 'reference' ? 'Reference' : 'Circuit'}</span>
            </div>
            ${circuit.description ? `<p class="circuit-description">${escapeHtml(circuit.description.substring(0, 120))}${circuit.description.length > 120 ? '...' : ''}</p>` : ''}
            <div class="circuit-meta">
                <span class="meta-badge"><i class="fas fa-microchip"></i> ${circuit.parts_count || '?'} parts</span>
                <span class="meta-badge"><i class="fas fa-chart-line"></i> ${circuit.difficulty || 'Not set'}</span>
            </div>
            ${circuit.components && Object.keys(circuit.components).length > 0 ? 
                `<div class="component-preview"><i class="fas fa-microchip"></i> ${Object.keys(circuit.components).slice(0, 3).join(', ')}${Object.keys(circuit.components).length > 3 ? '...' : ''}</div>` : ''}
            <div class="circuit-footer">
                <a href="${circuit.url}" class="circuit-url" target="_blank" rel="noopener noreferrer"><i class="fas fa-external-link-alt"></i> View Layout</a>
                <span class="${verifiedClass}"><i class="fas ${circuit.verified ? 'fa-check-circle' : 'fa-question-circle'}"></i> ${circuit.verified ? 'Verified' : 'Unverified'}</span>
            </div>
        </div>
    `}).join('');
    
    if (append) {
        resultsGrid.insertAdjacentHTML('beforeend', html);
    } else {
        resultsGrid.innerHTML = html;
    }
    
    // Attach favorite event listeners
    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.removeEventListener('click', toggleFavorite);
        btn.addEventListener('click', toggleFavorite);
    });
}

// ========== FAVORITES ==========
function toggleFavorite(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const id = parseInt(btn.dataset.id);
    const icon = btn.querySelector('i');
    
    // Don't allow adding NaN to favorites
    if (isNaN(id)) {
        console.error('Cannot add favorite: Invalid ID (NaN)');
        return;
    }
    
    console.log('Toggling favorite for circuit ID:', id);
    console.log('Current favorites set:', [...favorites]);
    
    if (favorites.has(id)) {
        favorites.delete(id);
        icon.classList.remove('fas');
        icon.classList.add('far');
        btn.classList.remove('starred');
        console.log('Removed from favorites. New favorites:', [...favorites]);
    } else {
        favorites.add(id);
        icon.classList.remove('far');
        icon.classList.add('fas');
        btn.classList.add('starred');
        console.log('Added to favorites. New favorites:', [...favorites]);
    }
    
    localStorage.setItem('circuitScoutFavorites', JSON.stringify([...favorites]));
    updateFavFilterButton();
    
    // If favorites filter is active, reload to show/hide circuits
    if (favFilterBtn && favFilterBtn.classList.contains('active')) {
        console.log('Favorites filter is active, reloading...');
        filteredCircuitsCache = null; // Clear cache to refresh filtered results
        resetAndReload();
    }
}

function updateFavFilterButton() {
    if (!favFilterBtn) return;
    const hasFavorites = favorites.size > 0;
    if (filterState.favorites && hasFavorites) {
        favFilterBtn.classList.add('active');
        favFilterBtn.innerHTML = '<i class="fas fa-star"></i> Favorites ON';
    } else {
        favFilterBtn.classList.remove('active');
        favFilterBtn.innerHTML = '<i class="far fa-star"></i> Favorites OFF';
    }
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
async function loadFilterOptions() {
    try {
        let types = [];
        let difficulties = [];
        
        if (isLocalhost) {
            const res = await fetch(`${API_BASE}/filters`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const filters = await res.json();
            types = filters.types || [];
            difficulties = filters.difficulties || [];
        } else {
            if (!allCircuitsCache) {
                allCircuitsCache = await loadCircuitsFromJSON();
                // Filter out ignored circuits for filter options too
                allCircuitsCache = allCircuitsCache.filter(c => !c.ignored);
            }
            types = [...new Set(allCircuitsCache.map(c => c.type).filter(t => t))];
            difficulties = [...new Set(allCircuitsCache.map(c => c.difficulty).filter(d => d))];
        }
        
        // Sort difficulties in proper order: Beginner, Intermediate, Advanced, Expert
        const difficultyOrder = { 'Beginner': 1, 'Intermediate': 2, 'Advanced': 3, 'Expert': 4 };
        difficulties.sort((a, b) => (difficultyOrder[a] || 99) - (difficultyOrder[b] || 99));
        
        if (typeSelect) {
            typeSelect.innerHTML = '<option value="">All types</option>' + 
                types.sort().map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        }
        
        if (difficultySelect) {
            difficultySelect.innerHTML = '<option value="">Any level</option>' + 
                difficulties.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
        }
        
        // Update stats
        if (!isLocalhost && allCircuitsCache) {
            const statsElem = document.getElementById('stats');
            if (statsElem) {
                const verifiedCount = allCircuitsCache.filter(c => c.verified).length;
                statsElem.innerHTML = `<i class="fas fa-database"></i> ${allCircuitsCache.length} circuits • ${verifiedCount} verified`;
            }
        } else if (isLocalhost) {
            const statsRes = await fetch(`${API_BASE}/stats`);
            if (statsRes.ok) {
                const stats = await statsRes.json();
                const statsElem = document.getElementById('stats');
                if (statsElem) {
                    statsElem.innerHTML = `<i class="fas fa-database"></i> ${stats.total || 0} circuits • ${stats.verified || 0} verified`;
                }
            }
        }
        
    } catch (error) {
        console.error('Failed to load filter options:', error);
        const statsElem = document.getElementById('stats');
        if (statsElem) {
            statsElem.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error loading data`;
        }
    }
}

// ========== FAVORITES FILTER ==========
function toggleFavFilter() {
    if (!favFilterBtn) return;
    
    if (filterState.favorites) {
        filterState.favorites = false;
        favFilterBtn.classList.remove('active');
        favFilterBtn.innerHTML = '<i class="far fa-star"></i> Favorites OFF';
        console.log('Favorites filter turned OFF');
    } else {
        if (favorites.size === 0) {
            showFavoritesModal();
            return;
        }
        filterState.favorites = true;
        favFilterBtn.classList.add('active');
        favFilterBtn.innerHTML = '<i class="fas fa-star"></i> Favorites ON';
        console.log('Favorites filter turned ON. Favorites:', [...favorites]);
    }
    filteredCircuitsCache = null; // Clear cache
    resetAndReload();
}

// ========== EVENT LISTENERS ==========
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        filterState.search = e.target.value;
        filteredCircuitsCache = null; // Clear cache
        resetAndReload();
    });
}

if (typeSelect) {
    typeSelect.addEventListener('change', (e) => {
        filterState.type = e.target.value;
        filteredCircuitsCache = null; // Clear cache
        resetAndReload();
    });
}

if (difficultySelect) {
    difficultySelect.addEventListener('change', (e) => {
        filterState.difficulty = e.target.value;
        filteredCircuitsCache = null; // Clear cache
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
            verified: 'all',
            favorites: false
        };
        if (searchInput) searchInput.value = '';
        if (typeSelect) typeSelect.value = '';
        if (difficultySelect) difficultySelect.value = '';
        updateCategoryButtonsUI();
        updateVerifiedButtonsUI();
        if (favFilterBtn) {
            favFilterBtn.classList.remove('active');
            favFilterBtn.innerHTML = '<i class="far fa-star"></i> Favorites OFF';
        }
        filteredCircuitsCache = null; // Clear cache
        console.log('All filters reset');
        resetAndReload();
    });
}

if (favFilterBtn) {
    favFilterBtn.addEventListener('click', toggleFavFilter);
}

if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
}

// ========== INITIALIZE ==========
initTheme();
loadFilterOptions();
setupInfiniteScroll();
resetAndReload();