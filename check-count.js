import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./circuits.db');

db.get("SELECT COUNT(*) as count FROM circuits", (err, row) => {
    if (err) {
        console.error("Error:", err.message);
    } else {
        console.log(`📊 Total circuits in database: ${row.count}`);
    }
    db.close();
});