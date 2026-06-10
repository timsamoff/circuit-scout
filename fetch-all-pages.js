import axios from 'axios';
import { parseStringPromise } from 'xml2js';

async function fetchAllPages() {
    console.log('Fetching ALL pages from Tagboard Effects feed...\n');
    
    const url = 'https://tagboardeffects.blogspot.com/feeds/posts/default';
    let page = 1;
    const pageSize = 100;
    let hasMore = true;
    let allItems = [];
    
    while (hasMore) {
        const startIndex = (page - 1) * pageSize + 1;
        const pageUrl = `${url}?start-index=${startIndex}&max-results=${pageSize}`;
        
        try {
            console.log(`Fetching page ${page} (items ${startIndex}-${startIndex + pageSize - 1})...`);
            const response = await axios.get(pageUrl, {
                timeout: 30000,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
            });
            
            const parsed = await parseStringPromise(response.data);
            const items = parsed.feed?.entry || [];
            
            console.log(`  Found ${items.length} items`);
            allItems = [...allItems, ...items];
            
            if (items.length < pageSize) {
                console.log(`  Last page reached!`);
                hasMore = false;
            } else {
                console.log(`  Continuing to next page...`);
                page++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
        } catch (error) {
            console.error(`Error on page ${page}:`, error.message);
            hasMore = false;
        }
    }
    
    console.log(`\n📊 TOTAL items in Tagboard Effects feed: ${allItems.length}`);
    console.log(`📊 Your database has: 1299 circuits (from both feeds)`);
    
    if (allItems.length > 0) {
        const oldest = allItems[allItems.length - 1];
        console.log(`\n📝 Oldest post in feed:`);
        console.log(`   Title: ${oldest.title?.[0]?._ || oldest.title?.[0]}`);
        console.log(`   Date: ${oldest.published?.[0]}`);
    }
}

fetchAllPages();