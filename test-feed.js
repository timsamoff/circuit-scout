import axios from 'axios';
import { parseStringPromise } from 'xml2js';

async function testFeed() {
    console.log('Fetching feed...');
    
    try {
        const response = await axios.get('https://tagboardeffects.blogspot.com/feeds/posts/default?max-results=5', {
            timeout: 30000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        
        const parsed = await parseStringPromise(response.data);
        const items = parsed.feed?.entry || [];
        
        console.log(`Found ${items.length} items`);
        
        if (items.length > 0) {
            console.log('First item title:', items[0].title?.[0]);
            console.log('First item link:', items[0].link?.[0]?.$?.href);
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testFeed();