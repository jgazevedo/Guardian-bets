const { pool } = require('./database');

// Get user points and create if doesn't exist
async function getUserData(userId) {
  try {
    const result = await pool.query('SELECT * FROM user_points WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
      await pool.query(`
        INSERT INTO user_points (user_id, points, total_earned) 
        VALUES ($1, 100, 100)
      `, [userId]);
      return {
        user_id: userId,
        points: 100,
        daily_claimed_at: null,
        total_earned: 100,
        total_spent: 0,
        level: 1,
        experience: 0
      };
    }
    return result.rows[0];
  } catch (error) {
    console.error('Error getting user data:', error);
    return null;
  }
}

// Update user points
async function updateUserPoints(userId, points, transaction = null) {
  try {
    await pool.query(`
      INSERT INTO user_points (user_id, points, updated_at) 
      VALUES ($1, $2, CURRENT_TIMESTAMP) 
      ON CONFLICT (user_id) 
      DO UPDATE SET points = $2, updated_at = CURRENT_TIMESTAMP
    `, [userId, points]);
    
    // Log transaction if provided
    if (transaction) {
      await logTransaction(userId, transaction.type, transaction.amount, transaction.description, transaction.reference_id);
    }
    
    return true;
  } catch (error) {
    console.error('Error updating user points:', error);
    return false;
  }
}

// Add experience and handle level ups
async function addExperience(userId, exp) {
  try {
    const userData = await getUserData(userId);
    const newExp = userData.experience + exp;
    const newLevel = Math.floor(newExp / 100) + 1;
    
    await pool.query(`
      UPDATE user_points 
      SET experience = $1, level = $2, updated_at = CURRENT_TIMESTAMP 
      WHERE user_id = $3
    `, [newExp, newLevel, userId]);
    
    return { levelUp: newLevel > userData.level, newLevel, newExp };
  } catch (error) {
    console.error('Error adding experience:', error);
    return null;
  }
}

// Log transaction
async function logTransaction(userId, type, amount, description, referenceId = null) {
  try {
    await pool.query(`
      INSERT INTO transactions (user_id, type, amount, description, reference_id) 
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, type, amount, description, referenceId]);
  } catch (error) {
    console.error('Error logging transaction:', error);
  }
}

// Check if user can claim daily bonus
async function canClaimDaily(userId) {
  try {
    const userData = await getUserData(userId);
    if (!userData.daily_claimed_at) return true;
    
    const lastClaim = new Date(userData.daily_claimed_at);
    const now = new Date();
    const timeDiff = now - lastClaim;
    const hoursDiff = timeDiff / (1000 * 60 * 60);
    
    return hoursDiff >= 24;
  } catch (error) {
    console.error('Error checking daily claim:', error);
    return false;
  }
}

// Claim daily bonus
async function claimDaily(userId) {
  try {
    const userData = await getUserData(userId);
    const baseBonus = 50;
    const levelBonus = userData.level * 5;
    const totalBonus = baseBonus + levelBonus;
    
    const newPoints = userData.points + totalBonus;
    
    await pool.query(`
      UPDATE user_points 
      SET points = $1, daily_claimed_at = CURRENT_TIMESTAMP, total_earned = total_earned + $2
      WHERE user_id = $3
    `, [newPoints, totalBonus, userId]);
    
    await logTransaction(userId, 'DAILY_BONUS', totalBonus, `Daily bonus (Level ${userData.level})`);
    
    return { bonus: totalBonus, newPoints };
  } catch (error) {
    console.error('Error claiming daily bonus:', error);
    return null;
  }
}

module.exports = {
  getUserData,
  updateUserPoints,
  addExperience,
  logTransaction,
  canClaimDaily,
  claimDaily
};