/*
 * ============================================================================
 * Circuit Scout - RSS/Atom Feed Scraper
 * Version 1.0.0
 * Designed & Developed by Tim Samoff
 * 
 * Scrapes RSS/Atom feeds from Blogger and other platforms
 * Supports pagination to fetch ALL posts
 * Auto-detects Atom vs RSS format
 * Exports directly to data/circuits.json
 * 
 * @license MIT
 * @see https://samoff.com/circuit-scout
 * ============================================================================
 */

import axios from "axios";
import { parseStringPromise } from "xml2js";
import sqlite3 from 'sqlite3';
import fs from 'fs';

const EFFECT_TYPES = [
    "Fuzz", "Overdrive", "Distortion", "Delay", "Reverb", "Chorus", "Phaser",
    "Flanger", "Tremolo", "Vibrato", "Compressor", "Boost", "EQ", "Filter",
    "Octave", "Pitch", "Synth", "Wah", "Volume", "Looper", "Noise Gate"
];

const DIFFICULTY_MAP = {
    beginner: "Beginner", easy: "Beginner", simple: "Beginner",
    intermediate: "Intermediate", medium: "Intermediate",
    advanced: "Advanced", hard: "Advanced",
    expert: "Expert", complex: "Expert"
};

function detectEffectType(text) {
    const lowerText = text.toLowerCase();
    for (const type of EFFECT_TYPES) {
        if (lowerText.includes(type.toLowerCase())) return type;
    }
    return null;
}

function detectDifficulty(text) {
    const lowerText = text.toLowerCase();
    for (const [keyword, difficulty] of Object.entries(DIFFICULTY_MAP)) {
        if (lowerText.includes(keyword)) return difficulty;
    }
    return "Intermediate";
}

function extractPartsCount(text) {
    const patterns = [/(\d+)\s*parts?/i, /(\d+)\s*components?/i];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            const count = parseInt(match[1]);
            if (count > 0 && count < 500) return count;
        }
    }
    return null;
}

function extractTags(text, effectType) {
    const tags = new Set();
    if (effectType) tags.add(effectType.toLowerCase());
    const tagKeywords = ["vintage", "modern", "silicon", "germanium", "tube", "analog", "digital", "verified"];
    const lowerText = text.toLowerCase();
    for (const keyword of tagKeywords) {
        if (lowerText.includes(keyword)) tags.add(keyword);
    }
    return Array.from(tags);
}

function extractEffectName(title, url) {
    let titleStr = "";
    if (typeof title === 'string') {
        titleStr = title;
    } else if (title && typeof title === 'object') {
        titleStr = title._ || title.toString() || "";
    } else {
        titleStr = String(title || "");
    }
    
    let clean = titleStr
        .replace(/TagboardEffects|DirtboxLayouts|EffectsLayouts|Guitar FX|Guitar Effects/gi, "")
        .replace(/layout|vero|stripboard|build guide|guide|tutorial/i, "")
        .replace(/[\s_:|-]+/g, " ")
        .trim();
    clean = clean.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    
    if (clean.length < 3 || clean === "Untitled" || clean === "Guide" || clean === "Tutorial") {
        const urlParts = url.split(/[/-]/);
        for (const part of urlParts) {
            if (part.length > 3 && part.length < 30 && !part.match(/^\d+$/)) {
                clean = part.replace(/\.html$/, "").replace(/_/g, " ");
                clean = clean.charAt(0).toUpperCase() + clean.slice(1);
                break;
            }
        }
    }
    return clean || "Unknown Effect";
}

function truncateDescription(text, maxLength = 200) {
    if (!text) return "";
    const stringText = typeof text === 'string' ? text : String(text);
    const plainText = stringText.replace(/<[^>]*>/g, '');
    if (plainText.length <= maxLength) return plainText;
    return plainText.substring(0, maxLength).trim() + "...";
}

function extractFirstImage(htmlContent) {
    if (!htmlContent) return null;
    const stringContent = typeof htmlContent === 'string' ? htmlContent : String(htmlContent);
    const imgMatch = stringContent.match(/<img[^>]+src="([^">]+)"/);
    if (imgMatch && imgMatch[1]) {
        return imgMatch[1];
    }
    return null;
}

