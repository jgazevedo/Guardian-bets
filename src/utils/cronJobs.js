const cron = require('node-cron');
const { pool } = require('../database/database');
const { createEmbed } = require('./helpers');

function startCronJobs(client) {
  // Daily reset for daily bonuses (runs at midnight)
  cron.schedule('0 0 * * *', async () => {
    console.log('🕛 Running daily reset...');
    // Add any daily reset logic here
  });
  
  // Loan reminder system (runs every hour)
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await pool.query(`
        SELECT l.*, up.user_id as borrower_name 
        FROM loans l
        JOIN user_points up ON l.borrower_id = up.user_id
        WHERE l.status = 'active' 
        AND l.due_date <= NOW() + INTERVAL '24 hours'
        AND l.reminder_sent = false
      `);
      
      for (const loan of result.rows) {
        try {
          const borrower = await client.users.fetch(loan.borrower_id);
          const lender = await client.users.fetch(loan.lender_id);
          
          const embed = createEmbed(
            '⏰ Loan Reminder',
            `Your loan #${loan.id} from ${lender.username} is due soon!\n\n` +
            `**Amount to repay:** ${Math.floor(loan.amount * (1 + parseFloat(loan.interest_rate)))} points\n` +
            `**Due date:** ${loan.due_date.toDateString()}\n\n` +
            `Use \`/pay ${loan.id}\` to repay this loan.`,
            0xf39c12
          );
          
          await borrower.send({ embeds: [embed] });
          
          // Mark reminder as sent
          await pool.query('UPDATE loans SET reminder_sent = true WHERE id = $1', [loan.id]);
        } catch (error) {
          console.error(`Failed to send loan reminder for loan ${loan.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Loan reminder cron error:', error);
    }
  });
  
  // Auto-resolve expired betting pools (runs every 30 minutes)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const result = await pool.query(`
        SELECT * FROM betting_pools 
        WHERE status = 'active' 
        AND end_date <= NOW()
      `);
      
      for (const poolData of result.rows) {
        // Mark as expired (admin will need to manually resolve)
        await pool.query(`
          UPDATE betting_pools 
          SET status = 'expired' 
          WHERE id = $1
        `, [poolData.id]);
        
        console.log(`🎯 Betting pool #${poolData.id} has expired and needs resolution`);
      }
    } catch (error) {
      console.error('Auto-resolve pools cron error:', error);
    }
  });
  
  console.log('✅ Cron jobs started successfully');
}

module.exports = { startCronJobs };