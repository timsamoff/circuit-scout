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

// Convert HTML entities to human-readable characters
function decodeHtmlEntities(text) {
    if (!text) return '';
    
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&#038;': '&',
        '&#8217;': "'",
        '&#8220;': '"',
        '&#8221;': '"',
        '&#8216;': "'",
        '&#8211;': '-',
        '&#8212;': '--',
        '&#8230;': '...',
        '&nbsp;': ' ',
        '&copy;': '©',
        '&reg;': '®',
        '&trade;': '™'
    };
    
    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
        decoded = decoded.split(entity).join(char);
    }
    
    // Also handle numeric entities like &#123;
    decoded = decoded.replace(/&#(\d+);/g, (match, num) => {
        return String.fromCharCode(parseInt(num, 10));
    });
    
    // Handle hex entities like &#x3C;
    decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
    
    return decoded;
}

// Helper to construct RSS feed URL (works for both Blogger and generic feeds)
function getRssUrl(blogUrl, label = null) {
    if (blogUrl.includes('/feed') || blogUrl.includes('/rss') || blogUrl.includes('/atom')) {
        return blogUrl;
    }
    
    let cleanUrl = blogUrl.replace(/\/$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts\/default.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds.*$/, '');
    cleanUrl = cleanUrl.replace(/\/search\/label\/.*$/, '');
    
    if (cleanUrl.includes('blogspot.com')) {
        let feedUrl = `${cleanUrl}/feeds/posts/default`;
        if (label && label.trim() !== '') {
            const encodedLabel = encodeURIComponent(label.trim());
            feedUrl = `${feedUrl}/-/${encodedLabel}`;
        }
        return feedUrl;
    }
    
    if (label && label.trim() !== '') {
        return `${cleanUrl}/category/${encodeURIComponent(label.trim())}/feed`;
    }
    
    return `${cleanUrl}/feed`;
}

function getAltRssUrl(blogUrl, label = null) {
    let cleanUrl = blogUrl.replace(/\/$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts\/default.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds\/posts.*$/, '');
    cleanUrl = cleanUrl.replace(/\/feeds.*$/, '');
    cleanUrl = cleanUrl.replace(/\/search\/label\/.*$/, '');
    
    let feedUrl = `${cleanUrl}/feeds/posts/default?alt=rss`;
    
    if (label && label.trim() !== '') {
        const encodedLabel = encodeURIComponent(label.trim());
        feedUrl = `${cleanUrl}/feeds/posts/default/-/${encodedLabel}?alt=rss`;
    }
    
    return feedUrl;
}

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

async function findValidFeedUrl(baseUrl) {
    const feedPaths = [
        '/feed', '/feed/', '/?feed=rss2', '/?feed=rss', '/feed/rss',
        '/rss', '/feed/atom', '/atom', '/rss.xml', '/feed.xml'
    ];
    
    let cleanUrl = baseUrl.replace(/\/$/, '');
    
    if (cleanUrl.includes('/feed') || cleanUrl.includes('/rss') || cleanUrl.includes('/atom')) {
        const isValid = await isFeedUrlValid(cleanUrl);
        if (isValid) return cleanUrl;
    }
    
    for (const path of feedPaths) {
        const testUrl = `${cleanUrl}${path}`;
        console.log(`    Trying feed URL: ${testUrl}`);
        const isValid = await isFeedUrlValid(testUrl);
        if (isValid) {
            console.log(`    ✅ Found working feed: ${testUrl}`);
            return testUrl;
        }
    }
    
    return null;
}

// Initialize SQLite
const db = new sqlite3.Database("./circuits.db");

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
    if (err) console.error("❌ Database setup error:", err.message);
    else console.log("✅ Database tables and indexes ready.");
});

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
    if (err) console.error("❌ RSS feeds table error:", err.message);
    else console.log("✅ RSS feeds table ready.");
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

// Process Blogger Atom feed entries
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
        const decodedDescription = decodeHtmlEntities(cleanDescription);
        
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
        const effectTypes = ["Fuzz", "Overdrive", "Distortion", "Delay", "Reverb", "Chorus", "Phaser", "Flanger", "Tremolo", "Vibrato", "Compressor", "Boost", "EQ", "Filter", "Octave", "Wah", "Sub-octave"];
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
        
        effectName = decodeHtmlEntities(effectName);
        
        if (effectName.length < 3) effectName = "Unknown Effect";
        
        effectName = effectName.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        
        return {
            url: link,
            effect_name: effectName,
            type: effectType,
            parts_count: null,
            difficulty: "Intermediate",
            tags: JSON.stringify([]),
            image_url: imageUrl,
            components: JSON.stringify({}),
            description: decodedDescription,
            verified: verified ? 1 : 0,
            category: category
        };
    } catch (error) {
        console.error(`Error processing entry:`, error.message);
        return null;
    }
}

