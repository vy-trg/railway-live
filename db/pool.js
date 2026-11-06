import pg from 'pg';

// SSL comes from DATABASE_URL: sslmode=verify-full for Neon, sslmode=disable for Docker
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => console.error('Idle database client error:', err.message));
