const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { Pool } = require('pg');

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    // Drop user_points table to reset all user data
    await pool.query('DROP TABLE IF EXISTS user_points CASCADE');
    
    // Recreate user_points table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_points (
        user_id VARCHAR(20) PRIMARY KEY,
        points INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS betting_pools (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        creator_id VARCHAR(20),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id),
        amount INTEGER,
        option VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        lender_id VARCHAR(20),
        borrower_id VARCHAR(20),
        amount INTEGER,
        interest_rate DECIMAL(5,4),
        due_date TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bounties (
        id SERIAL PRIMARY KEY,
        creator_id VARCHAR(20),
        title VARCHAR(255),
        description TEXT,
        reward INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        winner_id VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        description TEXT,
        price INTEGER,
        category VARCHAR(100),
        in_stock BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
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
    
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

// Database helper functions
async function getUserPoints(userId) {
  try {
    const result = await pool.query('SELECT points FROM user_points WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
      return null; // User not registered
    }
    return result.rows[0].points;
  } catch (error) {
    console.error('Error getting user points:', error);
    return null;
  }
}

async function registerUser(userId) {
  try {
    const result = await pool.query(`
      INSERT INTO user_points (user_id, points) 
      VALUES ($1, 1000) 
      ON CONFLICT (user_id) 
      DO NOTHING 
      RETURNING points
    `, [userId]);
    return result.rows.length > 0; // True if user was registered, false if already exists
  } catch (error) {
    console.error('Error registering user:', error);
    return false;
  }
}

async function updateUserPoints(userId, points) {
  try {
    await pool.query(`
      INSERT INTO user_points (user_id, points) 
      VALUES ($1, $2) 
      ON CONFLICT (user_id) 
      DO UPDATE SET points = $2
    `, [userId, points]);
    return true;
  } catch (error) {
    console.error('Error updating user points:', error);
    return false;
  }
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily points bonus'),
  new SlashCommandBuilder()
    .setName('participate')
    .setDescription('Join the bot and receive 1000 starting points'),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Check your current points balance'),
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    console.log('🔄 Started refreshing application (/) commands.');
    
    // Your specific guild ID
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, '979180991836995674'),
      { body: commands }
    );
    
    console.log('✅ Successfully reloaded guild-specific commands (instant update).');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

// Bot event handlers
client.once('ready', async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  await initDatabase();
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  
  try {
    switch (commandName) {
      case 'daily': {
        const currentPoints = await getUserPoints(user.id);
        if (currentPoints === null) {
          await interaction.reply({
            content: '❌ You must use `/participate` first to join the bot!',
            ephemeral: true
          });
          break;
        }
        const dailyBonus = 100;
        const newPoints = currentPoints + dailyBonus;
        
        await updateUserPoints(user.id, newPoints);
        
        await interaction.reply({
          content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!\n💰 New balance: **${formatNumber(newPoints)}** points`,
          ephemeral: true
        });
        break;
      }
      
      case 'participate': {
        const isNewUser = await registerUser(user.id);
        if (isNewUser) {
          await interaction.reply({
            content: `✅ **Welcome!** You've joined the bot and received **1000** starting points!`,
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: `❌ You've already joined the bot! Use /wallet to check your balance.`,
            ephemeral: true
          });
        }
        break;
      }
      
      case 'wallet': {
        const points = await getUserPoints(user.id);
        if (points === null) {
          await interaction.reply({
            content: `❌ You haven't joined yet! Use /participate to start with 1000 points.`,
            ephemeral: true
          });
          break;
        }
        await interaction.reply({
          content: `💰 **${user.username}**, your current balance is **${formatNumber(points)}** points!`,
          ephemeral: true
        });
        break;
      }
      
      default:
        await interaction.reply({
          content: '❌ Unknown command!',
          ephemeral: true
        });
    }
  } catch (error) {
    console.error('Command error:', error);
    await interaction.reply({
      content: '❌ An error occurred while processing your command!',
      ephemeral: true
    });
  }
});

console.log('Token length:', process.env.DISCORD_BOT_TOKEN?.length);
console.log('Token starts with:', process.env.DISCORD_BOT_TOKEN?.substring(0, 10));
console.log('Token ends with:', process.env.DISCORD_BOT_TOKEN?.substring(-10));

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down...');
  await pool.end();
  client.destroy();
  process.exit(0);
});
