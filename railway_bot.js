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
      // Create new user with 100 starting points
      await pool.query('INSERT INTO user_points (user_id, points) VALUES ($1, 100)', [userId]);
      return 100;
    }
    return result.rows[0].points;
  } catch (error) {
    console.error('Error getting user points:', error);
    return 0;
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

async function createBettingPool(title, description, creatorId) {
  try {
    const result = await pool.query(`
      INSERT INTO betting_pools (title, description, creator_id) 
      VALUES ($1, $2, $3) 
      RETURNING id
    `, [title, description, creatorId]);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error creating betting pool:', error);
    return null;
  }
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Admin user IDs
const adminUserIds = ["121564489043804161"];

function isAdmin(userId) {
  return adminUserIds.includes(userId);
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
    .setName('balance')
    .setDescription('Check your current points balance'),
    
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily points bonus'),
    
  new SlashCommandBuilder()
    .setName('give')
    .setDescription('Give points to another user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to give points to')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of points to give')
        .setRequired(true)
        .setMinValue(1)),
        
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the points leaderboard'),
    
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
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    console.log('🔄 Started refreshing application (/) commands.');
    
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    
    console.log('✅ Successfully reloaded application (/) commands.');
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
      case 'balance': {
        const points = await getUserPoints(user.id);
        await interaction.reply({
          content: `💰 **${user.username}**, you have **${formatNumber(points)}** points!`,
          ephemeral: true
        });
        break;
      }
      
      case 'daily': {
        const currentPoints = await getUserPoints(user.id);
        const dailyBonus = 50;
        const newPoints = currentPoints + dailyBonus;
        
        await updateUserPoints(user.id, newPoints);
        
        await interaction.reply({
          content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!\n💰 New balance: **${formatNumber(newPoints)}** points`,
          ephemeral: true
        });
        break;
      }
      
      case 'give': {
        const targetUser = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        
        if (targetUser.id === user.id) {
          await interaction.reply({
            content: '❌ You cannot give points to yourself!',
            ephemeral: true
          });
          break;
        }
        
        const senderPoints = await getUserPoints(user.id);
        
        if (senderPoints < amount) {
          await interaction.reply({
            content: `❌ You don't have enough points! You have **${formatNumber(senderPoints)}** points.`,
            ephemeral: true
          });
          break;
        }
        
        const receiverPoints = await getUserPoints(targetUser.id);
        
        await updateUserPoints(user.id, senderPoints - amount);
        await updateUserPoints(targetUser.id, receiverPoints + amount);
        
        await interaction.reply({
          content: `✅ **${user.username}** gave **${formatNumber(amount)}** points to **${targetUser.username}**!`
        });
        break;
      }
      
      case 'leaderboard': {
        try {
          const result = await pool.query(`
            SELECT user_id, points 
            FROM user_points 
            ORDER BY points DESC 
            LIMIT 10
          `);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '📊 No users found in the leaderboard yet!',
              ephemeral: true
            });
            break;
          }
          
          let leaderboard = '🏆 **Points Leaderboard**\n\n';
          
          for (let i = 0; i < result.rows.length; i++) {
            const { user_id, points } = result.rows[i];
            const user = await client.users.fetch(user_id).catch(() => null);
            const username = user ? user.username : 'Unknown User';
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            
            leaderboard += `${medal} **${username}** - ${formatNumber(points)} points\n`;
          }
          
          await interaction.reply({
            content: leaderboard,
            ephemeral: true
          });
        } catch (error) {
          console.error('Leaderboard error:', error);
          await interaction.reply({
            content: '❌ Error fetching leaderboard!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'createpool': {
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description') || 'No description provided';
        
        const poolId = await createBettingPool(title, description, user.id);
        
        if (poolId) {
          await interaction.reply({
            content: `✅ **Betting pool created!**\n🎯 **Pool #${poolId}**: ${title}\n📝 ${description}`
          });
        } else {
          await interaction.reply({
            content: '❌ Failed to create betting pool!',
            ephemeral: true
          });
        }
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

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down...');
  await pool.end();
  client.destroy();
  process.exit(0);
});