const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { Pool } = require('pg');
const cron = require('node-cron');
require('dotenv').config();

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Admin user IDs - Add your Discord user ID here
const adminUserIds = [
  "121564489043804161", // Replace with actual admin user IDs
  // Add more admin IDs as needed
];

function isAdmin(userId) {
  return adminUserIds.includes(userId);
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDate(date) {
  const d = new Date(date);
  const now = new Date();
  const diffTime = Math.abs(now - d);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 1) {
    return d.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    }) + ' (Today)';
  } else if (diffDays <= 7) {
    return d.toLocaleDateString('en-US', { 
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } else {
    return d.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
}

function createEmbed(title, description, color = 0x3498db) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setColor(0x2ecc71)
    .setTimestamp();
}

function createErrorEmbed(title, description = null) {
  const embed = new EmbedBuilder()
    .setTitle(`❌ ${title}`)
    .setColor(0xe74c3c)
    .setTimestamp();
    
  if (description) {
    embed.setDescription(description);
  }
  
  return embed;
}

function createWarningEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(`⚠️ ${title}`)
    .setDescription(description)
    .setColor(0xf39c12)
    .setTimestamp();
}

// Initialize database tables
async function initDatabase() {
  try {
    // Enhanced user points table
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
    
    // Betting options table
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
    
    // Enhanced shop items table
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

// Enhanced database helper functions
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

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Enhanced slash commands
const commands = [
  // Betting System
  new SlashCommandBuilder()
    .setName('enterbetting')
    .setDescription('Register for the betting system'),
    
  new SlashCommandBuilder()
    .setName('createpool')
    .setDescription('Create a new betting pool')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Pool title')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('description')
        .setDescription('Pool description')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option1')
        .setDescription('First betting option')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option2')
        .setDescription('Second betting option')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option3')
        .setDescription('Third betting option (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option4')
        .setDescription('Fourth betting option (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option5')
        .setDescription('Fifth betting option (optional)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('duration')
        .setDescription('Pool duration in hours')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(168)),
        
  new SlashCommandBuilder()
    .setName('resolvepool')
    .setDescription('Resolve a betting pool (Admin only)'),
    
  new SlashCommandBuilder()
    .setName('betlog')
    .setDescription('View your betting history')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('View another user\'s betting history (Admin only)')
        .setRequired(false)),
        
  new SlashCommandBuilder()
    .setName('viewpools')
    .setDescription('View active betting pools'),
    
  new SlashCommandBuilder()
    .setName('bet')
    .setDescription('Place a bet on an active pool')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount to bet')
        .setRequired(true)
        .setMinValue(1)),
        
  // Lending System
  new SlashCommandBuilder()
    .setName('lend')
    .setDescription('Lend points to another user')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of points to lend')
        .setRequired(true)
        .setMinValue(1))
    .addNumberOption(option =>
      option.setName('interest')
        .setDescription('Interest rate (0.01 = 1%)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(0.25))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Number of days for repayment')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(30)),
        
  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Pay back a loan')
    .addIntegerOption(option =>
      option.setName('loan_id')
        .setDescription('ID of the loan to repay')
        .setRequired(true)),
        
  new SlashCommandBuilder()
    .setName('extendloan')
    .setDescription('Extend loan duration')
    .addIntegerOption(option =>
      option.setName('loan_id')
        .setDescription('ID of the loan to extend')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Additional days to extend')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(14)),
        
  new SlashCommandBuilder()
    .setName('viewloans')
    .setDescription('View your active loans')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of loans to view')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Borrowed', value: 'borrowed' },
          { name: 'Lent', value: 'lent' }
        )),
        
  // Bounty System
  new SlashCommandBuilder()
    .setName('bounty')
    .setDescription('Bounty system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a new bounty')
        .addStringOption(option =>
          option.setName('title')
            .setDescription('Bounty title')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Bounty description')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('reward')
            .setDescription('Reward amount in points')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('claim')
        .setDescription('Claim a bounty as completed')
        .addIntegerOption(option =>
          option.setName('bounty_id')
            .setDescription('ID of the bounty to claim')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('proof')
            .setDescription('Proof of completion (optional)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View active bounties')),
        
  // Cash-in System
  new SlashCommandBuilder()
    .setName('cashin')
    .setDescription('Cash-in system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View available shop items')
        .addStringOption(option =>
          option.setName('category')
            .setDescription('Filter by category')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('redeem')
        .setDescription('Redeem an item from the shop')
        .addIntegerOption(option =>
          option.setName('item_id')
            .setDescription('ID of the item to redeem')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('quantity')
            .setDescription('Quantity to redeem')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10))),
            
  // Points System
  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Points system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View your points and stats')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('View another user\'s points')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('give')
        .setDescription('Give points to another user')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Amount of points to give')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('daily')
        .setDescription('Claim your daily points bonus'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('interest')
        .setDescription('View interest calculations for lending')),
        
  // Leaderboard
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View various leaderboards')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Leaderboard type')
        .setRequired(false)
        .addChoices(
          { name: 'Points', value: 'points' },
          { name: 'Level', value: 'level' },
          { name: 'Total Earned', value: 'earned' },
          { name: 'Betting Wins', value: 'betting' }
        )),
        
  // Admin System
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('addshopitem')
        .setDescription('Add an item to the shop')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Item name')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Item description')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('price')
            .setDescription('Item price in points')
            .setRequired(true)
            .setMinValue(1))
        .addStringOption(option =>
          option.setName('category')
            .setDescription('Item category')
            .setRequired(false))
        .addIntegerOption(option =>
          option.setName('stock')
            .setDescription('Stock quantity (-1 for unlimited)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('removeshopitem')
        .setDescription('Remove an item from the shop')
        .addIntegerOption(option =>
          option.setName('item_id')
            .setDescription('ID of the item to remove')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('givepoints')
        .setDescription('Give points to a user')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Amount of points to give')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('removepoints')
        .setDescription('Remove points from a user')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Amount of points to remove')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View bot statistics')),
        
  // Help Command
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('View help information')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Help category')
        .setRequired(false)
        .addChoices(
          { name: 'Betting', value: 'betting' },
          { name: 'Lending', value: 'lending' },
          { name: 'Bounties', value: 'bounties' },
          { name: 'Shop', value: 'shop' },
          { name: 'Points', value: 'points' },
          { name: 'Admin', value: 'admin' }
        ))
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    console.log('🔄 Started refreshing application (/) commands.');
    
    // Register for specific guild (faster updates during development)
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('✅ Successfully reloaded guild-specific commands.');
    } else {
      // Register globally (takes up to 1 hour to update)
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Successfully reloaded global commands.');
    }
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

