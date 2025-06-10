const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  EmbedBuilder,
} = require("discord.js")
const { Pool } = require("pg")

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
})

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_points (
        user_id VARCHAR(20) PRIMARY KEY,
        points INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_daily TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS betting_pools (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        creator_id VARCHAR(20),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        message_id VARCHAR(20),
        channel_id VARCHAR(20),
        description TEXT
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_options (
        id SERIAL PRIMARY KEY,
        pool_id INTEGER REFERENCES betting_pools(id) ON DELETE CASCADE,
        option_text VARCHAR(255),
        emoji VARCHAR(10),
        is_correct BOOLEAN DEFAULT FALSE
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id) ON DELETE CASCADE,
        option_id INTEGER REFERENCES pool_options(id) ON DELETE CASCADE,
        amount INTEGER,
        locked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        lender_id VARCHAR(20),
        borrower_id VARCHAR(20),
        amount INTEGER,
        interest_rate INTEGER,
        days INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        due_date TIMESTAMP,
        accepted_at TIMESTAMP
      )
    `)

    // Add unique constraint if it doesn't exist
    try {
      await pool.query(`
    DO $$ 
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                       WHERE constraint_name = 'user_bets_user_pool_unique') THEN
            ALTER TABLE user_bets ADD CONSTRAINT user_bets_user_pool_unique UNIQUE (user_id, pool_id);
            RAISE NOTICE 'Added unique constraint to user_bets table';
        ELSE
            RAISE NOTICE 'Unique constraint already exists';
        END IF;
    END $$;
  `)
      console.log("✅ Unique constraint handled successfully")
    } catch (error) {
      console.error("Error handling unique constraint:", error)
    }

    console.log("✅ Database initialized successfully")
  } catch (error) {
    console.error("❌ Database initialization failed:", error)
  }
}

// Fix database schema - add missing columns and fix data types
async function fixDatabase() {
  try {
    console.log("🔄 Starting database fix...")

    // Fix loans table - change interest_rate to INTEGER to avoid overflow
    try {
      await pool.query(`ALTER TABLE loans ALTER COLUMN interest_rate TYPE INTEGER`)
      console.log("✅ Fixed interest_rate column type in loans table")
    } catch (error) {
      if (error.code === "42804") {
        // Column already correct type or has data that needs conversion
        try {
          await pool.query(`ALTER TABLE loans ALTER COLUMN interest_rate TYPE INTEGER USING interest_rate::INTEGER`)
          console.log("✅ Converted interest_rate column to INTEGER")
        } catch (conversionError) {
          console.log("✅ interest_rate column type already correct or conversion not needed")
        }
      } else {
        console.error("Error fixing interest_rate column:", error)
      }
    }

    // Fix loans table - add days column
    try {
      await pool.query(`ALTER TABLE loans ADD COLUMN days INTEGER`)
      console.log("✅ Added days column to loans table")
      // Set default value for existing loans
      await pool.query(`UPDATE loans SET days = 7 WHERE days IS NULL`)
      console.log("✅ Set default days value for existing loans")
    } catch (error) {
      if (error.code === "42701") {
        console.log("✅ days column already exists")
      } else {
        console.error("Error adding days column:", error)
      }
    }

    // Fix user_points table - add last_daily column
    try {
      await pool.query(`ALTER TABLE user_points ADD COLUMN last_daily TIMESTAMP`)
      console.log("✅ Added last_daily column to user_points table")
    } catch (error) {
      if (error.code === "42701") {
        console.log("✅ last_daily column already exists")
      } else {
        console.error("Error adding last_daily column:", error)
      }
    }

    // Fix loans table - add accepted_at column
    try {
      await pool.query(`ALTER TABLE loans ADD COLUMN accepted_at TIMESTAMP`)
      console.log("✅ Added accepted_at column to loans table")
    } catch (error) {
      if (error.code === "42701") {
        console.log("✅ accepted_at column already exists")
      } else {
        console.error("Error adding accepted_at column:", error)
      }
    }

    // Clean up any invalid loans (self-loans)
    try {
      const deleteResult = await pool.query("DELETE FROM loans WHERE lender_id = borrower_id RETURNING id")
      if (deleteResult.rows.length > 0) {
        console.log(`✅ Deleted ${deleteResult.rows.length} invalid self-loans`)
      } else {
        console.log("✅ No invalid self-loans found")
      }
    } catch (error) {
      console.error("Error cleaning up invalid loans:", error)
    }

    console.log("✅ Database fix completed!")
  } catch (error) {
    console.error("❌ Database fix failed:", error)
  }
}

// Database helper functions
async function getUserPoints(userId) {
  try {
    const result = await pool.query("SELECT points FROM user_points WHERE user_id = $1", [userId])
    if (result.rows.length === 0) return null
    return result.rows[0].points
  } catch (error) {
    console.error("Error getting user points:", error)
    return null
  }
}

async function canClaimDaily(userId) {
  try {
    const result = await pool.query("SELECT last_daily FROM user_points WHERE user_id = $1", [userId])
    if (result.rows.length === 0) return false

    const lastDaily = result.rows[0].last_daily
    if (!lastDaily) return true

    const now = new Date()
    const lastClaim = new Date(lastDaily)
    const hoursSinceLastClaim = (now - lastClaim) / (1000 * 60 * 60)

    return hoursSinceLastClaim >= 24
  } catch (error) {
    console.error("Error checking daily claim:", error)
    return false
  }
}

async function claimDaily(userId) {
  try {
    await pool.query("UPDATE user_points SET last_daily = CURRENT_TIMESTAMP WHERE user_id = $1", [userId])
    return true
  } catch (error) {
    console.error("Error claiming daily:", error)
    return false
  }
}

async function registerUser(userId) {
  try {
    const result = await pool.query(
      `INSERT INTO user_points (user_id, points) VALUES ($1, 1000) 
       ON CONFLICT (user_id) DO NOTHING RETURNING points`,
      [userId],
    )
    return result.rows.length > 0
  } catch (error) {
    console.error("Error registering user:", error)
    return false
  }
}

async function updateUserPoints(userId, points) {
  try {
    await pool.query(
      `INSERT INTO user_points (user_id, points) VALUES ($1, $2) 
       ON CONFLICT (user_id) DO UPDATE SET points = $2`,
      [userId, points],
    )
    return true
  } catch (error) {
    console.error("Error updating user points:", error)
    return false
  }
}

async function createLoan(lenderId, borrowerId, amount, interestRate, days) {
  try {
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + days)

    // Ensure interestRate is an integer to avoid overflow
    const integerInterestRate = Math.floor(interestRate)

    // Only create the loan record - DO NOT deduct points yet
    const result = await pool.query(
      `INSERT INTO loans (lender_id, borrower_id, amount, interest_rate, days, due_date, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
      [lenderId, borrowerId, amount, integerInterestRate, days, dueDate],
    )

    console.log(`Created loan offer ${result.rows[0].id}: ${amount} points from ${lenderId} to ${borrowerId}`)
    return result.rows[0].id
  } catch (error) {
    console.error("Error creating loan:", error)
    return null
  }
}

