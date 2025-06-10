const { pool } = require('./database');
const { getUserData, updateUserPoints, logTransaction } = require('./userService');

// Create betting options table if it doesn't exist
async function initBettingOptions() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS betting_options (
        id SERIAL PRIMARY KEY,
        pool_id INTEGER REFERENCES betting_pools(id),
        option_name VARCHAR(255) NOT NULL,
        total_bets INTEGER DEFAULT 0,
        total_amount INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (error) {
    console.error('Error creating betting_options table:', error);
  }
}

// Get active betting pools
async function getActivePools() {
  try {
    const result = await pool.query(`
      SELECT bp.*, 
             array_agg(
               json_build_object(
                 'id', bo.id,
                 'name', bo.option_name,
                 'total_bets', bo.total_bets,
                 'total_amount', bo.total_amount
               )
             ) as options
      FROM betting_pools bp
      LEFT JOIN betting_options bo ON bp.id = bo.pool_id
      WHERE bp.status = 'active'
      GROUP BY bp.id
      ORDER BY bp.created_at DESC
    `);
    
    return result.rows;
  } catch (error) {
    console.error('Error getting active pools:', error);
    return [];
  }
}

// Place a bet
async function placeBet(userId, poolId, optionId, amount) {
  try {
    // Check if user already has a bet on this pool
    const existingBet = await pool.query(`
      SELECT * FROM user_bets 
      WHERE user_id = $1 AND pool_id = $2
    `, [userId, poolId]);
    
    if (existingBet.rows.length > 0) {
      return { success: false, error: 'You already have a bet on this pool!' };
    }
    
    // Check if user has enough points
    const userData = await getUserData(userId);
    if (userData.points < amount) {
      return { success: false, error: 'Insufficient points!' };
    }
    
    // Get option name
    const optionResult = await pool.query(`
      SELECT option_name FROM betting_options WHERE id = $1
    `, [optionId]);
    
    if (optionResult.rows.length === 0) {
      return { success: false, error: 'Invalid betting option!' };
    }
    
    const optionName = optionResult.rows[0].option_name;
    
    // Start transaction
    await pool.query('BEGIN');
    
    // Deduct points from user
    await updateUserPoints(userId, userData.points - amount, {
      type: 'BET_PLACED',
      amount: -amount,
      description: `Bet on pool #${poolId}: ${optionName}`,
      reference_id: poolId
    });
    
    // Place the bet
    await pool.query(`
      INSERT INTO user_bets (user_id, pool_id, amount, option) 
      VALUES ($1, $2, $3, $4)
    `, [userId, poolId, amount, optionName]);
    
    // Update betting option totals
    await pool.query(`
      UPDATE betting_options 
      SET total_bets = total_bets + 1, total_amount = total_amount + $1
      WHERE id = $2
    `, [amount, optionId]);
    
    // Update pool total
    await pool.query(`
      UPDATE betting_pools 
      SET total_pool = total_pool + $1
      WHERE id = $2
    `, [amount, poolId]);
    
    await pool.query('COMMIT');
    
    return { success: true };
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error placing bet:', error);
    return { success: false, error: 'Failed to place bet!' };
  }
}

// Resolve a betting pool
async function resolvePool(poolId, winningOption, adminId) {
  try {
    await pool.query('BEGIN');
    
    // Get pool data
    const poolResult = await pool.query(`
      SELECT * FROM betting_pools WHERE id = $1 AND status = 'active'
    `, [poolId]);
    
    if (poolResult.rows.length === 0) {
      await pool.query('ROLLBACK');
      return { success: false, error: 'Pool not found or already resolved!' };
    }
    
    const poolData = poolResult.rows[0];
    
    // Get all bets for this pool
    const betsResult = await pool.query(`
      SELECT * FROM user_bets WHERE pool_id = $1
    `, [poolId]);
    
    const allBets = betsResult.rows;
    const winningBets = allBets.filter(bet => bet.option === winningOption);
    const totalPool = poolData.total_pool;
    const winningPool = winningBets.reduce((sum, bet) => sum + bet.amount, 0);
    
    // Calculate and distribute winnings
    for (const bet of winningBets) {
      const winShare = bet.amount / winningPool;
      const payout = Math.floor(totalPool * winShare);
      
      // Update user points
      const userData = await getUserData(bet.user_id);
      await updateUserPoints(bet.user_id, userData.points + payout, {
        type: 'BET_WON',
        amount: payout,
        description: `Won bet on pool #${poolId}: ${winningOption}`,
        reference_id: poolId
      });
      
      // Update bet record with payout
      await pool.query(`
        UPDATE user_bets SET payout = $1 WHERE id = $2
      `, [payout, bet.id]);
    }
    
    // Mark pool as resolved
    await pool.query(`
      UPDATE betting_pools 
      SET status = 'resolved', winning_option = $1
      WHERE id = $2
    `, [winningOption, poolId]);
    
    await pool.query('COMMIT');
    
    return { 
      success: true, 
      winningBets: winningBets.length,
      totalPayout: totalPool,
      winningOption 
    };
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error resolving pool:', error);
    return { success: false, error: 'Failed to resolve pool!' };
  }
}

module.exports = {
  initBettingOptions,
  getActivePools,
  placeBet,
  resolvePool
};