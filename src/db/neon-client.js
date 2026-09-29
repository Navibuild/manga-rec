'use strict';
const { neon } = require('@neondatabase/serverless');

function getNeonClient(databaseUrl) {
    const sql = neon(databaseUrl);

    return {
        async query(text, params = []) {
            const rows = await sql.query(text, params);
            return { rows };
        },
    };
}

module.exports = { getNeonClient };