function detectCategory(title, content) {
    const lowerTitle = title.toLowerCase();
    const referencePatterns = [
        /guide/i, /tutorial/i, /how to/i, /build guide/i, /fault finding/i, 
        /debugging/i, /beginner's guide/i, /wiring/i, /offboard wiring/i, 
        /wiring guide/i, /3pdt wiring/i, /switch wiring/i, /daughterboard/i,
        /component kits/i, /parts list/i, /where to buy/i, /components guide/i, 
        /parts guide/i, /reference/i, /info/i, /information/i
    ];
    
    for (const pattern of referencePatterns) {
        if (pattern.test(lowerTitle) || pattern.test(content.substring(0, 300))) {
            return 'reference';
        }
    }
    return 'circuit';
}

async function processAtomEntry(entry) {
    try {
        const link = entry.link?.find(l => l.$.rel === 'alternate')?.$?.href || entry.link?.[0]?.$?.href || "";
        
        let title = "";
        if (entry.title) {
            if (typeof entry.title[0] === 'string') {
                title = entry.title[0];
            } else if (entry.title[0]?._) {
                title = entry.title[0]._;
            } else if (entry.title[0]) {
                title = String(entry.title[0]);
            }
        }
        
        let description = "";
        if (entry.summary) {
            if (typeof entry.summary[0] === 'string') {
                description = entry.summary[0];
            } else if (entry.summary[0]?._) {
                description = entry.summary[0]._;
            } else if (entry.summary[0]) {
                description = String(entry.summary[0]);
            }
        } else if (entry.content) {
            if (typeof entry.content[0] === 'string') {
                description = entry.content[0];
            } else if (entry.content[0]?._) {
                description = entry.content[0]._;
            } else if (entry.content[0]) {
                description = String(entry.content[0]);
            }
        }
        
        const categories = entry.category?.map(c => c.$.term) || [];
        
        if (!link || !title) return null;
        
        const imageUrl = extractFirstImage(description);
        const cleanDescription = truncateDescription(description, 200);
        const category = detectCategory(title, description);
        
        let verified = false;
        if (categories.some(cat => cat.toLowerCase().includes('verified')) || 
            title.toLowerCase().includes('verified') ||
            title.toLowerCase().includes('confirmed')) {
            verified = true;
        }
        
        const effectType = detectEffectType(title + " " + categories.join(" "));
        const difficulty = detectDifficulty(description + " " + title);
        const partsCount = extractPartsCount(description);
        const tags = extractTags(title + " " + categories.join(" "), effectType);
        const effectName = extractEffectName(title, link);
        
        console.log(`  📄 ${effectName} | Type: ${effectType || 'unknown'} | Verified: ${verified}`);
        
        return {
            url: link,
            effect_name: effectName,
            type: effectType,
            parts_count: partsCount,
            difficulty: difficulty,
            tags: JSON.stringify(tags),
            image_url: imageUrl,
            components: JSON.stringify({}),
            description: cleanDescription,
            verified: verified ? 1 : 0,
            category: category
        };
    } catch (error) {
        console.error(`  ❌ Error processing entry:`, error.message);
        return null;
    }
}

async function fetchAllPages(baseFeedUrl, pageSize = 25) {
    console.log(`  Fetching feed: ${baseFeedUrl}`);
    
    const firstResponse = await axios.get(baseFeedUrl, { 
        timeout: 30000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml, */*"
        }
    });
    
    let parsed = await parseStringPromise(firstResponse.data);
    let feedType = 'atom';
    let allItems = parsed.feed?.entry || [];
    
    if (!allItems.length && parsed.rss?.channel?.[0]?.item) {
        feedType = 'rss';
        allItems = parsed.rss.channel[0].item;
    }
    
    const totalCount = parseInt(parsed.feed?.openSearch$totalResults?.[0]) || 0;
    console.log(`  Detected: ${feedType.toUpperCase()} format, ${totalCount || allItems.length} posts`);
    
    if (totalCount > pageSize) {
        const totalPages = Math.ceil(totalCount / pageSize);
        console.log(`  Fetching ${totalPages} total pages...`);
        
        for (let page = 2; page <= totalPages; page++) {
            const startIndex = (page - 1) * pageSize + 1;
            const pageUrl = `${baseFeedUrl}?start-index=${startIndex}&max-results=${pageSize}`;
            
            console.log(`    Page ${page}/${totalPages}...`);
            
            try {
                const pageResponse = await axios.get(pageUrl, { 
                    timeout: 30000,
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml, */*"
                    }
                });
                
                const pageParsed = await parseStringPromise(pageResponse.data);
                const pageItems = pageParsed.feed?.entry || [];
                allItems = [...allItems, ...pageItems];
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`    Error fetching page ${page}:`, error.message);
            }
        }
    }
    
    console.log(`  Total items fetched: ${allItems.length}`);
    return { items: allItems, feedType };
}

