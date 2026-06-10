const sqlite3 = require('sqlite3');
const fs = require('fs');

const db = new sqlite3.Database('./circuits.db');

db.get("SELECT COUNT(*) as count FROM circuits", (err, dbRow) => {
    if (err) {
        console.error("DB error:", err);
        return;
    }
    
    try {
        const jsonData = fs.readFileSync('./data/circuits.json', 'utf8');
        const circuits = JSON.parse(jsonData);
        
        console.log(`📊 Database count: ${dbRow.count}`);
        console.log(`📊 JSON count:      ${circuits.length}`);
        
        if (dbRow.count === circuits.length) {
            console.log('✅ Counts match! JSON is up to date.');
        } else {
            console.log(`⚠️ Counts don't match! Difference: ${dbRow.count - circuits.length}`);
            console.log('   Run the scraper to update JSON.');
        }
        
    } catch (err) {
        console.error("Error reading JSON:", err.message);
    }
    
    db.close();
});