// Start cron jobs
function startCronJobs() {
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
          
          const embed = createWarningEmbed(
            'Loan Reminder',
            `Your loan #${loan.id} from ${lender.username} is due soon!\n\n` +
            `**Amount to repay:** ${formatNumber(Math.floor(loan.amount * (1 + parseFloat(loan.interest_rate))))} points\n` +
            `**Due date:** ${formatDate(loan.due_date)}\n\n` +
            `Use \`/pay ${loan.id}\` to repay this loan.`
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
  
  console.log('✅ Cron jobs started successfully');
}

// Bot event handlers
client.once('ready', async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  console.log(`🔗 Serving ${client.guilds.cache.size} guilds`);
  
  await initDatabase();
  await registerCommands();
  startCronJobs();
  
  client.user.setActivity('💰 Economy System | /help', { type: 'WATCHING' });
});

// Enhanced interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) return;

  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      await handleSelectMenu(interaction);
    }
  } catch (error) {
    console.error('Interaction error:', error);
    const errorEmbed = createErrorEmbed('An error occurred while processing your request!');
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    }
  }
});

async function handleSlashCommand(interaction) {
  const { commandName, user } = interaction;

  switch (commandName) {
    case 'enterbetting':
      await handleEnterBetting(interaction);
      break;
    case 'createpool':
      await handleCreatePool(interaction);
      break;
    case 'resolvepool':
      await handleResolvePool(interaction);
      break;
    case 'betlog':
      await handleBetLog(interaction);
      break;
    case 'viewpools':
      await handleViewPools(interaction);
      break;
    case 'bet':
      await handleBet(interaction);
      break;
    case 'lend':
      await handleLend(interaction);
      break;
    case 'pay':
      await handlePay(interaction);
      break;
    case 'extendloan':
      await handleExtendLoan(interaction);
      break;
    case 'viewloans':
      await handleViewLoans(interaction);
      break;
    case 'bounty':
      await handleBounty(interaction);
      break;
    case 'cashin':
      await handleCashIn(interaction);
      break;
    case 'points':
      await handlePoints(interaction);
      break;
    case 'leaderboard':
      await handleLeaderboard(interaction);
      break;
    case 'admin':
      await handleAdmin(interaction);
      break;
    case 'help':
      await handleHelp(interaction);
      break;
    default:
      const errorEmbed = createErrorEmbed('Unknown command!');
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

// Betting System Handlers
async function handleEnterBetting(interaction) {
  const userData = await getUserData(interaction.user.id);
  
  const embed = createSuccessEmbed(
    'Welcome to the Betting System!',
    `You're now registered for betting with **${formatNumber(userData.points)}** points!\n\n` +
    '**Available Commands:**\n' +
    '• `/viewpools` - View active betting pools\n' +
    '• `/bet` - Place a bet on a pool\n' +
    '• `/betlog` - View your betting history\n' +
    '• `/createpool` - Create your own betting pool\n\n' +
    '**How it works:**\n' +
    '1. View active pools with `/viewpools`\n' +
    '2. Place bets using `/bet` command\n' +
    '3. Wait for pool resolution\n' +
    '4. Collect winnings automatically!'
  );
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCreatePool(interaction) {
  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description') || 'No description provided';
  const duration = interaction.options.getInteger('duration') || 24;
  
  const options = [];
  for (let i = 1; i <= 5; i++) {
    const option = interaction.options.getString(`option${i}`);
    if (option) options.push(option);
  }
  
  if (options.length < 2) {
    const errorEmbed = createErrorEmbed('You must provide at least 2 betting options!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  try {
    const endDate = new Date();
    endDate.setHours(endDate.getHours() + duration);
    
    const result = await pool.query(`
      INSERT INTO betting_pools (title, description, creator_id, end_date) 
      VALUES ($1, $2, $3, $4) 
      RETURNING id
    `, [title, description, interaction.user.id, endDate]);
    
    const poolId = result.rows[0].id;
    
    // Store betting options
    for (const option of options) {
      await pool.query(`
        INSERT INTO betting_options (pool_id, option_name) 
        VALUES ($1, $2)
      `, [poolId, option]);
    }
    
    const embed = createSuccessEmbed(
      'Betting Pool Created!',
      `**Pool #${poolId}**: ${title}\n` +
      `📝 **Description:** ${description}\n` +
      `⏰ **Duration:** ${duration} hours\n` +
      `📅 **Ends:** ${formatDate(endDate)}\n\n` +
      `**Betting Options:**\n${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}\n\n` +
      `Use \`/bet\` to place bets on this pool!`
    );
    
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Create pool error:', error);
    const errorEmbed = createErrorEmbed('Failed to create betting pool!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleResolvePool(interaction) {
  if (!isAdmin(interaction.user.id)) {
    const errorEmbed = createErrorEmbed('Only admins can resolve betting pools!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  try {
    const result = await pool.query(`
      SELECT bp.*, array_agg(bo.option_name) as options
      FROM betting_pools bp
      LEFT JOIN betting_options bo ON bp.id = bo.pool_id
      WHERE bp.status = 'active'
      GROUP BY bp.id
      ORDER BY bp.created_at DESC
      LIMIT 10
    `);
    
    if (result.rows.length === 0) {
      const embed = createEmbed('📊 No Active Pools', 'There are no active betting pools to resolve.', 0x3498db);
      return await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('resolve_pool_select')
      .setPlaceholder('Select a pool to resolve')
      .addOptions(
        result.rows.map(poolData => ({
          label: `Pool #${poolData.id}: ${poolData.title}`,
          description: `Created ${formatDate(poolData.created_at)}`,
          value: poolData.id.toString()
        }))
      );
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    const embed = createEmbed(
      '🎯 Resolve Betting Pool',
      'Select a betting pool to resolve from the dropdown below.',
      0x3498db
    );
    
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (error) {
    console.error('Resolve pool error:', error);
    const errorEmbed = createErrorEmbed('Failed to load betting pools!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleViewPools(interaction) {
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
      LIMIT 5
    `);
    
    if (result.rows.length === 0) {
      const embed = createEmbed('🎯 No Active Pools', 'There are no active betting pools right now.', 0x3498db);
      return await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    const embed = new EmbedBuilder()
      .setTitle('🎯 Active Betting Pools')
      .setColor(0x3498db)
      .setTimestamp();
    
    for (const poolData of result.rows) {
      const creator = await client.users.fetch(poolData.creator_id).catch(() => ({ username: 'Unknown' }));
      const options = poolData.options.filter(opt => opt.name);
      
      let optionsText = '';
      for (const option of options) {
        const odds = poolData.total_pool > 0 ? (poolData.total_pool / Math.max(option.total_amount, 1)).toFixed(2) : '∞';
        optionsText += `• ${option.name} - ${option.total_bets} bets (${formatNumber(option.total_amount)} pts) - ${odds}x odds\n`;
      }
      
      embed.addFields({
        name: `Pool #${poolData.id}: ${poolData.title}`,
        value: `👤 **Creator:** ${creator.username}\n` +
               `💰 **Total Pool:** ${formatNumber(poolData.total_pool)} points\n` +
               `📅 **Ends:** ${poolData.end_date ? formatDate(poolData.end_date) : 'No end date'}\n\n` +
               `**Options:**\n${optionsText}\n` +
               `Use \`/bet amount:X\` to place a bet!`,
        inline: false
      });
    }
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    console.error('View pools error:', error);
    const errorEmbed = createErrorEmbed('Failed to load betting pools!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleBet(interaction) {
  const amount = interaction.options.getInteger('amount');
  
  try {
    // Get active pools
    const poolsResult = await pool.query(`
      SELECT bp.*, array_agg(bo.option_name) as options
      FROM betting_pools bp
      LEFT JOIN betting_options bo ON bp.id = bo.pool_id
      WHERE bp.status = 'active'
      GROUP BY bp.id
      ORDER BY bp.created_at DESC
      LIMIT 10
    `);
    
    if (poolsResult.rows.length === 0) {
      const embed = createErrorEmbed('No active betting pools available!');
      return await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`bet_pool_select_${amount}`)
      .setPlaceholder('Select a pool to bet on')
      .addOptions(
        poolsResult.rows.map(poolData => ({
          label: `Pool #${poolData.id}: ${poolData.title}`,
          description: `Total pool: ${formatNumber(poolData.total_pool)} points`,
          value: poolData.id.toString()
        }))
      );
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    const embed = createEmbed(
      '🎲 Place Your Bet',
      `Select a betting pool to place your **${formatNumber(amount)}** point bet.`,
      0x3498db
    );
    
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (error) {
    console.error('Bet error:', error);
    const errorEmbed = createErrorEmbed('Failed to load betting pools!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

// Points System Handlers
async function handlePoints(interaction) {
  const subcommand = interaction.options.getSubcommand();
  
  switch (subcommand) {
    case 'view':
      await handlePointsView(interaction);
      break;
    case 'give':
      await handlePointsGive(interaction);
      break;
    case 'daily':
      await handlePointsDaily(interaction);
      break;
    case 'interest':
      await handlePointsInterest(interaction);
      break;
  }
}

async function handlePointsView(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const userData = await getUserData(targetUser.id);
  
  if (!userData) {
    const errorEmbed = createErrorEmbed('User data not found!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  // Get user's rank
  const rankResult = await pool.query(`
    SELECT COUNT(*) + 1 as rank 
    FROM user_points 
    WHERE points > $1
  `, [userData.points]);
  
  const rank = rankResult.rows[0].rank;
  
  // Calculate next level progress
  const currentLevelExp = (userData.level - 1) * 100;
  const nextLevelExp = userData.level * 100;
  const progress = ((userData.experience - currentLevelExp) / 100) * 100;
  
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`💰 ${targetUser.username}'s Profile`)
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: '💎 Current Points', value: formatNumber(userData.points), inline: true },
      { name: '📊 Rank', value: `#${rank}`, inline: true },
      { name: '⭐ Level', value: `${userData.level}`, inline: true },
      { name: '🎯 Experience', value: `${userData.experience} XP`, inline: true },
      { name: '📈 Progress to Next Level', value: `${progress.toFixed(1)}%`, inline: true },
      { name: '💰 Total Earned', value: formatNumber(userData.total_earned), inline: true },
      { name: '💸 Total Spent', value: formatNumber(userData.total_spent), inline: true },
      { name: '📅 Last Daily Claim', value: userData.daily_claimed_at ? formatDate(userData.daily_claimed_at) : 'Never', inline: true },
      { name: '🕐 Account Created', value: formatDate(userData.created_at), inline: true }
    )
    .setFooter({ text: 'Use /points daily to claim your daily bonus!' })
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: targetUser.id !== interaction.user.id });
}

async function handlePointsGive(interaction) {
  const amount = interaction.options.getInteger('amount');
  
  // Create user select menu
  const selectMenu = new UserSelectMenuBuilder()
    .setCustomId(`give_points_${amount}`)
    .setPlaceholder('Select a user to give points to');
  
  const row = new ActionRowBuilder().addComponents(selectMenu);
  
  const embed = createEmbed(
    '💝 Give Points',
    `Select a user to give **${formatNumber(amount)}** points to.`,
    0x3498db
  );
  
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handlePointsDaily(interaction) {
  const canClaim = await canClaimDaily(interaction.user.id);
  
  if (!canClaim) {
    const userData = await getUserData(interaction.user.id);
    const lastClaim = new Date(userData.daily_claimed_at);
    const nextClaim = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000);
    
    const embed = createErrorEmbed(
      'Daily Bonus Already Claimed!',
      `You can claim your next daily bonus ${formatDate(nextClaim)}`
    );
    return await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  const result = await claimDaily(interaction.user.id);
  
  if (!result) {
    const errorEmbed = createErrorEmbed('Failed to claim daily bonus!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  // Add experience for daily claim
  const expResult = await addExperience(interaction.user.id, 10);
  
  const embed = createSuccessEmbed(
    'Daily Bonus Claimed!',
    `You received **${formatNumber(result.bonus)}** points!\n` +
    `💰 **New Balance:** ${formatNumber(result.newPoints)} points\n` +
    `🎯 **Experience Gained:** +10 XP` +
    (expResult?.levelUp ? `\n🎉 **Level Up!** You're now level ${expResult.newLevel}!` : '')
  );
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePointsInterest(interaction) {
  const embed = createEmbed(
    '📈 Interest Calculator',
    '**How Interest Works:**\n' +
    '• Interest is calculated as a percentage of the loan amount\n' +
    '• Maximum interest rate is 25% (0.25)\n' +
    '• Interest is calculated for the full loan period\n\n' +
    '**Examples:**\n' +
    '• 1,000 points at 5% (0.05) for 7 days = 1,050 points to repay\n' +
    '• 500 points at 10% (0.10) for 14 days = 550 points to repay\n' +
    '• 2,000 points at 2% (0.02) for 30 days = 2,040 points to repay\n\n' +
    '**Formula:** `Repayment = Amount × (1 + Interest Rate)`',
    0x3498db
  );
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Leaderboard Handler
async function handleLeaderboard(interaction) {
  const type = interaction.options.getString('type') || 'points';
  
  let query, title, field;
  
  switch (type) {
    case 'points':
      query = 'SELECT user_id, points FROM user_points ORDER BY points DESC LIMIT 10';
      title = '💰 Points Leaderboard';
      field = 'points';
      break;
    case 'level':
      query = 'SELECT user_id, level, experience FROM user_points ORDER BY level DESC, experience DESC LIMIT 10';
      title = '⭐ Level Leaderboard';
      field = 'level';
      break;
    case 'earned':
      query = 'SELECT user_id, total_earned FROM user_points ORDER BY total_earned DESC LIMIT 10';
      title = '📈 Total Earned Leaderboard';
      field = 'total_earned';
      break;
    default:
      query = 'SELECT user_id, points FROM user_points ORDER BY points DESC LIMIT 10';
      title = '💰 Points Leaderboard';
      field = 'points';
  }
  
  try {
    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      const embed = createEmbed('📊 Empty Leaderboard', 'No users found in the leaderboard yet!', 0x3498db);
      return await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xf39c12)
      .setTimestamp();
    
    let leaderboardText = '';
    
    for (let i = 0; i < result.rows.length; i++) {
      const userData = result.rows[i];
      const user = await client.users.fetch(userData.user_id).catch(() => ({ username: 'Unknown User' }));
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      
      let value;
      if (field === 'level') {
        value = `Level ${userData.level} (${userData.experience} XP)`;
      } else {
        value = `${formatNumber(userData[field])} ${field === 'points' ? 'points' : 'points earned'}`;
      }
      
      leaderboardText += `${medal} **${user.username}** - ${value}\n`;
    }
    
    embed.setDescription(leaderboardText);
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    console.error('Leaderboard error:', error);
    const errorEmbed = createErrorEmbed('Failed to load leaderboard!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

// Help Handler
async function handleHelp(interaction) {
  const category = interaction.options.getString('category');
  
  if (!category) {
    const embed = new EmbedBuilder()
      .setTitle('🎮 Bot Help - Command Categories')
      .setColor(0x3498db)
      .setDescription('Select a category to learn more about specific commands!')
      .addFields(
        { name: '🎲 Betting System', value: '`/help category:betting`\nCreate and participate in betting pools', inline: true },
        { name: '💰 Lending System', value: '`/help category:lending`\nLend and borrow points with interest', inline: true },
        { name: '🎯 Bounty System', value: '`/help category:bounties`\nCreate and claim bounties for tasks', inline: true },
        { name: '💎 Shop System', value: '`/help category:shop`\nRedeem points for rewards', inline: true },
        { name: '📊 Points System', value: '`/help category:points`\nManage your points and daily bonuses', inline: true },
        { name: '👑 Admin Commands', value: '`/help category:admin`\nAdmin-only management commands', inline: true }
      )
      .setFooter({ text: 'Use /help category:name for detailed command information' })
      .setTimestamp();
    
    return await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  let embed;
  
  switch (category) {
    case 'betting':
      embed = createEmbed(
        '🎲 Betting System Commands',
        '**Available Commands:**\n' +
        '• `/enterbetting` - Register for betting system\n' +
        '• `/createpool` - Create a new betting pool (2-5 options)\n' +
        '• `/viewpools` - View all active betting pools\n' +
        '• `/bet amount:X` - Place a bet on a pool\n' +
        '• `/betlog` - View your betting history\n' +
        '• `/resolvepool` - Resolve pools (Admin only)\n\n' +
        '**How it works:**\n' +
        '1. Create or find a betting pool\n' +
        '2. Place your bet (one per pool)\n' +
        '3. Wait for admin resolution\n' +
        '4. Winners split the total pool proportionally!',
        0x9b59b6
      );
      break;
    case 'lending':
      embed = createEmbed(
        '💰 Lending System Commands',
        '**Available Commands:**\n' +
        '• `/lend` - Lend points to another user with interest\n' +
        '• `/pay loan_id:X` - Repay a specific loan\n' +
        '• `/extendloan` - Extend loan duration\n' +
        '• `/viewloans` - View your active loans\n' +
        '• `/points interest` - View interest calculator\n\n' +
        '**Features:**\n' +
        '• Set custom interest rates (0-25%)\n' +
        '• Flexible repayment periods (1-30 days)\n' +
        '• Automatic reminders before due date\n' +
        '• Track all lending activity',
        0x2ecc71
      );
      break;
    case 'bounties':
      embed = createEmbed(
        '🎯 Bounty System Commands',
        '**Available Commands:**\n' +
        '• `/bounty create` - Create a new bounty\n' +
        '• `/bounty view` - View all active bounties\n' +
        '• `/bounty claim` - Claim a completed bounty\n\n' +
        '**How it works:**\n' +
        '1. Create a bounty with title, description, and reward\n' +
        '2. Other users can claim completion\n' +
        '3. Provide proof of completion (optional)\n' +
        '4. Receive the reward points instantly!',
        0xe67e22
      );
      break;
    case 'shop':
      embed = createEmbed(
        '💎 Shop System Commands',
        '**Available Commands:**\n' +
        '• `/cashin view` - Browse available shop items\n' +
        '• `/cashin redeem` - Purchase items with points\n\n' +
        '**Features:**\n' +
        '• Filter items by category\n' +
        '• Stock quantity tracking\n' +
        '• Purchase history\n' +
        '• Admin can add/remove items',
        0x1abc9c
      );
      break;
    case 'points':
      embed = createEmbed(
        '📊 Points System Commands',
        '**Available Commands:**\n' +
        '• `/points view` - Check your points and stats\n' +
        '• `/points give` - Give points to another user\n' +
        '• `/points daily` - Claim daily bonus (24h cooldown)\n' +
        '• `/points interest` - View interest calculator\n' +
        '• `/leaderboard` - View various leaderboards\n\n' +
        '**Features:**\n' +
        '• Level system with experience points\n' +
        '• Daily bonuses increase with level\n' +
        '• Complete transaction history\n' +
        '• Ranking system',
        0x3498db
      );
      break;
    case 'admin':
      embed = createEmbed(
        '👑 Admin Commands',
        '**Shop Management:**\n' +
        '• `/admin addshopitem` - Add items to shop\n' +
        '• `/admin removeshopitem` - Remove shop items\n\n' +
        '**User Management:**\n' +
        '• `/admin givepoints` - Give points to users\n' +
        '• `/admin removepoints` - Remove points from users\n' +
        '• `/admin stats` - View bot statistics\n\n' +
        '**Betting Management:**\n' +
        '• `/resolvepool` - Resolve betting pools\n' +
        '• `/betlog user:@user` - View any user\'s betting history',
        0xe74c3c
      );
      break;
    default:
      embed = createErrorEmbed('Invalid help category!');
  }
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Select menu handlers
async function handleSelectMenu(interaction) {
  if (interaction.customId === 'resolve_pool_select') {
    await handlePoolResolution(interaction);
  } else if (interaction.customId.startsWith('give_points_')) {
    await handleGivePointsSelect(interaction);
  } else if (interaction.customId.startsWith('bet_pool_select_')) {
    await handleBetPoolSelect(interaction);
  }
}

async function handleGivePointsSelect(interaction) {
  const amount = parseInt(interaction.customId.split('_')[2]);
  const targetUser = interaction.users.first();
  
  if (targetUser.id === interaction.user.id) {
    const errorEmbed = createErrorEmbed('You cannot give points to yourself!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  const senderData = await getUserData(interaction.user.id);
  
  if (senderData.points < amount) {
    const errorEmbed = createErrorEmbed(
      'Insufficient Points!',
      `You need **${formatNumber(amount)}** points but only have **${formatNumber(senderData.points)}** points.`
    );
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  const receiverData = await getUserData(targetUser.id);
  
  await updateUserPoints(interaction.user.id, senderData.points - amount, {
    type: 'POINTS_GIVEN',
    amount: -amount,
    description: `Gave points to ${targetUser.username}`,
    reference_id: null
  });
  
  await updateUserPoints(targetUser.id, receiverData.points + amount, {
    type: 'POINTS_RECEIVED',
    amount: amount,
    description: `Received points from ${interaction.user.username}`,
    reference_id: null
  });
  
  const embed = createSuccessEmbed(
    'Points Transferred!',
    `**${interaction.user.username}** gave **${formatNumber(amount)}** points to **${targetUser.username}**!\n\n` +
    `💰 **Your new balance:** ${formatNumber(senderData.points - amount)} points`
  );
  
  await interaction.reply({ embeds: [embed] });
}

// Placeholder handlers for other commands (implement as needed)
async function handleBetLog(interaction) {
  const embed = createEmbed('🎲 Betting History', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleLend(interaction) {
  const embed = createEmbed('💰 Lending System', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePay(interaction) {
  const embed = createEmbed('💸 Loan Repayment', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleExtendLoan(interaction) {
  const embed = createEmbed('⏰ Extend Loan', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleViewLoans(interaction) {
  const embed = createEmbed('📋 View Loans', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBounty(interaction) {
  const embed = createEmbed('🎯 Bounty System', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCashIn(interaction) {
  const embed = createEmbed('💎 Cash-in System', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAdmin(interaction) {
  if (!isAdmin(interaction.user.id)) {
    const errorEmbed = createErrorEmbed('Access Denied!', 'Only administrators can use this command.');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  const embed = createEmbed('👑 Admin Panel', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePoolResolution(interaction) {
  const embed = createEmbed('🎯 Pool Resolution', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBetPoolSelect(interaction) {
  const embed = createEmbed('🎲 Place Bet', 'This feature is coming soon!', 0x3498db);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Error handling
client.on('error', console.error);
client.on('warn', console.warn);

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down gracefully...');
  await pool.end();
  client.destroy();
  process.exit(0);
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);