async function acceptLoan(loanId) {
  try {
    // First, check if loan exists and is still pending
    const loanCheck = await pool.query("SELECT * FROM loans WHERE id = $1", [loanId])
    if (loanCheck.rows.length === 0) {
      console.log(`Loan ${loanId} not found`)
      return null
    }

    const loan = loanCheck.rows[0]
    if (loan.status !== "pending") {
      console.log(`Loan ${loanId} is not pending (status: ${loan.status})`)
      return null
    }

    // Check if lender still has enough points
    const lenderPoints = await getUserPoints(loan.lender_id)
    const borrowerPoints = await getUserPoints(loan.borrower_id)

    if (lenderPoints === null || borrowerPoints === null) {
      console.log(`User points not found - lender: ${lenderPoints}, borrower: ${borrowerPoints}`)
      return null
    }

    if (lenderPoints < loan.amount) {
      console.log(`Lender ${loan.lender_id} has insufficient points: ${lenderPoints} < ${loan.amount}`)
      return null
    }

    // Update loan status to active and set accepted timestamp
    const result = await pool.query(
      `UPDATE loans SET status = 'active', accepted_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [loanId],
    )

    if (result.rows.length === 0) {
      console.log(`Failed to update loan ${loanId} - may have been processed by another request`)
      return null
    }

    const updatedLoan = result.rows[0]

    // Now transfer the points
    await updateUserPoints(loan.lender_id, lenderPoints - loan.amount)
    await updateUserPoints(loan.borrower_id, borrowerPoints + loan.amount)

    console.log(
      `Loan ${loanId} accepted: transferred ${loan.amount} points from ${loan.lender_id} to ${loan.borrower_id}`,
    )

    // Set up auto-collection timer
    const timeUntilDue = new Date(updatedLoan.due_date) - new Date()
    if (timeUntilDue > 0) {
      setTimeout(() => {
        collectLoan(loanId)
      }, timeUntilDue)
    }

    return updatedLoan
  } catch (error) {
    console.error("Error accepting loan:", error)
    return null
  }
}

async function collectLoan(loanId) {
  try {
    const result = await pool.query("SELECT * FROM loans WHERE id = $1 AND status = 'active'", [loanId])

    if (result.rows.length > 0) {
      const loan = result.rows[0]
      const totalOwed = Math.floor(loan.amount * (1 + loan.interest_rate / 100))

      const borrowerPoints = await getUserPoints(loan.borrower_id)
      const lenderPoints = await getUserPoints(loan.lender_id)

      if (borrowerPoints >= totalOwed) {
        await updateUserPoints(loan.borrower_id, borrowerPoints - totalOwed)
        await updateUserPoints(loan.lender_id, lenderPoints + totalOwed)
        await pool.query("UPDATE loans SET status = 'collected' WHERE id = $1", [loanId])
      } else {
        // Borrower can't pay, take what they have
        await updateUserPoints(loan.borrower_id, 0)
        await updateUserPoints(loan.lender_id, lenderPoints + borrowerPoints)
        await pool.query("UPDATE loans SET status = 'defaulted' WHERE id = $1", [loanId])
      }

      console.log(`Auto-collected loan ${loanId}: ${totalOwed} points from user ${loan.borrower_id}`)
    }
  } catch (error) {
    console.error("Error collecting loan:", error)
  }
}

async function payLoan(borrowerId, loanId, amount) {
  try {
    const result = await pool.query("SELECT * FROM loans WHERE id = $1 AND borrower_id = $2 AND status = 'active'", [
      loanId,
      borrowerId,
    ])

    if (result.rows.length === 0) return null

    const loan = result.rows[0]
    const totalOwed = Math.floor(loan.amount * (1 + loan.interest_rate / 100))

    if (amount >= totalOwed) {
      // Full payment
      const borrowerPoints = await getUserPoints(borrowerId)
      const lenderPoints = await getUserPoints(loan.lender_id)

      await updateUserPoints(borrowerId, borrowerPoints - totalOwed)
      await updateUserPoints(loan.lender_id, lenderPoints + totalOwed)
      await pool.query("UPDATE loans SET status = 'paid' WHERE id = $1", [loanId])

      return { type: "full", amount: totalOwed, remaining: 0 }
    } else {
      // Partial payment (not implemented in this version)
      return { type: "insufficient", needed: totalOwed - amount }
    }
  } catch (error) {
    console.error("Error paying loan:", error)
    return null
  }
}

async function getUserLoans(userId) {
  try {
    const result = await pool.query(
      `SELECT l.*, 
       CASE 
         WHEN l.borrower_id = $1 THEN 'borrower'
         WHEN l.lender_id = $1 THEN 'lender'
       END as role
       FROM loans l 
       WHERE (l.borrower_id = $1 OR l.lender_id = $1) AND l.status IN ('pending', 'active')
       ORDER BY l.created_at DESC`,
      [userId],
    )
    return result.rows
  } catch (error) {
    console.error("Error getting user loans:", error)
    return []
  }
}

async function clearLoanById(loanId) {
  try {
    const result = await pool.query("DELETE FROM loans WHERE id = $1 RETURNING *", [loanId])
    return result.rows.length > 0 ? result.rows[0] : null
  } catch (error) {
    console.error("Error clearing loan by ID:", error)
    return null
  }
}

async function clearLoansByStatus(status) {
  try {
    let query = "DELETE FROM loans WHERE status = $1 RETURNING *"
    let params = [status]

    // Special case for self-loans
    if (status === "self") {
      query = "DELETE FROM loans WHERE lender_id = borrower_id RETURNING *"
      params = []
    }

    const result = await pool.query(query, params)
    return result.rows
  } catch (error) {
    console.error("Error clearing loans by status:", error)
    return []
  }
}

async function createPool(creatorId, title, options) {
  try {
    const result = await pool.query("INSERT INTO betting_pools (creator_id, title) VALUES ($1, $2) RETURNING id", [
      creatorId,
      title,
    ])
    const poolId = result.rows[0].id

    for (const { text, emoji } of options) {
      await pool.query("INSERT INTO pool_options (pool_id, option_text, emoji) VALUES ($1, $2, $3)", [
        poolId,
        text || "Option",
        emoji || "",
      ])
    }
    return poolId
  } catch (error) {
    console.error("Error creating pool:", error)
    return null
  }
}

async function getOpenPools(creatorId) {
  try {
    return await pool.query("SELECT id, title FROM betting_pools WHERE status = $1", ["active"])
  } catch (error) {
    console.error("Error getting open pools:", error)
    return { rows: [] }
  }
}

async function getAllActiveBets() {
  try {
    const result = await pool.query(`
      SELECT 
        bp.id as pool_id,
        bp.title,
        bp.creator_id,
        po.id as option_id,
        po.option_text,
        po.emoji,
        COUNT(ub.id) as bet_count,
        COALESCE(SUM(ub.amount), 0) as total_staked
      FROM betting_pools bp
      LEFT JOIN pool_options po ON bp.id = po.pool_id
      LEFT JOIN user_bets ub ON po.id = ub.option_id
      WHERE bp.status = 'active'
      GROUP BY bp.id, bp.title, bp.creator_id, po.id, po.option_text, po.emoji
      ORDER BY bp.created_at DESC, po.id ASC
    `)
    return result.rows
  } catch (error) {
    console.error("Error getting all active bets:", error)
    return []
  }
}

async function getPoolOptions(poolId) {
  try {
    return await pool.query("SELECT id, option_text, emoji FROM pool_options WHERE pool_id = $1", [poolId])
  } catch (error) {
    console.error("Error getting pool options:", error)
    return { rows: [] }
  }
}

async function getUserBet(userId, poolId) {
  try {
    const result = await pool.query(
      `SELECT ub.*, po.option_text, po.emoji 
       FROM user_bets ub 
       JOIN pool_options po ON ub.option_id = po.id 
       WHERE ub.user_id = $1 AND ub.pool_id = $2`,
      [userId, poolId],
    )
    return result.rows[0] || null
  } catch (error) {
    console.error("Error getting user bet:", error)
    return null
  }
}

async function recordBet(userId, poolId, optionId, amount) {
  try {
    // Check if user already has a bet on this pool
    const existingBet = await getUserBet(userId, poolId)

    if (existingBet) {
      // User already has a bet - don't allow changes
      return false
    } else {
      // Insert new bet and lock it immediately
      await pool.query(
        `INSERT INTO user_bets (user_id, pool_id, option_id, amount, locked_at) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [userId, poolId, optionId, amount],
      )

      // Deduct points for new bet
      const currentPoints = await getUserPoints(userId)
      await updateUserPoints(userId, currentPoints - amount)
    }

    return true
  } catch (error) {
    console.error("Error recording bet:", error)
    return false
  }
}

