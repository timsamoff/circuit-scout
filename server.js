import "dotenv/config";
import express from "express";
import sqlite3 from "sqlite3";
import axios from "axios";
import cors from "cors";
import fs from "fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Scraper status tracking
let scraperStatus = {
    running: false,
    currentFeed: '',
    currentPage: 0,
    itemsProcessed: 0,
    itemsAdded: 0,
    itemsSkipped: 0,
    startTime: null,
    feedsCompleted: 0,
    totalFeeds: 0,
    error: null
};

// Flag to signal cancel
let cancelRequested = false;

// Serve placeholder manifest to fix 404 errors
app.get("/manifest.json", (req, res) => {
    res.json({
        name: "Circuit Scout",
        short_name: "CircuitScout",
        start_url: "/",
        display: "standalone",
        theme_color: "#0f2b3d",
        background_color: "#0a1a24"
    });
});

app.get("/browserconfig.xml", (req, res) => {
    res.type("application/xml");
    res.send(`<?xml version="1.0" encoding="utf-8"?>
    <browserconfig>
        <msapplication>
            <tile>
                <square70x70logo src="/favicon/ms-icon-70x70.png"/>
                <square150x150logo src="/favicon/ms-icon-150x150.png"/>
                <square310x310logo src="/favicon/ms-icon-310x310.png"/>
                <TileColor>#0f2b3d</TileColor>
            </tile>
        </msapplication>
    </browserconfig>`);
});

// Helper to construct RSS feed URL from blog URL
function getRssUrl(blogUrl) {
    let cleanUrl = blogUrl.replace(/\/$/, '');
    // Remove trailing /feeds/posts/default if present
    cleanUrl = cleanUrl.replace(/\/feeds\/posts\/default.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds.*$/, '');
    
    // Return the Atom feed URL (works best with Blogger)
    return `${cleanUrl}/feeds/posts/default`;
}

// Alternative RSS feed URL
function getAltRssUrl(blogUrl) {
    let cleanUrl = blogUrl.replace(/\/$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts\/default.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds.*$/, '');
    return `${cleanUrl}/feeds/posts/default?alt=rss`;
}