// Process WordPress RSS feed entries
async function processRssEntry(item) {
    try {
        let link = typeof item.link?.[0] === 'string' ? item.link[0] : "";
        let title = typeof item.title?.[0] === 'string' ? item.title[0] : "";
        let description = "";
        
        if (item.description?.[0]) {
            description = typeof item.description[0] === 'string' ? item.description[0] : "";
        } else if (item.content?.[0]) {
            description = typeof item.content[0] === 'string' ? item.content[0] : "";
        } else if (item['content:encoded']?.[0]) {
            description = typeof item['content:encoded'][0] === 'string' ? item['content:encoded'][0] : "";
        }
        
        let categories = [];
        if (item.category) {
            categories = item.category.map(c => typeof c === 'string' ? c : c._ || "");
        }
        
        if (!link || !title) {
            return null;
        }
        
        let imageUrl = null;
        if (description) {
            const imgMatch = description.match(/<img[^>]+src="([^">]+)"/);
            if (imgMatch && imgMatch[1]) imageUrl = imgMatch[1];
        }
        
        const cleanDescription = description ? description.replace(/<[^>]*>/g, '').substring(0, 200) : "";
        const decodedDescription = decodeHtmlEntities(cleanDescription);
        
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
        const effectTypes = ["Fuzz", "Overdrive", "Distortion", "Delay", "Reverb", "Chorus", "Phaser", "Flanger", "Tremolo", "Vibrato", "Compressor", "Boost", "EQ", "Filter", "Octave", "Wah", "Sub-octave", "VCA"];
        for (const type of effectTypes) {
            if (title.toLowerCase().includes(type.toLowerCase())) {
                effectType = type;
                break;
            }
        }
        
        let effectName = title
            .replace(/SabroTone|TagboardEffects|StripboardLayouts/gi, "")
            .replace(/layout|vero|stripboard|build guide|guide|tutorial/i, "")
            .replace(/[\s_:|-]+/g, " ")
            .trim();
        
        effectName = decodeHtmlEntities(effectName);
        
        if (effectName.length < 3) effectName = "Unknown Effect";
        
        effectName = effectName.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        
        return {
            url: link,
            effect_name: effectName,
            type: effectType,
            parts_count: null,
            difficulty: "Intermediate",
            tags: JSON.stringify([]),
            image_url: imageUrl,
            components: JSON.stringify({}),
            description: decodedDescription,
            verified: verified ? 1 : 0,
            category: category
        };
    } catch (error) {
        console.error(`    Error processing RSS entry:`, error.message);
        return null;
    }
}