async function exportToJSON(db) {
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
                    if (!fs.existsSync('./data')) {
                        fs.mkdirSync('./data');
                    }
                    fs.writeFileSync('./data/circuits.json', JSON.stringify(exportData, null, 2));
                    const stats = fs.statSync('./data/circuits.json');
                    console.log(`📦 Auto-exported ${exportData.length} circuits to data/circuits.json (${(stats.size / 1024).toFixed(2)} KB)`);
                    resolve();
                } catch (writeErr) {
                    console.error("Failed to write JSON:", writeErr);
                    reject(writeErr);
                }
            }
        );
    });
}

async function scrapeAllFeeds() {
    console.log("🕷️ Starting paginated scraper...");
    
    const db = new sqlite3.Database('./circuits.db');
    
    const feeds = await new Promise((resolve) => {
        db.all("SELECT * FROM rss_feeds WHERE enabled = 1", (err, rows) => {
            resolve(err ? [] : rows);
        });
    });
    
    if (feeds.length === 0) {
        console.log("No enabled RSS feeds found.");
        db.close();
        return { added: 0, skipped: 0 };
    }
    
    console.log(`Found ${feeds.length} feeds\n`);
    
    let totalAdded = 0;
    let totalSkipped = 0;
    
    for (const feed of feeds) {
        console.log(`📡 Processing: ${feed.name}`);
        
        try {
            const { items, feedType } = await fetchAllPages(feed.url);
            console.log(`   Total items found: ${items.length}`);
            
            for (const item of items) {
                let link = "";
                if (feedType === 'atom') {
                    link = item.link?.find(l => l.$.rel === 'alternate')?.$?.href || item.link?.[0]?.$?.href || "";
                } else {
                    link = item.link?.[0] || "";
                }
                
                if (!link) continue;
                
                const exists = await new Promise((resolve) => {
                    db.get("SELECT id FROM circuits WHERE url = ?", [link], (err, row) => {
                        resolve(!err && row);
                    });
                });
                
                if (exists) {
                    totalSkipped++;
                    continue;
                }
                
                const extracted = await processAtomEntry(item);
                if (!extracted) continue;
                
                await new Promise((resolve) => {
                    db.run(`INSERT INTO circuits 
                        (url, effect_name, type, parts_count, difficulty, tags, image_url, components, description, verified, category) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [extracted.url, extracted.effect_name, extracted.type, extracted.parts_count, 
                         extracted.difficulty, extracted.tags, extracted.image_url, extracted.components, 
                         extracted.description, extracted.verified, extracted.category],
                        (err) => { resolve(); });
                });
                
                totalAdded++;
                console.log(`   ✅ Added: ${extracted.effect_name}`);
            }
            
            // Update last_scraped timestamp
            await new Promise((resolve) => {
                db.run("UPDATE rss_feeds SET last_scraped = CURRENT_TIMESTAMP WHERE id = ?", [feed.id], () => resolve());
            });
            
        } catch (error) {
            console.error(`   ❌ Error: ${error.message}`);
        }
    }
    
    console.log(`\n✅ Scraping complete! Added ${totalAdded} new circuits, Skipped ${totalSkipped} duplicates`);
    
    // Export to JSON
    await exportToJSON(db);
    
    db.close();
    return { added: totalAdded, skipped: totalSkipped };
}

// Export for use in server.js
export async function runScraper(db, autoExportToJSON) {
    console.log("🕷️ Running scraper...");
    const result = await scrapeAllFeeds();
    return result;
}

export async function scrapeSingleFeed(db, autoExportToJSON, feedId) {
    console.log(`🕷️ Scraping single feed ID: ${feedId}`);
    const result = await scrapeAllFeeds();
    return result;
}

// Run directly if called from command line
if (import.meta.url === `file://${process.argv[1]}` || 
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
    scrapeAllFeeds().catch(console.error);
}