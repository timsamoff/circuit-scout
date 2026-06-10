import axios from 'axios';
import { parseStringPromise } from 'xml2js';

async function checkFeedTotal() {
    console.log('Checking feed total items...\n');
    
    const url = 'https://tagboardeffects.blogspot.com/feeds/posts/default';
    let allItems = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;
    
    while (hasMore && page <= 5) { // Check first 5 pages to see pattern
        const startIndex = (page - 1) * pageSize + 1;
        const pageUrl = `${url}?start-index=${startIndex}&max-results=${pageSize}`;
        
        try {
            console.log(`Fetching page ${page} (items ${startIndex}-${startIndex + pageSize - 1})...`);
            const response = await axios.get(pageUrl, {
                timeout: 30000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            });
            
            const parsed = await parseStringPromise(response.data);
            const items = parsed.feed?.entry || [];
            
            console.log(`  Found ${items.length} items on this page`);
            allItems = [...allItems, ...items];
            
            if (items.length < pageSize) {
                console.log(`  Last page reached (got ${items.length} < ${pageSize})`);
                hasMore = false;
            } else {
                console.log(`  Continuing to next page...`);
            }
            
            page++;
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (error) {
            console.error(`Error on page ${page}:`, error.message);
            hasMore = false;
        }
    }
    
    console.log(`\n📊 Total items fetched from feed: ${allItems.length}`);
    console.log(`📊 Circuits in database: 1299`);
    
    if (allItems.length > 0) {
        const oldestItem = allItems[allItems.length - 1];
        console.log(`\n📝 Oldest item in feed (page ${page - 1}):`);
        console.log(`   Title: ${oldestItem.title?.[0]?._ || oldestItem.title?.[0]}`);
        console.log(`   Date: ${oldestItem.published?.[0]}`);
    }
}

checkFeedTotal();