async function lockBet(userId, poolId) {
  try {
    const result = await pool.query(
      "UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND pool_id = $2 AND locked_at IS NULL RETURNING *",
      [userId, poolId],
    )
    console.log(`Locked bet for user ${userId} on pool ${poolId}`)
    return result.rows.length > 0
  } catch (error) {
    console.error("Error locking bet:", error)
    return false
  }
}

async function cancelBet(userId, poolId) {
  try {
    const result = await pool.query(
      "DELETE FROM user_bets WHERE user_id = $1 AND pool_id = $2 AND locked_at IS NULL RETURNING amount",
      [userId, poolId],
    )

    if (result.rows.length > 0) {
      // Refund points
      const refundAmount = result.rows[0].amount
      const currentPoints = await getUserPoints(userId)
      await updateUserPoints(userId, currentPoints + refundAmount)
      return refundAmount
    }
    return 0
  } catch (error) {
    console.error("Error canceling bet:", error)
    return 0
  }
}

async function cancelPool(poolId, creatorId) {
  try {
    // Check if the pool exists and belongs to the creator
    const poolResult = await pool.query(
      "SELECT * FROM betting_pools WHERE id = $1 AND creator_id = $2 AND status = 'active'",
      [poolId, creatorId],
    )

    if (poolResult.rows.length === 0) {
      return { success: false, message: "Pool not found or you're not the creator" }
    }

    // Get all bets for this pool
    const betsResult = await pool.query("SELECT user_id, amount FROM user_bets WHERE pool_id = $1", [poolId])

    // Refund all bets
    for (const bet of betsResult.rows) {
      const currentPoints = await getUserPoints(bet.user_id)
      await updateUserPoints(bet.user_id, currentPoints + bet.amount)
    }

    // Delete the pool (cascade will delete options and bets)
    await pool.query("DELETE FROM betting_pools WHERE id = $1", [poolId])

    return {
      success: true,
      message: `Pool cancelled successfully. Refunded ${betsResult.rows.length} bets.`,
      refundCount: betsResult.rows.length,
    }
  } catch (error) {
    console.error("Error canceling pool:", error)
    return { success: false, message: "Error canceling pool" }
  }
}

