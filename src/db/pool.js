'use strict';
const { Pool } = require('pg');
const CONFIG = require('../config');

const pool = new Pool({ connectionString: CONFIG.DATABASE_URL, max: 4 });

pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
});

module.exports = pool;