// Fetch all posts from sitemap
async function scrapeSitemap(baseUrl) {
    const allUrls = [];
    let cleanUrl = baseUrl.replace(/\/$/, '');
    cleanUrl = cleanUrl.replace(/\/feed.*$/, '');
    cleanUrl = cleanUrl.replace(/\/rss.*$/, '');
    cleanUrl = cleanUrl.replace(/\/wp-json.*$/, '');
    cleanUrl = cleanUrl.replace(/\/post-sitemap.*$/, '');
    cleanUrl = cleanUrl.replace(/\/sitemap.*$/, '');
    
    const sitemapPaths = [
        '/post-sitemap.xml', '/sitemap-post.xml', '/post-sitemap1.xml',
        '/sitemap.xml', '/sitemap_index.xml'
    ];
    
    let sitemapUrl = null;
    let sitemapData = null;
    
    for (const path of sitemapPaths) {
        const testUrl = `${cleanUrl}${path}`;
        console.log(`    Trying sitemap: ${testUrl}`);
        
        try {
            const response = await axios.get(testUrl, {
                timeout: 15000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/xml, text/xml, */*"
                }
            });
            
            if (response.status === 200) {
                sitemapUrl = testUrl;
                sitemapData = response.data;
                console.log(`    ✅ Found sitemap: ${sitemapUrl}`);
                break;
            }
        } catch (e) {}
    }
    
    if (!sitemapData) {
        console.log(`    ❌ No sitemap found`);
        return [];
    }
    
    const { parseStringPromise } = await import('xml2js');
    const parsed = await parseStringPromise(sitemapData);
    
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
        console.log(`    📑 This is a sitemap index, fetching sub-sitemaps...`);
        for (const sitemap of parsed.sitemapindex.sitemap) {
            const loc = sitemap.loc?.[0];
            if (loc) {
                console.log(`      Fetching: ${loc}`);
                try {
                    const subResponse = await axios.get(loc, {
                        timeout: 15000,
                        headers: { "User-Agent": "Mozilla/5.0" }
                    });
                    const subParsed = await parseStringPromise(subResponse.data);
                    if (subParsed.urlset && subParsed.urlset.url) {
                        for (const url of subParsed.urlset.url) {
                            const postUrl = url.loc?.[0];
                            if (postUrl && !postUrl.includes('/tag/') && !postUrl.includes('/category/') && !postUrl.includes('/author/')) {
                                allUrls.push(postUrl);
                            }
                        }
                        console.log(`        Found ${subParsed.urlset.url.length} URLs in this sitemap`);
                    }
                } catch (e) {
                    console.error(`      Error fetching sub-sitemap: ${e.message}`);
                }
            }
        }
    }
    else if (parsed.urlset && parsed.urlset.url) {
        console.log(`    📄 This is a direct urlset sitemap`);
        for (const url of parsed.urlset.url) {
            const loc = url.loc?.[0];
            if (loc && !loc.includes('/tag/') && !loc.includes('/category/') && !loc.includes('/author/')) {
                allUrls.push(loc);
            }
        }
    }
    
    console.log(`    Found ${allUrls.length} post URLs in sitemap`);
    return allUrls;
}

// Scrape a single post page for circuit info
async function scrapePostPage(url) {
    try {
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        
        const html = response.data;
        
        let title = "";
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        if (h1Match) title = h1Match[1];
        if (!title) {
            const ogMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
            if (ogMatch) title = ogMatch[1];
        }
        if (!title) {
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleMatch) title = titleMatch[1];
        }
        
        const lowerTitle = title.toLowerCase();
        const skipPatterns = ['hello world', 'welcome', 'category', 'archive', 'page', 'search', 'error', '404'];
        let shouldSkip = false;
        for (const pattern of skipPatterns) {
            if (lowerTitle.includes(pattern)) {
                shouldSkip = true;
                break;
            }
        }
        
        if (shouldSkip) {
            console.log(`      ⏭️ Skipping non-circuit page: ${title}`);
            return null;
        }
        
        let description = "";
        const descMatch = html.match(/<meta name="description" content="([^"]+)"/i);
        if (descMatch) description = descMatch[1];
        if (!description) {
            const ogDescMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
            if (ogDescMatch) description = ogDescMatch[1];
        }
        
        let imageUrl = "";
        const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
        if (imgMatch) imageUrl = imgMatch[1];
        if (!imageUrl) {
            const featuredMatch = html.match(/<img[^>]+class="[^"]*wp-image-[^"]*"[^>]+src="([^"]+)"/i);
            if (featuredMatch) imageUrl = featuredMatch[1];
        }
        
        title = title.replace(/<[^>]*>/g, '').trim();
        title = title.replace(/\s+/g, ' ');
        
        let category = 'circuit';
        const referencePatterns = [/guide/i, /tutorial/i, /how to/i, /wiring/i, /reference/i, /build guide/i];
        for (const pattern of referencePatterns) {
            if (pattern.test(title)) {
                category = 'reference';
                break;
            }
        }
        
        let effectType = null;
        const effectTypes = ["Fuzz", "Overdrive", "Distortion", "Delay", "Reverb", "Chorus", "Phaser", "Flanger", "Tremolo", "Vibrato", "Compressor", "Boost", "EQ", "Filter", "Octave", "Wah", "Sub-octave", "VCA", "Buffer", "Preamp", "Amp", "Limiter"];
        for (const type of effectTypes) {
            if (title.toLowerCase().includes(type.toLowerCase())) {
                effectType = type;
                break;
            }
        }
        
        let effectName = title
            .replace(/SabroTone/gi, "")
            .replace(/Layout/gi, "")
            .replace(/Vero/gi, "")
            .replace(/Stripboard/gi, "")
            .replace(/Build Guide/gi, "")
            .replace(/Guide/gi, "")
            .replace(/[\s_:|-]+/g, " ")
            .trim();
        
        effectName = decodeHtmlEntities(effectName);
        
        if (effectName.length < 2) effectName = "Unknown Effect";
        
        effectName = effectName.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
        
        const hasCircuitKeywords = /fuzz|overdrive|distortion|delay|reverb|chorus|phaser|flanger|tremolo|compressor|boost|octave|wah|filter|preamp|buffer|amplifier|amp/i.test(title);
        
        if (!hasCircuitKeywords && category !== 'reference') {
            console.log(`      ⏭️ Skipping non-circuit page (no keywords): ${title}`);
            return null;
        }
        
        const decodedDescription = decodeHtmlEntities(description.substring(0, 200));
        
        return {
            url: url,
            effect_name: effectName,
            type: effectType,
            parts_count: null,
            difficulty: "Intermediate",
            tags: JSON.stringify([]),
            image_url: imageUrl,
            components: JSON.stringify({}),
            description: decodedDescription,
            verified: 0,
            category: category
        };
    } catch (error) {
        console.error(`      Error scraping ${url}: ${error.message}`);
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
                
                let extracted;
                if (feedType === 'atom') {
                    extracted = await processEntryForScraping(item, feedType);
                } else {
                    extracted = await processRssEntry(item);
                }
                
                if (!extracted) continue;
                
                scraperStatus.itemsProcessed++;
                
                const exists = await new Promise((resolve) => {
                    db.get("SELECT id FROM circuits WHERE url = ?", [extracted.url], (err, row) => {
                        resolve(!err && row);
                    });
                });
                
                if (exists) {
                    skipped++;
                    continue;
                }
                
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
    
    await new Promise((resolve) => {
        db.run("UPDATE rss_feeds SET last_scraped = CURRENT_TIMESTAMP WHERE id = ?", [feed.id], (err) => {
            if (err) console.error(`    Failed to update last_scraped: ${err.message}`);
            else console.log(`    📅 Updated last_scraped timestamp for ${feed.name}`);
            resolve();
        });
    });
    
    console.log(`  📊 Feed "${feed.name}" complete: +${added} new, ${skipped} duplicates`);
    return { added, skipped, cancelled: false };
}

// ========== API ROUTES ==========

app.get("/api/scrape/status", (req, res) => {
    res.json(scraperStatus);
});

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

app.post("/api/debug/feed", async (req, res) => {
    const { url, label } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });
    
    const rssUrl = getRssUrl(url, label);
    const altRssUrl = getAltRssUrl(url, label);
    
    const results = {
        original: url,
        label: label || null,
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
                const difficultyOrder = { 'Beginner': 1, 'Intermediate': 2, 'Advanced': 3, 'Expert': 4 };
                const sortedDifficulties = (difficulties.map(d => d.difficulty).filter(d => d)).sort((a, b) => (difficultyOrder[a] || 99) - (difficultyOrder[b] || 99));
                
                res.json({
                    types: types.map(t => t.type).filter(t => t),
                    difficulties: sortedDifficulties,
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
    const { url, name, label } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: "URL is required" });
    }
    
    let baseUrl = url.replace(/\/search\/label\/.*$/, '').replace(/\/feeds\/posts\/default\/-\/.*$/, '');
    baseUrl = baseUrl.replace(/\/feed.*$/, '').replace(/\/rss.*$/, '').replace(/\/atom.*$/, '');
    baseUrl = baseUrl.replace(/\/post-sitemap.*$/, '').replace(/\/sitemap.*$/, '');
    
    let feedUrl;
    let feedName;
    
    if (baseUrl.includes('blogspot.com')) {
        if (label && label.trim() !== '') {
            feedUrl = getRssUrl(baseUrl, label);
            feedName = name || `${baseUrl.replace(/https?:\/\//, '').replace(/\.blogspot\.com.*$/, '')} - ${label}`;
            console.log(`Adding Blogger feed with label: ${label}`);
        } else {
            feedUrl = getRssUrl(baseUrl);
            feedName = name || baseUrl.replace(/https?:\/\//, '').replace(/\.blogspot\.com.*$/, '');
        }
        
        const isValid = await isFeedUrlValid(feedUrl);
        if (!isValid) {
            return res.status(400).json({ error: "Could not find a working RSS feed for this Blogger blog." });
        }
        
        db.run("INSERT INTO rss_feeds (url, name, blog_url, enabled) VALUES (?, ?, ?, 1)", [feedUrl, feedName, baseUrl], async function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: "This feed already exists" });
                }
                return res.status(500).json({ error: err.message });
            }
            
            const newFeedId = this.lastID;
            res.json({ id: newFeedId, url: feedUrl, name: feedName, blog_url: baseUrl, label: label || null, scraping: true });
            
            console.log(`🔄 Auto-scraping new Blogger feed: ${feedName}`);
            
            scraperStatus = {
                running: true,
                currentFeed: feedName,
                currentPage: 0,
                itemsProcessed: 0,
                itemsAdded: 0,
                itemsSkipped: 0,
                startTime: Date.now(),
                feedsCompleted: 0,
                totalFeeds: 1,
                error: null
            };
            
            try {
                const feed = { id: newFeedId, url: feedUrl, name: feedName };
                const result = await scrapeSingleFeedWithProgress(feed);
                console.log(`✅ Auto-scrape complete for ${feedName}: Added ${result.added} circuits, Skipped ${result.skipped} duplicates`);
                
                await cleanupAllDuplicates();
                await autoExportToJSON();
                
                scraperStatus.running = false;
                scraperStatus.itemsAdded = result.added;
                scraperStatus.itemsSkipped = result.skipped;
                
            } catch (scrapeErr) {
                console.error(`❌ Auto-scrape failed for ${feedName}:`, scrapeErr.message);
                scraperStatus.running = false;
                scraperStatus.error = scrapeErr.message;
            }
        });
        return;
    }
    
    console.log(`🔍 Attempting to scrape sitemap for ${baseUrl}`);
    const sitemapUrls = await scrapeSitemap(baseUrl);
    
    if (sitemapUrls.length > 0) {
        console.log(`📡 Found ${sitemapUrls.length} posts in sitemap, scraping each...`);
        
        feedName = name || baseUrl.replace(/https?:\/\//, '').replace(/www\./, '');
        feedUrl = `${baseUrl}/sitemap`;
        
        db.run("INSERT INTO rss_feeds (url, name, blog_url, enabled) VALUES (?, ?, ?, 1)", [feedUrl, feedName, baseUrl], async function(err) {
            if (err && !err.message.includes('UNIQUE')) {
                console.error("Error saving feed:", err.message);
            }
        });
        
        scraperStatus = {
            running: true,
            currentFeed: feedName,
            currentPage: 0,
            itemsProcessed: 0,
            itemsAdded: 0,
            itemsSkipped: 0,
            startTime: Date.now(),
            feedsCompleted: 0,
            totalFeeds: 1,
            error: null
        };
        
        res.json({ message: "Sitemap found, processing posts...", total: sitemapUrls.length, scraping: true });
        
        let added = 0;
        let skipped = 0;
        
        for (let i = 0; i < sitemapUrls.length; i++) {
            const postUrl = sitemapUrls[i];
            scraperStatus.itemsProcessed = i + 1;
            
            if (i % 20 === 0) {
                console.log(`    Processing URL ${i + 1}/${sitemapUrls.length}...`);
            }
            
            const exists = await new Promise((resolve) => {
                db.get("SELECT id FROM circuits WHERE url = ?", [postUrl], (err, row) => {
                    resolve(!err && row);
                });
            });
            
            if (exists) {
                skipped++;
                scraperStatus.itemsSkipped = skipped;
                continue;
            }
            
            const extracted = await scrapePostPage(postUrl);
            if (!extracted) {
                console.log(`      ⏭️ No circuit data found for: ${postUrl.substring(0, 60)}...`);
                continue;
            }
            
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
            
            if (added % 10 === 0) {
                console.log(`    Progress: ${added} added, ${skipped} skipped (${i + 1}/${sitemapUrls.length})`);
            }
        }
        
        console.log(`✅ Sitemap scrape complete: Added ${added} new circuits, Skipped ${skipped} duplicates`);
        
        await cleanupAllDuplicates();
        await autoExportToJSON();
        
        await new Promise((resolve) => {
            db.run("UPDATE rss_feeds SET last_scraped = CURRENT_TIMESTAMP WHERE blog_url = ?", [baseUrl], () => resolve());
        });
        
        scraperStatus.running = false;
        
        return;
    }
    
    console.log(`No sitemap found, trying RSS feed for ${baseUrl}`);
    feedUrl = await findValidFeedUrl(baseUrl);
    if (!feedUrl) {
        return res.status(400).json({ error: "Could not find a working RSS feed or sitemap for this URL." });
    }
    
    feedName = name || baseUrl.replace(/https?:\/\//, '').replace(/www\./, '');
    
    db.run("INSERT INTO rss_feeds (url, name, blog_url, enabled) VALUES (?, ?, ?, 1)", [feedUrl, feedName, baseUrl], async function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ error: "This feed already exists" });
            }
            return res.status(500).json({ error: err.message });
        }
        
        const newFeedId = this.lastID;
        res.json({ id: newFeedId, url: feedUrl, name: feedName, blog_url: baseUrl, scraping: true });
        
        console.log(`🔄 Auto-scraping new RSS feed: ${feedName}`);
        
        scraperStatus = {
            running: true,
            currentFeed: feedName,
            currentPage: 0,
            itemsProcessed: 0,
            itemsAdded: 0,
            itemsSkipped: 0,
            startTime: Date.now(),
            feedsCompleted: 0,
            totalFeeds: 1,
            error: null
        };
        
        try {
            const feed = { id: newFeedId, url: feedUrl, name: feedName };
            const result = await scrapeSingleFeedWithProgress(feed);
            console.log(`✅ Auto-scrape complete for ${feedName}: Added ${result.added} circuits, Skipped ${result.skipped} duplicates`);
            
            await cleanupAllDuplicates();
            await autoExportToJSON();
            
            scraperStatus.running = false;
            scraperStatus.itemsAdded = result.added;
            scraperStatus.itemsSkipped = result.skipped;
            
        } catch (scrapeErr) {
            console.error(`❌ Auto-scrape failed for ${feedName}:`, scrapeErr.message);
            scraperStatus.running = false;
            scraperStatus.error = scrapeErr.message;
        }
    });
});

app.get("/api/circuits/:id", (req, res) => {
    db.get("SELECT * FROM circuits WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Not found" });
        res.json(row);
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

app.post("/api/scrape", async (req, res) => {
    if (scraperStatus.running) {
        return res.status(409).json({ error: "Scraper is already running" });
    }
    
    const maxAgeHours = req.body.maxAgeHours || 24;
    cancelRequested = false;
    
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
    
    res.json({ message: "Scraping started", status: "running", maxAgeHours });
    
    const feeds = await new Promise((resolve) => {
        db.all(`
            SELECT id, name, url, last_scraped 
            FROM rss_feeds 
            WHERE enabled = 1 
            AND (
                last_scraped IS NULL 
                OR julianday('now') - julianday(last_scraped) > ${maxAgeHours / 24.0}
            )
        `, (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
    
    const skippedFeeds = await new Promise((resolve) => {
        db.all(`
            SELECT id, name, last_scraped 
            FROM rss_feeds 
            WHERE enabled = 1 
            AND last_scraped IS NOT NULL 
            AND julianday('now') - julianday(last_scraped) <= ${maxAgeHours / 24.0}
        `, (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
    
    scraperStatus.totalFeeds = feeds.length;
    
    if (skippedFeeds.length > 0) {
        console.log(`\n⏭️ Skipping ${skippedFeeds.length} feed(s) scraped within the last ${maxAgeHours} hours:`);
        skippedFeeds.forEach(feed => {
            const lastScraped = new Date(feed.last_scraped).toLocaleString();
            console.log(`   - ${feed.name} (last scraped: ${lastScraped})`);
        });
    }
    
    console.log(`\n🕷️ Starting manual scrape of ${feeds.length} feed(s) (older than ${maxAgeHours} hours)...`);
    
    try {
        for (let i = 0; i < feeds.length; i++) {
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
        console.log(`   Processed ${scraperStatus.feedsCompleted} of ${feeds.length} feeds`);
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

app.use(express.static("."));

app.get("/admin", (req, res) => { res.sendFile(process.cwd() + "/admin.html"); });

db.get("SELECT COUNT(*) as count FROM circuits", async (err, row) => {
    if (!err && row?.count > 0) {
        console.log("📊 Running initial cleanup on startup...");
        await cleanupAllDuplicates();
        await autoExportToJSON();
    }
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
    console.log(`   • Cancel button to stop long-running scrapes`);
    console.log(`   • Label support for Blogger feeds`);
    console.log(`   • WordPress RSS feed support`);
    console.log(`   • Sitemap support for WordPress sites`);
    console.log(`   • HTML entity decoding for titles and descriptions\n`);
});