async function closePool(poolId, correctOptionId) {
  try {
    console.log(`Closing pool ${poolId} with correct option ${correctOptionId}`)

    // First, lock all unlocked bets for this pool
    const lockResult = await pool.query(
      "UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE pool_id = $1 AND locked_at IS NULL RETURNING user_id, amount",
      [poolId],
    )
    console.log(`Locked ${lockResult.rows.length} bets before closing pool`)

    // Get pool information
    const poolInfo = await pool.query("SELECT title FROM betting_pools WHERE id = $1", [poolId])
    const poolTitle = poolInfo.rows[0]?.title || "Unknown Pool"

    // Close the pool
    await pool.query("UPDATE betting_pools SET status = $1 WHERE id = $2", ["closed", poolId])

    // Mark the correct option
    await pool.query("UPDATE pool_options SET is_correct = TRUE WHERE id = $1", [correctOptionId])

    // Get the correct option name
    const correctOptionInfo = await pool.query("SELECT option_text, emoji FROM pool_options WHERE id = $1", [
      correctOptionId,
    ])
    const correctOptionName = correctOptionInfo.rows[0]?.option_text || "Unknown Option"
    const correctOptionEmoji = correctOptionInfo.rows[0]?.emoji || ""

    // Get all locked bets for this pool
    const allBets = await pool.query(
      `SELECT ub.user_id, ub.amount, ub.option_id, po.option_text, po.emoji
       FROM user_bets ub 
       JOIN pool_options po ON ub.option_id = po.id
       WHERE ub.pool_id = $1 AND ub.locked_at IS NOT NULL`,
      [poolId],
    )

    console.log(`Found ${allBets.rows.length} locked bets for pool ${poolId}`)

    if (allBets.rows.length === 0) {
      console.log("No locked bets found")
      return {
        success: true,
        poolTitle,
        correctOption: `${correctOptionName} ${correctOptionEmoji}`,
        totalPool: 0,
        winners: [],
        message: "No bets were placed on this pool.",
      }
    }

    // Get winning bets
    const winningBets = allBets.rows.filter((bet) => bet.option_id == correctOptionId)
    console.log(`Found ${winningBets.length} winning bets`)

    // Calculate totals
    const totalPool = allBets.rows.reduce((sum, bet) => sum + bet.amount, 0)
    const totalWinningStake = winningBets.reduce((sum, bet) => sum + bet.amount, 0)

    console.log(`Total pool: ${totalPool}, Total winning stake: ${totalWinningStake}`)

    const winners = []

    if (winningBets.length === 0) {
      console.log("No winning bets - house keeps all")
      return {
        success: true,
        poolTitle,
        correctOption: `${correctOptionName} ${correctOptionEmoji}`,
        totalPool,
        winners: [],
        message: "No one bet on the correct option. House wins!",
      }
    }

    // Winners split the entire pool proportionally to their winning bets
    for (const bet of winningBets) {
      const winnerShare = bet.amount / totalWinningStake // Their proportion of winning bets
      const payout = Math.floor(totalPool * winnerShare) // Their share of the entire pool

      const currentPoints = (await getUserPoints(bet.user_id)) || 0
      await updateUserPoints(bet.user_id, currentPoints + payout)

      winners.push({
        userId: bet.user_id,
        betAmount: bet.amount,
        payout: payout,
        profit: payout - bet.amount,
      })

      console.log(
        `Awarded ${payout} points to user ${bet.user_id} (bet: ${bet.amount}, share: ${winnerShare.toFixed(3)}, profit: ${payout - bet.amount})`,
      )
    }

    // Create a detailed winners breakdown message
    let winnersBreakdown = ""
    winners.forEach((winner, index) => {
      winnersBreakdown += `<@${winner.userId}>: won ${formatNumber(winner.payout)} points`
      if (index < winners.length - 1) {
        winnersBreakdown += ". "
      }
    })

    return {
      success: true,
      poolTitle,
      correctOption: `${correctOptionName} ${correctOptionEmoji}`,
      totalPool,
      winners,
      winnersBreakdown,
      message: `Pool closed successfully! ${winners.length} winner(s) shared the ${formatNumber(totalPool)} point pool. ${winnersBreakdown}`,
    }
  } catch (error) {
    console.error("Error closing pool:", error)
    return {
      success: false,
      message: "Error closing pool",
    }
  }
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function parseOptionText(optionText) {
  const emojiRegex =
    /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
  const emojis = optionText.match(emojiRegex)
  const text = optionText.replace(emojiRegex, "").trim()

  return {
    text: text || "Option",
    emoji: emojis ? emojis[0] : null,
  }
}

// Admin user IDs
const adminUserIds = ["121564489043804161"]

// Check if user is an admin
function isAdmin(userId, member) {
  const hasAdminPermission = member.permissions.has(PermissionFlagsBits.Administrator)
  const isHardcodedAdmin = adminUserIds.includes(userId)
  return hasAdminPermission || isHardcodedAdmin
}

// Pool state management
const activePools = new Map()

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
})

// Slash commands
const commands = [
  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily points bonus (once per 24 hours)"),
  new SlashCommandBuilder().setName("participate").setDescription("Join the bot and receive 1000 starting points"),
  new SlashCommandBuilder().setName("wallet").setDescription("Check your current points balance"),
  new SlashCommandBuilder().setName("mybets").setDescription("View your current active bets"),
  new SlashCommandBuilder().setName("allbets").setDescription("View all active betting pools and their current status"),
  new SlashCommandBuilder().setName("myloans").setDescription("View your active loans (borrowed and lent)"),
  new SlashCommandBuilder()
    .setName("lend")
    .setDescription("Lend points to another user")
    .addUserOption((option) => option.setName("user").setDescription("The user to lend points to").setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Amount of points to lend")
        .setRequired(true)
        .setMinValue(10)
        .setMaxValue(999999),
    )
    .addIntegerOption((option) =>
      option
        .setName("interest")
        .setDescription("Interest rate percentage (e.g., 5 for 5%)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100),
    )
    .addIntegerOption((option) =>
      option
        .setName("days")
        .setDescription("Number of days for repayment")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(365),
    ),
  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Pay back a loan early")
    .addIntegerOption((option) =>
      option.setName("loan_id").setDescription("The ID of the loan to pay back").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add points to a user (Admin only)")
    .addUserOption((option) => option.setName("user").setDescription("The user to add points to").setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Amount of points to add")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove points from a user (Admin only)")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user to remove points from").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Amount of points to remove")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("create").setDescription("Create a new betting pool"),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close a betting pool and select the correct answer (Admin or creator only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("cancel").setDescription("Cancel a betting pool you created (refunds all bets)"),
  new SlashCommandBuilder()
    .setName("clearloan")
    .setDescription("Clear loans from the system (Admin only)")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("id")
        .setDescription("Clear a specific loan by ID")
        .addIntegerOption((option) =>
          option.setName("loan_id").setDescription("The ID of the loan to clear").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Clear all loans with a specific status")
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("The status of loans to clear")
            .setRequired(true)
            .addChoices(
              { name: "Pending", value: "pending" },
              { name: "Active", value: "active" },
              { name: "Collected", value: "collected" },
              { name: "Paid", value: "paid" },
              { name: "Rejected", value: "rejected" },
              { name: "Self-loans", value: "self" },
            ),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
]

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN)
    console.log("🔄 Started refreshing application (/) commands.")
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] })
    console.log("✅ Cleared global commands.")
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, "979180991836995674"), {
      body: commands,
    })
    console.log("✅ Successfully reloaded guild-specific commands (instant update).")
  } catch (error) {
    console.error("❌ Error registering commands:", error)
  }
}

