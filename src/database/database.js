const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    // User points table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_points (
        user_id VARCHAR(20) PRIMARY KEY,
        points INTEGER DEFAULT 100,
        daily_claimed_at TIMESTAMP,
        total_earned INTEGER DEFAULT 100,
        total_spent INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        experience INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Betting pools table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS betting_pools (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        creator_id VARCHAR(20),
        status VARCHAR(20) DEFAULT 'active',
        end_date TIMESTAMP,
        winning_option VARCHAR(255),
        total_pool INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // User bets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id),
        amount INTEGER,
        option VARCHAR(255),
        payout INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Loans table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        lender_id VARCHAR(20),
        borrower_id VARCHAR(20),
        amount INTEGER,
        interest_rate DECIMAL(5,4),
        due_date TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        reminder_sent BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Bounties table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bounties (
        id SERIAL PRIMARY KEY,
        creator_id VARCHAR(20),
        title VARCHAR(255),
        description TEXT,
        reward INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        winner_id VARCHAR(20),
        completion_proof TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    
    // Shop items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        description TEXT,
        price INTEGER,
        category VARCHAR(100),
        in_stock BOOLEAN DEFAULT true,
        stock_quantity INTEGER DEFAULT -1,
        purchases_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // User purchases table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_purchases (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        item_id INTEGER REFERENCES shop_items(id),
        quantity INTEGER DEFAULT 1,
        total_cost INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Transactions log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        type VARCHAR(50),
        amount INTEGER,
        description TEXT,
        reference_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

module.exports = { pool, initDatabase };