// Test if a feed URL is valid
async function isFeedUrlValid(feedUrl) {
    try {
        const response = await axios.get(feedUrl, {
            timeout: 10000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        return response.status === 200;
    } catch {
        return false;
    }
}

// Initialize SQLite
const db = new sqlite3.Database("./circuits.db");

// Create circuits table
db.exec(`
    CREATE TABLE IF NOT EXISTS circuits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE,
        effect_name TEXT,
        type TEXT,
        parts_count INTEGER,
        difficulty TEXT,
        tags TEXT,
        image_url TEXT,
        components TEXT,
        description TEXT,
        verified BOOLEAN DEFAULT 0,
        category TEXT DEFAULT 'circuit',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_circuits_url ON circuits(url);
    CREATE INDEX IF NOT EXISTS idx_circuits_verified ON circuits(verified);
    CREATE INDEX IF NOT EXISTS idx_circuits_category ON circuits(category);
    CREATE INDEX IF NOT EXISTS idx_circuits_type ON circuits(type);
    CREATE INDEX IF NOT EXISTS idx_circuits_difficulty ON circuits(difficulty);
`, (err) => {
    if (err) {
        console.error("❌ Database setup error:", err.message);
    } else {
        console.log("✅ Database tables and indexes ready.");
    }
});

// Create RSS feeds table
db.exec(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE,
        name TEXT,
        blog_url TEXT,
        enabled BOOLEAN DEFAULT 1,
        last_scraped DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rss_feeds_url ON rss_feeds(url);
    CREATE INDEX IF NOT EXISTS idx_rss_feeds_enabled ON rss_feeds(enabled);
`, (err) => {
    if (err) {
        console.error("❌ RSS feeds table error:", err.message);
    } else {
        console.log("✅ RSS feeds table ready.");
    }
});

// ========== DUPLICATE CLEANUP FUNCTIONS ==========

async function removeDuplicateUrlsFromDB() {
    return new Promise((resolve, reject) => {
        console.log("🔍 Checking for duplicate URLs in database...");
        
        db.all(`
            SELECT id, url, 
                   CASE 
                       WHEN url LIKE 'http://%' THEN 'https://' || SUBSTR(url, 8)
                       ELSE url
                   END as normalized_url
            FROM circuits
        `, (err, allRows) => {
            if (err) {
                console.error("Error fetching circuits:", err);
                reject(err);
                return;
            }
            
            const urlGroups = new Map();
            for (const row of allRows) {
                const normalized = row.normalized_url;
                if (!urlGroups.has(normalized)) {
                    urlGroups.set(normalized, []);
                }
                urlGroups.get(normalized).push({ id: row.id, original_url: row.url });
            }
            
            const duplicates = [];
            for (const [normalized, items] of urlGroups) {
                if (items.length > 1) {
                    items.sort((a, b) => {
                        const aIsHttps = a.original_url.startsWith('https');
                        const bIsHttps = b.original_url.startsWith('https');
                        if (aIsHttps && !bIsHttps) return -1;
                        if (!aIsHttps && bIsHttps) return 1;
                        return a.id - b.id;
                    });
                    
                    const keepItem = items[0];
                    const deleteItems = items.slice(1);
                    duplicates.push({
                        normalized,
                        keep_id: keepItem.id,
                        keep_url: keepItem.original_url,
                        delete_ids: deleteItems.map(d => d.id),
                        delete_urls: deleteItems.map(d => d.original_url)
                    });
                }
            }
            
            if (duplicates.length === 0) {
                console.log("✅ No duplicate URLs found in database.");
                resolve(0);
                return;
            }
            
            console.log(`⚠️ Found ${duplicates.length} duplicate URL groups in database.`);
            
            let deletedCount = 0;
            let processed = 0;
            
            for (const dup of duplicates) {
                const placeholders = dup.delete_ids.map(() => '?').join(',');
                db.run(`
                    DELETE FROM circuits 
                    WHERE id IN (${placeholders})
                `, dup.delete_ids, function(err) {
                    if (err) {
                        console.error(`Error deleting duplicates for ${dup.normalized}:`, err);
                    } else {
                        deletedCount += this.changes;
                        console.log(`  🗑️ Removed ${this.changes} duplicate(s) of "${dup.normalized.substring(0, 60)}..."`);
                    }
                    processed++;
                    
                    if (processed === duplicates.length) {
                        console.log(`✅ Database cleanup complete: Removed ${deletedCount} duplicate entries.`);
                        resolve(deletedCount);
                    }
                });
            }
        });
    });
}

async function removeDuplicateUrlsFromJSON() {
    try {
        const dataPath = './data/circuits.json';
        
        try {
            await fs.access(dataPath);
        } catch {
            console.log("📄 No circuits.json file found to clean up.");
            return 0;
        }
        
        const rawData = await fs.readFile(dataPath, 'utf8');
        const circuits = JSON.parse(rawData);
        const originalCount = circuits.length;
        
        const seenUrls = new Map();
        const uniqueCircuits = [];
        
        for (const circuit of circuits) {
            let normalizedUrl = circuit.url;
            if (normalizedUrl && normalizedUrl.startsWith('http://')) {
                normalizedUrl = 'https://' + normalizedUrl.substring(7);
            }
            
            if (!seenUrls.has(normalizedUrl)) {
                seenUrls.set(normalizedUrl, true);
                uniqueCircuits.push(circuit);
            }
        }
        
        const removedCount = originalCount - uniqueCircuits.length;
        
        if (removedCount > 0) {
            await fs.writeFile(dataPath, JSON.stringify(uniqueCircuits, null, 2));
            console.log(`📦 JSON cleanup complete: Removed ${removedCount} duplicate entries`);
        } else {
            console.log("✅ No duplicate URLs found in JSON file.");
        }
        
        return removedCount;
    } catch (error) {
        console.error("Error cleaning up JSON:", error);
        return 0;
    }
}

async function cleanupAllDuplicates() {
    console.log("\n🧹 Starting full duplicate cleanup...");
    const dbRemoved = await removeDuplicateUrlsFromDB();
    const jsonRemoved = await removeDuplicateUrlsFromJSON();
    console.log(`🧹 Cleanup complete: ${dbRemoved} from DB, ${jsonRemoved} from JSON\n`);
    return { dbRemoved, jsonRemoved };
}

async function autoExportToJSON() {
    return new Promise((resolve, reject) => {
        db.all("SELECT url, effect_name, type, parts_count, difficulty, tags, image_url, components, description, verified, category FROM circuits ORDER BY created_at DESC", 
            async (err, rows) => {
                if (err) {
                    console.error("Export failed:", err);
                    reject(err);
                    return;
                }
                
                const exportData = rows.map(row => ({
                    url: row.url,
                    effect_name: row.effect_name,
                    type: row.type,
                    parts_count: row.parts_count,
                    difficulty: row.difficulty,
                    tags: row.tags ? JSON.parse(row.tags) : [],
                    image_url: row.image_url,
                    components: row.components ? JSON.parse(row.components) : {},
                    description: row.description,
                    verified: row.verified === 1,
                    category: row.category || 'circuit'
                }));
                
                try {
                    await fs.mkdir("./data", { recursive: true });
                    await fs.writeFile("./data/circuits.json", JSON.stringify(exportData, null, 2));
                    console.log(`📦 Auto-exported ${exportData.length} circuits to data/circuits.json`);
                    resolve();
                } catch (writeErr) {
                    console.error("Failed to write JSON:", writeErr);
                    reject(writeErr);
                }
            }
        );
    });
}

// ========== SCRAPER FUNCTIONS WITH PROGRESS TRACKING ==========

async function processEntryForScraping(item, feedType) {
    try {
        let link = "";
        if (feedType === 'atom') {
            link = item.link?.find(l => l.$.rel === 'alternate')?.$?.href || item.link?.[0]?.$?.href || "";
        } else {
            link = item.link?.[0] || "";
        }
        
        let title = "";
        if (item.title) {
            if (typeof item.title[0] === 'string') title = item.title[0];
            else if (item.title[0]?._) title = item.title[0]._;
            else if (item.title[0]) title = String(item.title[0]);
        }
        
        let description = "";
        if (item.summary) {
            if (typeof item.summary[0] === 'string') description = item.summary[0];
            else if (item.summary[0]?._) description = item.summary[0]._;
            else if (item.summary[0]) description = String(item.summary[0]);
        } else if (item.content) {
            if (typeof item.content[0] === 'string') description = item.content[0];
            else if (item.content[0]?._) description = item.content[0]._;
            else if (item.content[0]) description = String(item.content[0]);
        }
        
        const categories = item.category?.map(c => c.$.term) || [];
        
        if (!link || !title) return null;
        
        let imageUrl = null;
        if (description) {
            const imgMatch = description.match(/<img[^>]+src="([^">]+)"/);
            if (imgMatch && imgMatch[1]) imageUrl = imgMatch[1];
        }
        
        const cleanDescription = description ? description.replace(/<[^>]*>/g, '').substring(0, 200) : "";
        
        let category = 'circuit';
        const lowerTitle = title.toLowerCase();
        const referencePatterns = [/guide/i, /tutorial/i, /how to/i, /wiring/i, /reference/i];
        for (const pattern of referencePatterns) {
            if (pattern.test(lowerTitle)) {
                category = 'reference';
                break;
            }
        }
        
        let verified = false;
        if (categories.some(cat => cat.toLowerCase().includes('verified')) || 
            title.toLowerCase().includes('verified')) {
            verified = true;
        }
        
        let effectType = null;
        const effectTypes = ["Fuzz", "Overdrive", "Distortion", "Delay", "Reverb", "Chorus", "Phaser", "Flanger", "Tremolo", "Vibrato", "Compressor", "Boost", "EQ", "Filter", "Octave", "Wah"];
        for (const type of effectTypes) {
            if (title.toLowerCase().includes(type.toLowerCase())) {
                effectType = type;
                break;
            }
        }
        
        let effectName = title
            .replace(/TagboardEffects|StripboardLayouts|DirtboxLayouts/gi, "")
            .replace(/layout|vero|stripboard/gi, "")
            .replace(/[\s_:|-]+/g, " ")
            .trim();
        if (effectName.length < 3) effectName = "Unknown Effect";
        
        return {
            url: link,
            effect_name: effectName,
            type: effectType,
            parts_count: null,
            difficulty: "Intermediate",
            tags: JSON.stringify([]),
            image_url: imageUrl,
            components: JSON.stringify({}),
            description: cleanDescription.substring(0, 200),
            verified: verified ? 1 : 0,
            category: category
        };
    } catch (error) {
        console.error(`Error processing entry:`, error.message);
        return null;
    }
}

async function scrapeSingleFeedWithProgress(feed) {
    const { parseStringPromise } = await import('xml2js');
    
    let added = 0;
    let skipped = 0;
    let page = 1;
    const pageSize = 25;
    let hasMore = true;
    let feedType = 'atom';
    
    console.log(`  📡 Starting scrape of ${feed.name} - paginating through all pages...`);
    
    while (hasMore && !cancelRequested) {
        const startIndex = (page - 1) * pageSize + 1;
        const pageUrl = `${feed.url}?start-index=${startIndex}&max-results=${pageSize}`;
        
        scraperStatus.currentPage = page;
        
        try {
            console.log(`    Page ${page} (items ${startIndex}-${startIndex + pageSize - 1})...`);
            
            const response = await axios.get(pageUrl, {
                timeout: 30000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml, */*"
                }
            });
            
            const parsed = await parseStringPromise(response.data);
            
            if (page === 1) {
                if (parsed.feed?.entry) feedType = 'atom';
                else if (parsed.rss?.channel?.[0]?.item) feedType = 'rss';
                console.log(`    Detected: ${feedType.toUpperCase()} format`);
            }
            
            let items = [];
            if (feedType === 'atom') {
                items = parsed.feed?.entry || [];
            } else {
                items = parsed.rss?.channel?.[0]?.item || [];
            }
            
            if (items.length === 0) {
                console.log(`    No more items found, stopping.`);
                hasMore = false;
                break;
            }
            
            console.log(`    Processing ${items.length} items...`);
            
            for (const item of items) {
                if (cancelRequested) {
                    console.log(`    ⚠️ Cancellation requested, stopping...`);
                    return { added, skipped, cancelled: true };
                }
                
                let link = "";
                if (feedType === 'atom') {
                    link = item.link?.find(l => l.$.rel === 'alternate')?.$?.href || item.link?.[0]?.$?.href || "";
                } else {
                    link = item.link?.[0] || "";
                }
                
                if (!link) continue;
                
                scraperStatus.itemsProcessed++;
                
                const exists = await new Promise((resolve) => {
                    db.get("SELECT id FROM circuits WHERE url = ?", [link], (err, row) => {
                        resolve(!err && row);
                    });
                });
                
                if (exists) {
                    skipped++;
                    continue;
                }
                
                const extracted = await processEntryForScraping(item, feedType);
                if (!extracted) continue;
                
                await new Promise((resolve) => {
                    db.run(`INSERT INTO circuits 
                        (url, effect_name, type, parts_count, difficulty, tags, image_url, components, description, verified, category) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [extracted.url, extracted.effect_name, extracted.type, extracted.parts_count,
                         extracted.difficulty, extracted.tags, extracted.image_url, extracted.components,
                         extracted.description, extracted.verified, extracted.category],
                        (err) => { 
                            if (err) console.error(`      Insert error: ${err.message}`);
                            resolve(); 
                        });
                });
                
                added++;
                scraperStatus.itemsAdded = added;
                console.log(`      ✅ Added: ${extracted.effect_name}`);
            }
            
            console.log(`    Page ${page} complete: +${added} new, ${skipped} skipped so far`);
            
            if (items.length < pageSize) {
                console.log(`    Last page reached (got ${items.length} < ${pageSize})`);
                hasMore = false;
            }
            
            page++;
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`    Error on page ${page}:`, error.message);
            hasMore = false;
        }
    }
    
    console.log(`  📊 Feed "${feed.name}" complete: +${added} new, ${skipped} duplicates`);
    return { added, skipped, cancelled: false };
}