// Bot event handlers
client.once("ready", async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`)
  await initDatabase()
  await fixDatabase() // This will fix your database schema
  await registerCommands()
})

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName, user, member } = interaction
    try {
      console.log(`Command: ${commandName}, User: ${user.id}`)

      switch (commandName) {
        case "daily": {
          const currentPoints = await getUserPoints(user.id)
          if (currentPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const canClaim = await canClaimDaily(user.id)
          if (!canClaim) {
            await interaction.reply({
              content: "❌ You have already claimed your daily bonus! You can claim again in 24 hours.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const dailyBonus = 100
          const newPoints = currentPoints + dailyBonus
          await updateUserPoints(user.id, newPoints)
          await claimDaily(user.id)

          await interaction.reply({
            content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!
💰 New balance: **${formatNumber(newPoints)}** points`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "participate": {
          const isNewUser = await registerUser(user.id)
          if (isNewUser) {
            await interaction.reply({
              content: `✅ **Welcome!** You've joined the bot and received **1000** starting points!`,
              flags: MessageFlags.Ephemeral,
            })
          } else {
            await interaction.reply({
              content: `❌ You've already joined the bot! Use /wallet to check your balance.`,
              flags: MessageFlags.Ephemeral,
            })
          }
          break
        }

        case "wallet": {
          const points = await getUserPoints(user.id)
          if (points === null) {
            await interaction.reply({
              content: `❌ You haven't joined yet! Use /participate to start with 1000 points.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }
          await interaction.reply({
            content: `💰 **${user.username}**, your current balance is **${formatNumber(points)}** points!`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "mybets": {
          const userPoints = await getUserPoints(user.id)
          if (userPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const activeBets = await pool.query(
            `SELECT ub.*, bp.title, po.option_text, po.emoji, bp.status
             FROM user_bets ub
             JOIN betting_pools bp ON ub.pool_id = bp.id
             JOIN pool_options po ON ub.option_id = po.id
             WHERE ub.user_id = $1 AND bp.status = 'active'
             ORDER BY ub.created_at DESC`,
            [user.id],
          )

          if (activeBets.rows.length === 0) {
            await interaction.reply({
              content: "📊 You have no active bets right now.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const embed = new EmbedBuilder()
            .setTitle("📊 Your Active Bets")
            .setColor(0x00ae86)
            .setFooter({ text: `Balance: ${formatNumber(userPoints)} points` })

          for (const bet of activeBets.rows) {
            embed.addFields({
              name: bet.title,
              value: `**Bet:** ${formatNumber(bet.amount)} points on "${bet.option_text}" ${bet.emoji || ""}
**Status:** 🔒 Locked`,
              inline: false,
            })
          }

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
          break
        }

        case "allbets": {
          const allBets = await getAllActiveBets()

          if (allBets.length === 0) {
            await interaction.reply({
              content: "📊 No active betting pools right now.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          // Group bets by pool
          const poolsMap = new Map()

          for (const bet of allBets) {
            if (!poolsMap.has(bet.pool_id)) {
              poolsMap.set(bet.pool_id, {
                title: bet.title,
                creator_id: bet.creator_id,
                options: [],
                totalStaked: 0,
              })
            }

            const pool = poolsMap.get(bet.pool_id)
            pool.options.push({
              text: bet.option_text,
              emoji: bet.emoji,
              betCount: bet.bet_count,
              totalStaked: bet.total_staked,
            })
            pool.totalStaked += bet.total_staked
          }

          const embed = new EmbedBuilder()
            .setTitle("📊 All Active Betting Pools")
            .setColor(0x3498db)
            .setDescription("Here are all the current active betting pools:")

          for (const [poolId, poolData] of poolsMap) {
            let optionsText = ""
            for (const option of poolData.options) {
              optionsText += `${option.emoji || "•"} **${option.text}**: ${option.betCount} bets (${formatNumber(option.totalStaked)} points)\n`
            }

            let fieldValue = `**Options:**\n${optionsText}`
            fieldValue += `\n**Total Pool:** ${formatNumber(poolData.totalStaked)} points`
            fieldValue += `\n**Created by:** <@${poolData.creator_id}>`

            embed.addFields({
              name: `🎲 ${poolData.title}`,
              value: fieldValue,
              inline: false,
            })
          }

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
          break
        }

        case "myloans": {
          const userPoints = await getUserPoints(user.id)
          if (userPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const loans = await getUserLoans(user.id)
          if (loans.length === 0) {
            await interaction.reply({
              content: "💳 You have no active loans right now.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const embed = new EmbedBuilder()
            .setTitle("💳 Your Active Loans")
            .setColor(0x3498db)
            .setFooter({ text: `Balance: ${formatNumber(userPoints)} points` })

          for (const loan of loans) {
            const totalOwed = Math.floor(loan.amount * (1 + loan.interest_rate / 100))
            const dueDate = new Date(loan.due_date).toLocaleDateString()

            if (loan.role === "borrower") {
              embed.addFields({
                name: `💸 Borrowed (ID: ${loan.id})`,
                value: `**Amount:** ${formatNumber(loan.amount)} points
**Interest:** ${loan.interest_rate}%
**Total to pay:** ${formatNumber(totalOwed)} points
**Due:** ${dueDate}
**Status:** ${loan.status}`,
                inline: false,
              })
            } else {
              embed.addFields({
                name: `💰 Lent (ID: ${loan.id})`,
                value: `**Amount:** ${formatNumber(loan.amount)} points
**Interest:** ${loan.interest_rate}%
**Will receive:** ${formatNumber(totalOwed)} points
**Due:** ${dueDate}
**Status:** ${loan.status}`,
                inline: false,
              })
            }
          }

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
          break
        }

        case "lend": {
          const lender = user
          const borrower = interaction.options.getUser("user")
          const amount = interaction.options.getInteger("amount")
          const interest = interaction.options.getInteger("interest")
          const days = interaction.options.getInteger("days")

          // Check self-lending FIRST, before any other operations
          if (borrower.id === lender.id) {
            await interaction.reply({
              content: "❌ You cannot lend points to yourself!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const lenderPoints = await getUserPoints(lender.id)
          if (lenderPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const borrowerPoints = await getUserPoints(borrower.id)
          if (borrowerPoints === null) {
            await interaction.reply({
              content: `❌ ${borrower.username} has not joined the bot yet! They must use /participate first.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          if (lenderPoints < amount) {
            await interaction.reply({
              content: `❌ Insufficient points! You only have **${formatNumber(lenderPoints)}** points.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const loanId = await createLoan(lender.id, borrower.id, amount, interest, days)
          if (!loanId) {
            await interaction.reply({
              content: "❌ Failed to create loan. Please try again.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const totalOwed = Math.floor(amount * (1 + interest / 100))
          const acceptButton = new ButtonBuilder()
            .setCustomId(`accept_loan_${loanId}`)
            .setLabel("Accept Loan")
            .setStyle(ButtonStyle.Success)

          const rejectButton = new ButtonBuilder()
            .setCustomId(`reject_loan_${loanId}`)
            .setLabel("Reject Loan")
            .setStyle(ButtonStyle.Danger)

          const row = new ActionRowBuilder().addComponents(acceptButton, rejectButton)

          await interaction.reply({
            content: `💳 **Loan Offer**

${borrower}, ${lender.username} wants to lend you **${formatNumber(amount)}** points!

**Terms:**
• Interest rate: ${interest}%
• Repayment period: ${days} days
• Total to repay: **${formatNumber(totalOwed)}** points

Do you accept this loan?`,
            components: [row],
          })
          break
        }

        case "pay": {
          const loanId = interaction.options.getInteger("loan_id")
          const userPoints = await getUserPoints(user.id)

          if (userPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const result = await payLoan(user.id, loanId, userPoints)
          if (!result) {
            await interaction.reply({
              content: "❌ Loan not found or already paid!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          if (result.type === "full") {
            await interaction.reply({
              content: `✅ Loan paid in full! **${formatNumber(result.amount)}** points deducted from your balance.`,
              flags: MessageFlags.Ephemeral,
            })
          } else if (result.type === "insufficient") {
            await interaction.reply({
              content: `❌ Insufficient points! You need **${formatNumber(result.needed)}** more points to pay this loan.`,
              flags: MessageFlags.Ephemeral,
            })
          }
          break
        }

        case "create": {
          const modal = new ModalBuilder().setCustomId("create_pool_modal").setTitle("Create Betting Pool")

          const titleInput = new TextInputBuilder()
            .setCustomId("pool_title")
            .setLabel("Pool Title")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Enter a title for your betting pool")
            .setRequired(true)

          const option1Input = new TextInputBuilder()
            .setCustomId("option_1")
            .setLabel("Option 1 (text + emoji)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., Yes 👍")
            .setRequired(true)

          const option2Input = new TextInputBuilder()
            .setCustomId("option_2")
            .setLabel("Option 2 (text + emoji)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., No 👎")
            .setRequired(true)

          const option3Input = new TextInputBuilder()
            .setCustomId("option_3")
            .setLabel("Option 3 (text + emoji) - Optional")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., Maybe 🤔")
            .setRequired(false)

          const option4Input = new TextInputBuilder()
            .setCustomId("option_4")
            .setLabel("Option 4 (text + emoji) - Optional")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., Never 🚫")
            .setRequired(false)

          modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(option1Input),
            new ActionRowBuilder().addComponents(option2Input),
            new ActionRowBuilder().addComponents(option3Input),
            new ActionRowBuilder().addComponents(option4Input),
          )

          await interaction.showModal(modal)
          break
        }

        case "cancel": {
          const userPools = await pool.query(
            "SELECT id, title FROM betting_pools WHERE creator_id = $1 AND status = 'active'",
            [user.id],
          )

          if (userPools.rows.length === 0) {
            await interaction.reply({
              content: "❌ You have no active pools to cancel.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const poolSelect = new StringSelectMenuBuilder()
            .setCustomId("cancel_pool_select")
            .setPlaceholder("Select a pool to cancel")
            .addOptions(
              userPools.rows.map((pool) => ({
                label: pool.title.substring(0, 100),
                value: pool.id.toString(),
                description: "Click to cancel this pool",
              })),
            )

          const row = new ActionRowBuilder().addComponents(poolSelect)
          await interaction.reply({
            content:
              "⚠️ **Warning:** Canceling a pool will refund all bets and delete the pool permanently.\n\nSelect a pool to cancel:",
            components: [row],
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "add": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or have specific admin clearance to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const targetUser = interaction.options.getUser("user")
          const amount = interaction.options.getInteger("amount")

          const currentPoints = await getUserPoints(targetUser.id)
          if (currentPoints === null) {
            await interaction.reply({
              content: `❌ User ${targetUser} has not joined yet! They must use /participate first.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const newPoints = currentPoints + amount
          await updateUserPoints(targetUser.id, newPoints)

          await interaction.reply({
            content: `✅ Added **${formatNumber(amount)}** points to ${targetUser}!
💰 New balance: **${formatNumber(newPoints)}** points`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "remove": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or have specific admin clearance to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const targetUser = interaction.options.getUser("user")
          const amount = interaction.options.getInteger("amount")

          const currentPoints = await getUserPoints(targetUser.id)
          if (currentPoints === null) {
            await interaction.reply({
              content: `❌ User ${targetUser} has not joined yet! They must use /participate first.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          if (currentPoints < amount) {
            await interaction.reply({
              content: `❌ User ${targetUser} only has **${formatNumber(currentPoints)}** points! Cannot remove **${formatNumber(amount)}** points.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const newPoints = currentPoints - amount
          await updateUserPoints(targetUser.id, newPoints)

          await interaction.reply({
            content: `✅ Removed **${formatNumber(amount)}** points from ${targetUser}!
💰 New balance: **${formatNumber(newPoints)}** points`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "close": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or the pool creator to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const pools = await getOpenPools(user.id)
          if (pools.rows.length === 0) {
            await interaction.reply({ content: "❌ No open pools available to close.", flags: MessageFlags.Ephemeral })
            break
          }

          const poolSelect = new StringSelectMenuBuilder()
            .setCustomId("pool_select")
            .setPlaceholder("Select a pool to close")
            .addOptions(
              pools.rows.map((pool) => ({
                label: pool.title.substring(0, 100),
                value: pool.id.toString(),
                description: "Click to close this pool",
              })),
            )

          const row = new ActionRowBuilder().addComponents(poolSelect)
          await interaction.reply({
            content: "Select a pool to close:",
            components: [row],
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "clearloan": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or have specific admin clearance to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const subcommand = interaction.options.getSubcommand()

          if (subcommand === "id") {
            const loanId = interaction.options.getInteger("loan_id")
            const clearedLoan = await clearLoanById(loanId)

            if (clearedLoan) {
              await interaction.reply({
                content: `✅ Successfully cleared loan #${loanId}:
• Lender: <@${clearedLoan.lender_id}>
• Borrower: <@${clearedLoan.borrower_id}>
• Amount: ${formatNumber(clearedLoan.amount)} points
• Status: ${clearedLoan.status}`,
                flags: MessageFlags.Ephemeral,
              })
            } else {
              await interaction.reply({
                content: `❌ No loan found with ID ${loanId}.`,
                flags: MessageFlags.Ephemeral,
              })
            }
          } else if (subcommand === "status") {
            const status = interaction.options.getString("status")
            const clearedLoans = await clearLoansByStatus(status)

            if (clearedLoans.length > 0) {
              await interaction.reply({
                content: `✅ Successfully cleared ${clearedLoans.length} loans with status "${status === "self" ? "self-loans" : status}".`,
                flags: MessageFlags.Ephemeral,
              })
            } else {
              await interaction.reply({
                content: `ℹ️ No loans found with status "${status === "self" ? "self-loans" : status}".`,
                flags: MessageFlags.Ephemeral,
              })
            }
          }
          break
        }

        default:
          await interaction.reply({ content: "❌ Unknown command!", flags: MessageFlags.Ephemeral })
      }
    } catch (error) {
      console.error("Command error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your command!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  } else if (interaction.isModalSubmit()) {
    try {
      const { customId, fields } = interaction
      console.log(`Modal submit: ${customId}`)

      if (customId === "create_pool_modal") {
        const title = fields.getTextInputValue("pool_title")
        const options = []

        // Process all options (2 required, 2 optional)
        for (let i = 1; i <= 4; i++) {
          try {
            const optionText = fields.getTextInputValue(`option_${i}`)
            if (optionText && optionText.trim()) {
              const parsed = parseOptionText(optionText)
              options.push(parsed)
            }
          } catch (error) {
            // Option is empty or not provided (this is fine for options 3 and 4)
            if (i <= 2) {
              // Options 1 and 2 are required
              await interaction.reply({
                content: `❌ Option ${i} is required for the betting pool.`,
                flags: MessageFlags.Ephemeral,
              })
              return
            }
          }
        }

        if (options.length < 2) {
          await interaction.reply({
            content: "❌ Please provide at least 2 options for the betting pool.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const poolId = await createPool(interaction.user.id, title, options)
        if (!poolId) {
          await interaction.reply({
            content: "❌ Failed to create pool. Please try again.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Create betting buttons (max 5 per row, so we'll use up to 3)
        const buttons = options.map((opt, i) => {
          const button = new ButtonBuilder()
            .setCustomId(`bet_${poolId}_${i}`)
            .setLabel(opt.text)
            .setStyle(ButtonStyle.Primary)
          if (opt.emoji) {
            button.setEmoji(opt.emoji)
          }
          return button
        })

        const row = new ActionRowBuilder().addComponents(buttons)

        // Build pool message content
        const content = `🎲 **${title}**

*Created by <@${interaction.user.id}> • Betting closes in 5 minutes*`

        // Send the pool message
        const channel = interaction.channel
        const poolMessage = await channel.send({
          content: content,
          components: [row],
        })

        // Update database with message info
        await pool.query("UPDATE betting_pools SET message_id = $1, channel_id = $2 WHERE id = $3", [
          poolMessage.id,
          channel.id,
          poolId,
        ])

        // Store active pool info
        activePools.set(poolId, {
          messageId: poolMessage.id,
          channelId: channel.id,
        })

        // Set timeout to lock all bets after 5 minutes (but keep pool open for manual closure)
        setTimeout(
          async () => {
            try {
              // Lock all unlocked bets for this pool
              const lockResult = await pool.query(
                "UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE pool_id = $1 AND locked_at IS NULL RETURNING user_id, amount",
                [poolId],
              )
              console.log(`Auto-locked ${lockResult.rows.length} bets for pool ${poolId} after 5 minutes`)

              // Update the message to show betting is closed but pool is still open
              const message = await channel.messages.fetch(poolMessage.id)
              let updatedContent = content.replace(
                "Betting closes in 5 minutes",
                "Betting closed, awaiting manual pool closure",
              )
              updatedContent = updatedContent.replace("🎲", "🎲 *(BETTING CLOSED)*")

              await message.edit({
                content: updatedContent,
                components: [], // Remove betting buttons
              })
            } catch (error) {
              console.error("Error auto-locking bets:", error)
            }
          },
          5 * 60 * 1000,
        ) // 5 minutes

        await interaction.reply({
          content: `✅ Pool "${title}" created successfully! Betting will close in 5 minutes, but the pool will remain open for manual closure.`,
          flags: MessageFlags.Ephemeral,
        })
      } else if (customId.startsWith("bet_confirm_")) {
        const parts = customId.split("_")
        const poolId = Number.parseInt(parts[2])
        const optionIndex = Number.parseInt(parts[3])

        const stake = Number.parseInt(fields.getTextInputValue("stake"))
        const userId = interaction.user.id

        if (isNaN(stake) || stake < 50 || stake > 999999) {
          await interaction.reply({
            content: "❌ Invalid stake amount! Must be between 50 and 999,999 points.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const currentPoints = await getUserPoints(userId)
        if (currentPoints === null) {
          await interaction.reply({
            content: "❌ You must use `/participate` first to join the bot!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Check if user has existing bet
        const existingBet = await getUserBet(userId, poolId)
        if (existingBet) {
          await interaction.reply({
            content: `❌ You already have a bet on this pool! You bet **${formatNumber(existingBet.amount)}** points on "${existingBet.option_text}". Bets cannot be changed once placed.`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        if (currentPoints < stake) {
          const needed = stake - currentPoints
          await interaction.reply({
            content: `❌ Insufficient points! You need **${formatNumber(needed)}** more points.`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const optionsResult = await getPoolOptions(poolId)
        if (!optionsResult.rows.length || !optionsResult.rows[optionIndex]) {
          await interaction.reply({
            content: "❌ Invalid option selected.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const optionId = optionsResult.rows[optionIndex].id
        const success = await recordBet(userId, poolId, optionId, stake)

        if (success) {
          await interaction.reply({
            content: `✅ Bet placed! **${formatNumber(stake)}** points on "${optionsResult.rows[optionIndex].option_text}"!
🔒 Your bet is now locked and cannot be changed.`,
            flags: MessageFlags.Ephemeral,
          })
        } else {
          await interaction.reply({
            content: "❌ Failed to place bet. Please try again.",
            flags: MessageFlags.Ephemeral,
          })
        }
      }
    } catch (error) {
      console.error("Modal submission error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your request!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  } else if (interaction.isButton()) {
    try {
      console.log(`Button clicked: ${interaction.customId}`)

      if (interaction.customId.startsWith("accept_loan_")) {
        const loanId = Number.parseInt(interaction.customId.split("_")[2])

        // Check if the user clicking is the borrower
        const loanResult = await pool.query("SELECT * FROM loans WHERE id = $1", [loanId])
        if (loanResult.rows.length === 0) {
          await interaction.reply({
            content: "❌ Loan not found!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const loan = loanResult.rows[0]
        if (loan.borrower_id !== interaction.user.id) {
          await interaction.reply({
            content: "❌ Only the borrower can accept this loan!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        if (loan.status !== "pending") {
          await interaction.reply({
            content: `❌ This loan is no longer available (Status: ${loan.status})`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Defer the reply to prevent timeout
        await interaction.deferUpdate()

        const acceptedLoan = await acceptLoan(loanId)
        if (acceptedLoan) {
          await interaction.editReply({
            content: `✅ **Loan Accepted!**

${interaction.user} has accepted the loan of **${formatNumber(acceptedLoan.amount)}** points!

**Terms:**
• Interest rate: ${acceptedLoan.interest_rate}%
• Repayment period: ${acceptedLoan.days} days
• Total to repay: **${formatNumber(Math.floor(acceptedLoan.amount * (1 + acceptedLoan.interest_rate / 100)))}** points

💰 Points have been transferred!`,
            components: [],
          })
        } else {
          await interaction.editReply({
            content:
              "❌ Failed to accept loan. The lender may not have enough points or the loan was already processed.",
            components: [],
          })
        }
      } else if (interaction.customId.startsWith("reject_loan_")) {
        const loanId = Number.parseInt(interaction.customId.split("_")[2])

        // Check if the user clicking is the borrower
        const loanResult = await pool.query("SELECT * FROM loans WHERE id = $1", [loanId])
        if (loanResult.rows.length === 0) {
          await interaction.reply({
            content: "❌ Loan not found!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const loan = loanResult.rows[0]
        if (loan.borrower_id !== interaction.user.id) {
          await interaction.reply({
            content: "❌ Only the borrower can reject this loan!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        if (loan.status !== "pending") {
          await interaction.reply({
            content: `❌ This loan is no longer available (Status: ${loan.status})`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        await pool.query("UPDATE loans SET status = 'rejected' WHERE id = $1", [loanId])

        await interaction.update({
          content: `❌ **Loan Rejected**

${interaction.user} has rejected the loan offer.`,
          components: [],
        })
      } else if (interaction.customId.startsWith("bet_")) {
        const parts = interaction.customId.split("_")
        const poolId = Number.parseInt(parts[1])
        const optionIndex = Number.parseInt(parts[2])

        // Check if user has existing bet
        const existingBet = await getUserBet(interaction.user.id, poolId)
        if (existingBet) {
          await interaction.reply({
            content: `❌ You already have a bet on this pool! You bet **${formatNumber(existingBet.amount)}** points on "${existingBet.option_text}". Bets cannot be changed once placed.`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const modal = new ModalBuilder().setCustomId(`bet_confirm_${poolId}_${optionIndex}`).setTitle("Confirm Bet")

        const stakeInput = new TextInputBuilder()
          .setCustomId("stake")
          .setLabel("Stake Amount (50-999,999 points)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Enter the amount of points to bet")
          .setRequired(true)

        modal.addComponents(new ActionRowBuilder().addComponents(stakeInput))

        await interaction.showModal(modal)
      }
    } catch (error) {
      console.error("Button click error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your request!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    try {
      console.log(`Select menu interaction: ${interaction.customId}`)

      if (interaction.customId === "pool_select") {
        const poolId = Number.parseInt(interaction.values[0])

        const optionsResult = await getPoolOptions(poolId)
        if (optionsResult.rows.length === 0) {
          await interaction.reply({
            content: "❌ No options found for this pool.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const optionSelect = new StringSelectMenuBuilder()
          .setCustomId(`correct_option_select_${poolId}`)
          .setPlaceholder("Select the correct option")
          .addOptions(
            optionsResult.rows.map((option) => ({
              label: option.option_text.substring(0, 100),
              value: option.id.toString(),
              description: "Click to select this option as the correct answer",
            })),
          )

        const row = new ActionRowBuilder().addComponents(optionSelect)
        await interaction.reply({
          content: "Select the correct option for this pool:",
          components: [row],
          flags: MessageFlags.Ephemeral,
        })
      } else if (interaction.customId.startsWith("correct_option_select_")) {
        const poolId = Number.parseInt(interaction.customId.split("_")[3])
        const correctOptionId = Number.parseInt(interaction.values[0])

        const closeResult = await closePool(poolId, correctOptionId)

        if (closeResult.success) {
          // Create results embed
          const resultsEmbed = new EmbedBuilder()
            .setTitle(`🏆 Pool Results: ${closeResult.poolTitle}`)
            .setColor(0x00ff00)
            .addFields({
              name: "🎯 Correct Answer",
              value: closeResult.correctOption,
              inline: true,
            })
            .addFields({
              name: "💰 Total Pool",
              value: `${formatNumber(closeResult.totalPool)} points`,
              inline: true,
            })
            .addFields({
              name: "👑 Winners",
              value: closeResult.winners.length > 0 ? `${closeResult.winners.length} winner(s)` : "No winners",
              inline: true,
            })

          if (closeResult.winners.length > 0) {
            let winnersText = ""
            for (const winner of closeResult.winners) {
              const profitText =
                winner.profit >= 0 ? `+${formatNumber(winner.profit)}` : `${formatNumber(winner.profit)}`
              winnersText += `<@${winner.userId}>: Bet ${formatNumber(winner.betAmount)} → Won ${formatNumber(winner.payout)} (${profitText})
`
            }

            // Split into multiple fields if too long
            if (winnersText.length > 1024) {
              const chunks = winnersText.match(/.{1,1000}/g) || []
              chunks.forEach((chunk, index) => {
                resultsEmbed.addFields({
                  name: index === 0 ? "🎉 Winner Details" : "🎉 Winner Details (cont.)",
                  value: chunk,
                  inline: false,
                })
              })
            } else {
              resultsEmbed.addFields({
                name: "🎉 Winner Details",
                value: winnersText,
                inline: false,
              })
            }
          }

          resultsEmbed.setFooter({ text: "Pool closed • Points distributed" })
          resultsEmbed.setTimestamp()

          // Update the original pool message if possible
          const poolInfo = activePools.get(poolId)
          if (poolInfo) {
            try {
              const channel = await client.channels.fetch(poolInfo.channelId)
              const message = await channel.messages.fetch(poolInfo.messageId)
              await message.edit({
                content: `🎲 **${closeResult.poolTitle}** *(POOL CLOSED)*

✅ **Results posted below!**`,
                components: [],
              })

              // Post results in the same channel
              await channel.send({ embeds: [resultsEmbed] })
            } catch (error) {
              console.error("Error updating pool message:", error)
            }
            activePools.delete(poolId)
          }

          await interaction.update({
            content: `✅ ${closeResult.message}`,
            components: [],
          })
        } else {
          await interaction.update({
            content: `❌ ${closeResult.message}`,
            components: [],
          })
        }
      } else if (interaction.customId === "cancel_pool_select") {
        const poolId = Number.parseInt(interaction.values[0])

        const cancelResult = await cancelPool(poolId, interaction.user.id)

        if (cancelResult.success) {
          // Update the original pool message if possible
          const poolInfo = activePools.get(poolId)
          if (poolInfo) {
            try {
              const channel = await client.channels.fetch(poolInfo.channelId)
              const poolMessage = await channel.messages.fetch(poolInfo.messageId)
              await poolMessage.edit({
                content: `🎲 **Pool Cancelled** *(REFUNDED)*

This pool was cancelled by the creator. All bets have been refunded.`,
                components: [],
              })
            } catch (error) {
              console.error("Error updating cancelled pool message:", error)
            }
            activePools.delete(poolId)
          }

          await interaction.update({
            content: `✅ ${cancelResult.message}`,
            components: [],
          })
        } else {
          await interaction.update({
            content: `❌ ${cancelResult.message}`,
            components: [],
          })
        }
      }
    } catch (error) {
      console.error("Select menu interaction error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your request!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  }
})

console.log("Token length:", process.env.DISCORD_BOT_TOKEN?.length)

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN)

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🔄 Shutting down...")
  await pool.end()
  client.destroy()
  process.exit(0)
})
