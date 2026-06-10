import "dotenv/config";
import express from "express";
import sqlite3 from "sqlite3";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import fs from "fs/promises";
import { runScraper, scrapeSingleFeed } from './scraper.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("."));

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
    const urlParts = cleanUrl.split('/');
    const baseUrl = urlParts.slice(0, 3).join('/');
    // Use Atom format (works better with Blogger)
    return `${baseUrl}/feeds/posts/default`;
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

// ========== AUTO-EXPORT TO JSON ==========
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

// ========== API ROUTES ==========

// Get paginated circuits (with ALL filters working)
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
    
    // Search filter (partial match on name, type, or tags)
    if (search && search.trim() !== '') {
        conditions.push("(effect_name LIKE ? OR type LIKE ? OR tags LIKE ?)");
        const searchPattern = `%${search.trim()}%`;
        params.push(searchPattern, searchPattern, searchPattern);
    }
    
    // Type filter (exact match)
    if (typeFilter && typeFilter !== '') {
        conditions.push("type = ?");
        params.push(typeFilter);
    }
    
    // Difficulty filter (exact match)
    if (difficultyFilter && difficultyFilter !== '') {
        conditions.push("difficulty = ?");
        params.push(difficultyFilter);
    }
    
    // Verified filter
    if (verifiedFilter === 'true') {
        conditions.push("verified = 1");
    } else if (verifiedFilter === 'false') {
        conditions.push("verified = 0");
    }
    
    // Category filter (content type)
    if (categoryFilter && categoryFilter !== 'all' && categoryFilter !== '') {
        conditions.push("category = ?");
        params.push(categoryFilter);
    }
    
    // Build WHERE clause
    if (conditions.length) {
        const whereClause = " WHERE " + conditions.join(" AND ");
        query += whereClause;
        countQuery += whereClause;
    }
    
    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    
    // Get total count
    db.get(countQuery, params, (err, countRow) => {
        if (err) {
            console.error('Count error:', err);
            return res.status(500).json({ error: err.message });
        }
        
        const total = countRow?.total || 0;
        
        // Get paginated results
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

// Get filter options
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

// Get stats
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

// Get all RSS feeds
app.get("/api/feeds", (req, res) => {
    db.all("SELECT * FROM rss_feeds ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Delete RSS feed
app.delete("/api/feeds/:id", (req, res) => {
    db.run("DELETE FROM rss_feeds WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Toggle feed enabled status
app.patch("/api/feeds/:id/toggle", (req, res) => {
    db.run("UPDATE rss_feeds SET enabled = NOT enabled WHERE id = ?", req.params.id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Add RSS feed (auto-scrape ONLY the new feed)
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
        
        // Scrape ONLY the newly added feed
        console.log(`🔄 Auto-scraping new feed: ${feedName}`);
        const result = await scrapeSingleFeed(db, autoExportToJSON, newFeedId);
        console.log(`✅ Auto-scrape complete for ${feedName}: Added ${result.added} circuits`);
    });
});

// Get single circuit for editing
app.get("/api/circuits/:id", (req, res) => {
    db.get("SELECT * FROM circuits WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Not found" });
        res.json(row);
    });
});

// Update circuit
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

// Add circuit manually
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

// Delete circuit
app.delete("/api/circuits/:id", async (req, res) => {
    db.run("DELETE FROM circuits WHERE id = ?", req.params.id, async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        await autoExportToJSON();
        res.json({ success: true });
    });
});

// Trigger scrape (manual) - uses paginated scraper
app.post("/api/scrape", async (req, res) => {
    // Send immediate response
    res.json({ message: "Scraping started", status: "running" });
    
    // Run scraper in background using imported paginated version
    const result = await runScraper(db, autoExportToJSON);
    console.log(`✅ Manual scrape complete: Added ${result.added} circuits`);
});

app.get("/admin", (req, res) => { res.sendFile(process.cwd() + "/admin.html"); });

// Initial export on startup
db.get("SELECT COUNT(*) as count FROM circuits", async (err, row) => {
    if (!err && row?.count > 0) {
        await autoExportToJSON();
    }
});

app.listen(PORT, () => {
    console.log(`\n🔍 Circuit Scout is running!\n`);
    console.log(`📱 Public site:    http://localhost:${PORT}`);
    console.log(`🔧 Admin panel:    http://localhost:${PORT}/admin\n`);
    console.log(`💡 JSON auto-exports to data/circuits.json after every change\n`);
});