// ========== API ROUTES ==========
// IMPORTANT: All API routes must come BEFORE express.static

app.get("/api/scrape/status", (req, res) => {
    res.json(scraperStatus);
});

// Cancel running scraper
app.post("/api/scrape/cancel", (req, res) => {
    console.log("Cancel endpoint hit. Running:", scraperStatus.running);
    
    if (!scraperStatus.running) {
        return res.status(400).json({ error: "No scraper is currently running" });
    }
    
    cancelRequested = true;
    scraperStatus.error = "Cancelled by user";
    console.log("🛑 Scraper cancellation requested by user");
    res.json({ message: "Scraper cancellation requested", status: "cancelling" });
});

// Test endpoint to verify API is working
app.get("/api/ping", (req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});

app.get("/api/circuits", (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || "";
    const verifiedFilter = req.query.verified;
    const categoryFilter = req.query.category;
    const typeFilter = req.query.type || "";
    const difficultyFilter = req.query.difficulty || "";
    
    let query = "SELECT * FROM circuits";
    let countQuery = "SELECT COUNT(*) as total FROM circuits";
    let params = [];
    let conditions = [];
    
    if (search && search.trim() !== '') {
        conditions.push("(effect_name LIKE ? OR type LIKE ? OR tags LIKE ?)");
        const searchPattern = `%${search.trim()}%`;
        params.push(searchPattern, searchPattern, searchPattern);
    }
    
    if (typeFilter && typeFilter !== '') {
        conditions.push("type = ?");
        params.push(typeFilter);
    }
    
    if (difficultyFilter && difficultyFilter !== '') {
        conditions.push("difficulty = ?");
        params.push(difficultyFilter);
    }
    
    if (verifiedFilter === 'true') {
        conditions.push("verified = 1");
    } else if (verifiedFilter === 'false') {
        conditions.push("verified = 0");
    }
    
    if (categoryFilter && categoryFilter !== 'all' && categoryFilter !== '') {
        conditions.push("category = ?");
        params.push(categoryFilter);
    }
    
    if (conditions.length) {
        const whereClause = " WHERE " + conditions.join(" AND ");
        query += whereClause;
        countQuery += whereClause;
    }
    
    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    
    db.get(countQuery, params, (err, countRow) => {
        if (err) {
            console.error('Count error:', err);
            return res.status(500).json({ error: err.message });
        }
        
        const total = countRow?.total || 0;
        
        db.all(query, [...params, limit, offset], (err, rows) => {
            if (err) {
                console.error('Query error:', err);
                return res.status(500).json({ error: err.message });
            }
            
            res.json({
                circuits: rows,
                total: total,
                page: page,
                limit: limit,
                totalPages: Math.ceil(total / limit)
            });
        });
    });
});

