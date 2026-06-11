import axios from "axios";
import { parseStringPromise } from "xml2js";
import sqlite3 from 'sqlite3';
import fs from 'fs';
import * as cheerio from 'cheerio';

const EFFECT_TYPES = [
    "Fuzz", "Overdrive", "Distortion", "Delay", "Reverb", "Chorus", "Phaser",
    "Flanger", "Tremolo", "Vibrato", "Compressor", "Boost", "EQ", "Filter",
    "Octave", "Pitch", "Synth", "Wah", "Volume", "Looper", "Noise Gate", "Sub-octave", "VCA"
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
        .replace(/TagboardEffects|DirtboxLayouts|EffectsLayouts|Guitar FX|Guitar Effects|SabroTone/gi, "")
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

// Scrape a static HTML listing page (like runoffgroove.com/articles.html)
async function scrapeStaticListing(listingUrl, db) {
    console.log(`  📄 Scraping static listing: ${listingUrl}`);
    const circuits = [];
    
    try {
        const response = await axios.get(listingUrl, {
            timeout: 30000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        
        const $ = cheerio.load(response.data);
        const baseUrl = listingUrl.replace(/\/[^/]*$/, '/');
        
        // Find all links that point to likely project pages
        const projectLinks = new Set();
        
        $('a[href$=".html"]').each((i, elem) => {
            let href = $(elem).attr('href');
            if (!href) return;
            
            // Skip external links, navigation, and the listing page itself
            const lowerText = $(elem).text().toLowerCase();
            if (href.startsWith('http') && !href.includes(listingUrl.split('/')[2])) return;
            if (lowerText.includes('home') || lowerText.includes('contact') || lowerText.includes('faq')) return;
            if (href === 'articles.html' || href === '/articles.html') return;
            
            // Resolve relative URLs
            try {
                const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
                if (fullUrl !== listingUrl) {
                    projectLinks.add(fullUrl);
                }
            } catch (e) {
                // Invalid URL, skip
            }
        });
        
        console.log(`    Found ${projectLinks.size} potential project links`);
        
        let processed = 0;
        for (const projectUrl of projectLinks) {
            processed++;
            console.log(`    [${processed}/${projectLinks.size}] Scraping: ${projectUrl.split('/').pop()}`);
            
            const circuitData = await scrapeStaticProjectPage(projectUrl);
            if (circuitData) {
                circuits.push(circuitData);
            }
            
            // Be polite - delay between requests
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
    } catch (error) {
        console.error(`    ❌ Error scraping static listing: ${error.message}`);
    }
    
    return circuits;
}

// Scrape an individual project page
async function scrapeStaticProjectPage(pageUrl) {
    try {
        const response = await axios.get(pageUrl, {
            timeout: 30000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        
        const $ = cheerio.load(response.data);
        
        // Remove script and style elements
        $('script, style').remove();
        
        // Extract title (try various common patterns)
        let title = $('h1').first().text().trim();
        if (!title) title = $('title').first().text().trim();
        if (!title) title = $('h2').first().text().trim();
        
        // Clean up title - remove site name, separators, extra spaces
        title = title.replace(/\s+/g, ' ').replace(/[|:-].*$/, '').replace(/runoffgroove|tagboard|dirtbox/i, '').trim();
        
        // Extract description - first paragraph or meta description
        let description = $('meta[name="description"]').attr('content') || '';
        if (!description) {
            // Get the first substantial paragraph (more than 50 chars)
            $('p').each((i, p) => {
                const text = $(p).text().trim();
                if (text.length > 50 && !text.toLowerCase().includes('copyright')) {
                    description = text;
                    return false;
                }
            });
            if (!description) description = $('p').first().text().trim();
        }
        
        // Extract image - look for schematic or layout images
        let imageUrl = '';
        const schematicSelectors = [
            'img[src*="schematic"]', 'img[src*="layout"]', 'img[src*="pcb"]',
            'img[src*="vero"]', 'img[src*="stripboard"]', 'img[src*="diagram"]',
            'a[href*="schematic"] img', 'a[href*="layout"] img',
            'img[alt*="schematic"]', 'img[alt*="layout"]'
        ];
        
        for (const selector of schematicSelectors) {
            const img = $(selector).first();
            if (img.length) {
                imageUrl = img.attr('src') || '';
                if (imageUrl && !imageUrl.startsWith('http')) {
                    try {
                        imageUrl = new URL(imageUrl, pageUrl).href;
                    } catch (e) {}
                }
                if (imageUrl) break;
            }
        }
        
        // If no schematic image found, take first image that isn't a logo or icon
        if (!imageUrl) {
            $('img').each((i, img) => {
                const src = $(img).attr('src');
                const alt = $(img).attr('alt') || '';
                if (src && !alt.toLowerCase().includes('logo') && !src.toLowerCase().includes('logo')) {
                    imageUrl = src;
                    if (imageUrl && !imageUrl.startsWith('http')) {
                        try {
                            imageUrl = new URL(imageUrl, pageUrl).href;
                        } catch (e) {}
                    }
                    return false;
                }
            });
        }
        
        // Use existing detection functions
        const effectType = detectEffectType(title + " " + description);
        const difficulty = detectDifficulty(description + " " + title);
        const partsCount = extractPartsCount(description);
        const tags = extractTags(title + " " + description, effectType);
        const effectName = extractEffectName(title, pageUrl);
        const category = detectCategory(title, description);
        
        // Check for verified mention
        let verified = false;
        const lowerContent = (title + " " + description).toLowerCase();
        if (lowerContent.includes('verified') || lowerContent.includes('confirmed') || lowerContent.includes('working layout')) {
            verified = true;
        }
        
        return {
            url: pageUrl,
            effect_name: effectName,
            type: effectType,
            parts_count: partsCount,
            difficulty: difficulty,
            tags: JSON.stringify(tags),
            image_url: imageUrl,
            components: JSON.stringify({}),
            description: truncateDescription(description, 200),
            verified: verified ? 1 : 0,
            category: category
        };
        
    } catch (error) {
        console.error(`      Error scraping ${pageUrl}: ${error.message}`);
        return null;
    }
}

// Process Blogger Atom feed entries
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
        
        if (!link || !title) return null;
        
        const imageUrl = extractFirstImage(description);
        const cleanDescription = truncateDescription(description, 200);
        const category = detectCategory(title, description);
        
        let verified = false;
        if (categories.some(cat => cat.toLowerCase().includes('verified')) || 
            title.toLowerCase().includes('verified')) {
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
        console.error(`  ❌ Error processing RSS entry:`, error.message);
        return null;
    }
}

async function fetchAllPages(baseFeedUrl, pageSize = 25) {
    console.log(`  Fetching feed: ${baseFeedUrl}`);
    
    let allItems = [];
    let page = 1;
    let hasMore = true;
    let feedType = 'atom';
    
    while (hasMore) {
        const startIndex = (page - 1) * pageSize + 1;
        const pageUrl = `${baseFeedUrl}?start-index=${startIndex}&max-results=${pageSize}`;
        
        if (page === 1) {
            console.log(`    Fetching page 1...`);
        } else {
            console.log(`    Fetching page ${page} (items ${startIndex}+)...`);
        }
        
        try {
            const response = await axios.get(pageUrl, {
                timeout: 30000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml, */*"
                }
            });
            
            const parsed = await parseStringPromise(response.data);
            
            if (page === 1) {
                if (parsed.feed?.entry) {
                    feedType = 'atom';
                } else if (parsed.rss?.channel?.[0]?.item) {
                    feedType = 'rss';
                }
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
            
            allItems = [...allItems, ...items];
            console.log(`    Got ${items.length} items (total so far: ${allItems.length})`);
            
            if (items.length < pageSize) {
                console.log(`    Reached last page (got ${items.length} < ${pageSize})`);
                hasMore = false;
            }
            
            page++;
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`    Error fetching page ${page}:`, error.message);
            hasMore = false;
        }
    }
    
    console.log(`  ✅ Total items fetched: ${allItems.length}`);
    return { items: allItems, feedType };
}

async function scrapeStaticHtmlSource(feed, db) {
    console.log(`\n📄 Scraping static HTML source: ${feed.name}`);
    console.log(`   URL: ${feed.url}`);
    
    const circuits = await scrapeStaticListing(feed.url, db);
    
    console.log(`   ✅ Found ${circuits.length} circuits from static listing`);
    
    // Save to database
    let added = 0;
    let skipped = 0;
    
    for (const circuit of circuits) {
        // Check if already exists
        const exists = await new Promise((resolve) => {
            db.get("SELECT id FROM circuits WHERE url = ?", [circuit.url], (err, row) => {
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
                [circuit.url, circuit.effect_name, circuit.type, circuit.parts_count,
                 circuit.difficulty, circuit.tags, circuit.image_url, circuit.components,
                 circuit.description, circuit.verified, circuit.category],
                (err) => { 
                    if (err) console.error(`      Insert error: ${err.message}`);
                    resolve(); 
                });
        });
        
        added++;
        console.log(`      ✅ Added: ${circuit.effect_name}`);
    }
    
    console.log(`   📊 Static scrape complete: +${added} new, ${skipped} duplicates`);
    
    // Update last_scraped
    await new Promise((resolve) => {
        db.run("UPDATE rss_feeds SET last_scraped = CURRENT_TIMESTAMP WHERE id = ?", [feed.id], () => resolve());
    });
    
    return { added, skipped };
}

async function autoExportToJSON(db) {
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
        console.log("No enabled feeds found.");
        db.close();
        return { added: 0, skipped: 0 };
    }
    
    console.log(`Found ${feeds.length} feeds\n`);
    
    let totalAdded = 0;
    let totalSkipped = 0;
    
    for (const feed of feeds) {
        console.log(`📡 Processing: ${feed.name}`);
        
        try {
            let addedFromFeed = 0;
            let skippedFromFeed = 0;
            
            // Check source type
            if (feed.source_type === 'static_html') {
                const result = await scrapeStaticHtmlSource(feed, db);
                addedFromFeed = result.added;
                skippedFromFeed = result.skipped;
            } else {
                const { items, feedType } = await fetchAllPages(feed.url);
                console.log(`   Processing ${items.length} total items...`);
                
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
                        skippedFromFeed++;
                        continue;
                    }
                    
                    let extracted;
                    if (feedType === 'atom') {
                        extracted = await processAtomEntry(item);
                    } else {
                        extracted = await processRssEntry(item);
                    }
                    
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
                    
                    addedFromFeed++;
                    console.log(`   ✅ Added: ${extracted.effect_name}`);
                }
            }
            
            totalAdded += addedFromFeed;
            totalSkipped += skippedFromFeed;
            console.log(`   📊 Feed summary: +${addedFromFeed} new, ${skippedFromFeed} duplicates`);
            
            // Update last_scraped timestamp
            await new Promise((resolve) => {
                db.run("UPDATE rss_feeds SET last_scraped = CURRENT_TIMESTAMP WHERE id = ?", [feed.id], () => resolve());
            });
            
        } catch (error) {
            console.error(`   ❌ Error processing feed: ${error.message}`);
        }
    }
    
    console.log(`\n✅ Scraping complete! Added ${totalAdded} new circuits, Skipped ${totalSkipped} duplicates`);
    
    // Export to JSON
    await autoExportToJSON(db);
    
    db.close();
    return { added: totalAdded, skipped: totalSkipped };
}

// Export for use in server.js
export async function runScraper(db, autoExportToJSON) {
    console.log("🕷️ Running scraper...");
    return await scrapeAllFeeds();
}

export async function scrapeSingleFeed(db, autoExportToJSON, feedId) {
    console.log(`🕷️ Scraping single feed ID: ${feedId}`);
    return await scrapeAllFeeds();
}

export { scrapeStaticListing };

// Run directly if called from command line
const isRunningDirectly = process.argv[1] && (
    process.argv[1].includes('scraper.js') || 
    process.argv[1].endsWith('scraper.js')
);

if (isRunningDirectly) {
    console.log("🚀 Running scraper directly...");
    scrapeAllFeeds().catch(console.error);
}