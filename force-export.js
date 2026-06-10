/*
 * ============================================================================
 * Circuit Scout - Force Export Tool
 * Version 1.0.0
 * Designed & Developed by Tim Samoff
 * 
 * Manually exports the entire database to data/circuits.json
 * Use this when you need to force a full export
 * 
 * @license MIT
 * @see https://samoff.com/circuit-scout
 * ============================================================================
 */

import sqlite3 from 'sqlite3';
import fs from 'fs';

const db = new sqlite3.Database('./circuits.db');

console.log('🔄 Force exporting circuits to JSON...');

db.all("SELECT * FROM circuits ORDER BY created_at DESC", (err, rows) => {
    if (err) {
        console.error('❌ Error:', err);
        db.close();
        return;
    }
    
    console.log(`📊 Found ${rows.length} circuits in database`);
    
    // Simplify the data for JSON
    const exportData = rows.map(row => ({
        id: row.id,
        url: row.url,
        effect_name: row.effect_name,
        type: row.type,
        parts_count: row.parts_count,
        difficulty: row.difficulty,
        tags: row.tags ? JSON.parse(row.tags) : [],
        image_url: row.image_url,
        description: row.description,
        verified: row.verified === 1,
        category: row.category || 'circuit'
    }));
    
    // Ensure data directory exists
    if (!fs.existsSync('./data')) {
        fs.mkdirSync('./data');
    }
    
    // Write to file
    fs.writeFileSync('./data/circuits.json', JSON.stringify(exportData, null, 2));
    
    // Check file size
    const stats = fs.statSync('./data/circuits.json');
    const fileSizeKB = (stats.size / 1024).toFixed(2);
    
    console.log(`✅ Exported ${exportData.length} circuits to data/circuits.json`);
    console.log(`📦 File size: ${fileSizeKB} KB`);
    
    db.close();
});