app.get("/api/filters", (req, res) => {
    db.all("SELECT DISTINCT type FROM circuits WHERE type IS NOT NULL AND type != ''", (err, types) => {
        db.all("SELECT DISTINCT difficulty FROM circuits WHERE difficulty IS NOT NULL AND difficulty != ''", (err, difficulties) => {
            db.all("SELECT DISTINCT category FROM circuits WHERE category IS NOT NULL", (err, categories) => {
                res.json({
                    types: types.map(t => t.type).filter(t => t),
                    difficulties: difficulties.map(d => d.difficulty).filter(d => d),
                    categories: categories.map(c => c.category).filter(c => c)
                });
            });
        });
    });
});

app.get("/api/stats", (req, res) => {
    db.get("SELECT COUNT(*) as total FROM circuits", (err, row) => {
        db.get("SELECT COUNT(*) as verified FROM circuits WHERE verified = 1", (err, verifiedRow) => {
            res.json({ 
                total: row?.total || 0,
                verified: verifiedRow?.verified || 0
            });
        });
    });
});

app.get("/api/feeds", (req, res) => {
    db.all("SELECT * FROM rss_feeds ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.delete("/api/feeds/:id", (req, res) => {
    db.run("DELETE FROM rss_feeds WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.patch("/api/feeds/:id/toggle", (req, res) => {
    db.run("UPDATE rss_feeds SET enabled = NOT enabled WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post("/api/feeds", async (req, res) => {
    const { url, name } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: "URL is required" });
    }
    
    const rssUrl = getRssUrl(url);
    const feedName = name || url.replace(/https?:\/\//, '').replace(/\.blogspot\.com.*$/, '');
    
    db.run("INSERT INTO rss_feeds (url, name, blog_url, enabled) VALUES (?, ?, ?, 1)", [rssUrl, feedName, url], async function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ error: "This feed already exists" });
            }
            return res.status(500).json({ error: err.message });
        }
        
        const newFeedId = this.lastID;
        
        // Send response immediately
        res.json({ id: newFeedId, url: rssUrl, name: feedName, blog_url: url, scraping: true });
        
        // Scrape the feed in the background
        console.log(`🔄 Auto-scraping new feed: ${feedName}`);
        
        try {
            const feed = { id: newFeedId, url: rssUrl, name: feedName };
            const result = await scrapeSingleFeedWithProgress(feed);
            console.log(`✅ Auto-scrape complete for ${feedName}: Added ${result.added} circuits, Skipped ${result.skipped} duplicates`);
            
            await cleanupAllDuplicates();
            await autoExportToJSON();
        } catch (scrapeErr) {
            console.error(`❌ Auto-scrape failed for ${feedName}:`, scrapeErr.message);
        }
    });
});

