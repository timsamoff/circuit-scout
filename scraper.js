import axios from "axios";
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

export { scrapeStaticListing };