app.put("/api/circuits/:id", async (req, res) => {
    const { effect_name, type, parts_count, difficulty, tags, image_url, description, verified, category } = req.body;
    
    db.run(`UPDATE circuits SET 
        effect_name = ?,
        type = ?,
        parts_count = ?,
        difficulty = ?,
        tags = ?,
        image_url = ?,
        description = ?,
        verified = ?,
        category = ?
        WHERE id = ?`,
        [effect_name, type, parts_count, difficulty, tags ? JSON.stringify(tags) : null, image_url, description, verified ? 1 : 0, category || 'circuit', req.params.id],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            await autoExportToJSON();
            res.json({ success: true });
        }
    );
});

app.post("/api/circuits", async (req, res) => {
    const { url, effect_name, type, parts_count, difficulty, tags, image_url, components, description, verified, category } = req.body;
    
    db.run(`INSERT OR REPLACE INTO circuits (url, effect_name, type, parts_count, difficulty, tags, image_url, components, description, verified, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [url, effect_name, type, parts_count, difficulty, tags ? JSON.stringify(tags) : null, image_url, components ? JSON.stringify(components) : null, description, verified ? 1 : 0, category || 'circuit'],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            await autoExportToJSON();
            res.json({ id: this.lastID });
        }
    );
});

app.delete("/api/circuits/:id", async (req, res) => {
    db.run("DELETE FROM circuits WHERE id = ?", req.params.id, async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        await autoExportToJSON();
        res.json({ success: true });
    });
});

// MANUAL SCRAPE with cancel support
app.post("/api/scrape", async (req, res) => {
    if (scraperStatus.running) {
        return res.status(409).json({ error: "Scraper is already running" });
    }
    
    // Reset cancellation flag
    cancelRequested = false;
    
    // Reset status
    scraperStatus = {
        running: true,
        currentFeed: '',
        currentPage: 0,
        itemsProcessed: 0,
        itemsAdded: 0,
        itemsSkipped: 0,
        startTime: Date.now(),
        feedsCompleted: 0,
        totalFeeds: 0,
        error: null
    };
    
    // Send immediate response
    res.json({ message: "Scraping started", status: "running" });
    
    // Get all enabled feeds
    const feeds = await new Promise((resolve) => {
        db.all("SELECT id, name, url FROM rss_feeds WHERE enabled = 1", (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
    
    scraperStatus.totalFeeds = feeds.length;
    console.log(`\n🕷️ Starting manual scrape of ${feeds.length} feed(s)...`);
    
    try {
        for (let i = 0; i < feeds.length; i++) {
            // Check for cancellation
            if (cancelRequested) {
                console.log(`\n🛑 Scraper cancelled by user after ${scraperStatus.feedsCompleted} feeds`);
                scraperStatus.error = "Cancelled by user";
                break;
            }
            
            const feed = feeds[i];
            scraperStatus.currentFeed = feed.name;
            scraperStatus.currentPage = 0;
            
            console.log(`\n📡 [${i + 1}/${feeds.length}] Processing: ${feed.name}`);
            const result = await scrapeSingleFeedWithProgress(feed);
            
            scraperStatus.itemsAdded += result.added;
            scraperStatus.itemsSkipped += result.skipped;
            scraperStatus.feedsCompleted++;
            
            console.log(`   Feed complete: +${result.added} new, ${result.skipped} duplicates`);
        }
        
        if (!cancelRequested) {
            console.log("\n🧹 Running duplicate cleanup...");
            await cleanupAllDuplicates();
            
            console.log("📦 Exporting to JSON...");
            await autoExportToJSON();
        }
        
        const elapsedSeconds = Math.floor((Date.now() - scraperStatus.startTime) / 1000);
        console.log(`\n✅ Manual scrape ${cancelRequested ? 'cancelled' : 'complete'}!`);
        console.log(`   Added: ${scraperStatus.itemsAdded} circuits`);
        console.log(`   Skipped: ${scraperStatus.itemsSkipped} duplicates`);
        console.log(`   Total processed: ${scraperStatus.itemsProcessed} items`);
        console.log(`   Time: ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`);
        
        scraperStatus.running = false;
        
    } catch (error) {
        console.error("Scrape error:", error);
        scraperStatus.running = false;
        scraperStatus.error = error.message;
    }
});

app.post("/api/cleanup", async (req, res) => {
    const result = await cleanupAllDuplicates();
    await autoExportToJSON();
    res.json({ message: "Cleanup complete", ...result });
});

// Static files - THIS MUST COME AFTER ALL API ROUTES
app.use(express.static("."));

app.get("/admin", (req, res) => { res.sendFile(process.cwd() + "/admin.html"); });

// Initial export and cleanup on startup
db.get("SELECT COUNT(*) as count FROM circuits", async (err, row) => {
    if (!err && row?.count > 0) {
        console.log("📊 Running initial cleanup on startup...");
        await cleanupAllDuplicates();
        await autoExportToJSON();
    }
});

// Debug endpoint to test feed URLs
app.post("/api/debug/feed", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    const rssUrl = getRssUrl(url);
    const altRssUrl = getAltRssUrl(url);
    
    const results = {
        original: url,
        atomFeed: rssUrl,
        rssFeed: altRssUrl,
        atomWorking: false,
        rssWorking: false
    };
    
    try {
        const atomTest = await axios.get(rssUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
        results.atomWorking = atomTest.status === 200;
        results.atomStatus = atomTest.status;
    } catch (e) {
        results.atomError = e.message;
    }
    
    try {
        const rssTest = await axios.get(altRssUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
        results.rssWorking = rssTest.status === 200;
        results.rssStatus = rssTest.status;
    } catch (e) {
        results.rssError = e.message;
    }
    
    console.log("Debug results:", results);
    res.json(results);
});

app.listen(PORT, () => {
    console.log(`\n🔍 Circuit Scout is running!\n`);
    console.log(`📱 Public site:    http://localhost:${PORT}`);
    console.log(`🔧 Admin panel:    http://localhost:${PORT}/admin\n`);
    console.log(`💡 JSON auto-exports to data/circuits.json after every change\n`);
    console.log(`✨ Features enabled:`);
    console.log(`   • Full pagination (all feed pages, not just first 25)`);
    console.log(`   • Automatic duplicate detection & cleanup`);
    console.log(`   • Database + JSON deduplication`);
    console.log(`   • Real-time scraper progress tracking`);
    console.log(`   • Cancel button to stop long-running scrapes\n`);
});