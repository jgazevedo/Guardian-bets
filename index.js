const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, ActionRowBuilder } = require('discord.js');
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

// Admin user IDs
const adminUserIds = ['121564489043804161'];

// Check if user is an admin
function isAdmin(userId, member) {
  const hasAdminPermission = member.permissions.has(PermissionFlagsBits.Administrator);
  const isHardcodedAdmin = adminUserIds.includes(userId);
  console.log(`Admin check for user ${userId}: Administrator permission: ${hasAdminPermission}, Hardcoded admin: ${isHardcodedAdmin}, Result: ${hasAdminPermission || isHardcodedAdmin}`);
  return hasAdminPermission || isHardcodedAdmin;
}

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers // Required for user select menu
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
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add points to a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove points from a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    console.log('🔄 Started refreshing application (/) commands.');
    
    // Clear global commands to ensure no residual commands remain
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] });
    console.log('✅ Cleared global commands.');
    
    // Register guild-specific commands
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
  if (interaction.isChatInputCommand()) {
    const { commandName, user, member } = interaction;
    
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
          const dailyBonus = 100; // Updated from 50 to 100
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
        
        case 'add': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: '❌ You must be a server administrator or have specific admin clearance to use this command!',
              ephemeral: true
            });
            break;
          }
          
          const modal = new ModalBuilder()
            .setCustomId('add_credits_modal')
            .setTitle('Add Credits');
          
          const userSelect = new UserSelectMenuBuilder()
            .setCustomId('user_select')
            .setPlaceholder('Select a user')
            .setMinValues(1)
            .setMaxValues(1);
          
          const creditsInput = new TextInputBuilder()
            .setCustomId('credits')
            .setLabel('Credits')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter number of points to add (1-999999)')
            .setRequired(true);
          
          const balanceInfo = new TextInputBuilder()
            .setCustomId('user_balance_info')
            .setLabel('User balance')
            .setStyle(TextInputStyle.Short)
            .setValue('Select a user to view their balance')
            .setRequired(false)
            .setDisabled(true);
          
          modal.addComponents(
            new ActionRowBuilder().addComponents(userSelect),
            new ActionRowBuilder().addComponents(creditsInput),
            new ActionRowBuilder().addComponents(balanceInfo)
          );
          
          await interaction.showModal(modal);
          break;
        }
        
        case 'remove': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: '❌ You must be a server administrator or have specific admin clearance to use this command!',
              ephemeral: true
            });
            break;
          }
          
          const modal = new ModalBuilder()
            .setCustomId('remove_credits_modal')
            .setTitle('Remove Credits');
          
          const userSelect = new UserSelectMenuBuilder()
            .setCustomId('user_select')
            .setPlaceholder('Select a user')
            .setMinValues(1)
            .setMaxValues(1);
          
          const creditsInput = new TextInputBuilder()
            .setCustomId('credits')
            .setLabel('Credits')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter number of points to remove (1-999999)')
            .setRequired(true);
          
          const balanceInfo = new TextInputBuilder()
            .setCustomId('user_balance_info')
            .setLabel('User balance')
            .setStyle(TextInputStyle.Short)
            .setValue('Select a user to view their balance')
            .setRequired(false)
            .setDisabled(true);
          
          modal.addComponents(
            new ActionRowBuilder().addComponents(userSelect),
            new ActionRowBuilder().addComponents(creditsInput),
            new ActionRowBuilder().addComponents(balanceInfo)
          );
          
          await interaction.showModal(modal);
          break;
        }
        
        default:
          await interaction.reply({
            content: '❌ Unknown command!',
            ephemeral: true
          });
      }
    } catch (error) {
      console.error('Command error:', error.stack);
      await interaction.reply({
        content: '❌ An error occurred while processing your command! Check logs for details.',
        ephemeral: true
      });
    }
  } else if (interaction.isModalSubmit()) {
    try {
      const { customId, fields, components } = interaction;
      console.log(`Modal submit: ${customId}, Components: ${JSON.stringify(components)}`);
      
      if (customId === 'add_credits_modal' || customId === 'remove_credits_modal') {
        // Extract the selected user ID from the user select menu
        const userSelect = components[0].components[0];
        const selectedUserId = userSelect.data.values ? userSelect.data.values[0] : null;
        
        if (!selectedUserId) {
          console.log('No user selected in modal');
          await interaction.reply({
            content: '❌ No user selected!',
            ephemeral: true
          });
          return;
        }
        
        console.log(`Selected user ID: ${selectedUserId}`);
        const credits = parseInt(fields.getTextInputValue('credits'));
        
        if (isNaN(credits) || credits < 1 || credits > 999999) {
          console.log(`Invalid credits: ${fields.getTextInputValue('credits')}`);
          await interaction.reply({
            content: '❌ Invalid credits amount! Must be a number between 1 and 999999.',
            ephemeral: true
          });
          return;
        }
        
        const currentPoints = await getUserPoints(selectedUserId);
        if (currentPoints === null) {
          console.log(`User ${selectedUserId} not registered`);
          await interaction.reply({
            content: `❌ User <@${selectedUserId}> has not joined yet! They must use /participate first.`,
            ephemeral: true
          });
          return;
        }
        
        let newPoints;
        if (customId === 'add_credits_modal') {
          newPoints = currentPoints + credits;
          await updateUserPoints(selectedUserId, newPoints);
          console.log(`Added ${credits} points to ${selectedUserId}, new balance: ${newPoints}`);
          await interaction.reply({
            content: `✅ Added **${formatNumber(credits)}** points to <@${selectedUserId}>!\n💰 New balance: **${formatNumber(newPoints)}** points`,
            ephemeral: true
          });
        } else if (customId === 'remove_credits_modal') {
          if (currentPoints < credits) {
            console.log(`Insufficient points for ${selectedUserId}: ${currentPoints} < ${credits}`);
            await interaction.reply({
              content: `❌ User <@${selectedUserId}> only has **${formatNumber(currentPoints)}** points! Cannot remove **${formatNumber(credits)}** points.`,
              ephemeral: true
            });
            return;
          }
          newPoints = currentPoints - credits;
          await updateUserPoints(selectedUserId, newPoints);
          console.log(`Removed ${credits} points from ${selectedUserId}, new balance: ${newPoints}`);
          await interaction.reply({
            content: `✅ Removed **${formatNumber(credits)}** points from <@${selectedUserId}>!\n💰 New balance: **${formatNumber(newPoints)}** points`,
            ephemeral: true
          });
        }
      }
    } catch (error) {
      console.error('Modal submission error:', error.stack);
      await interaction.reply({
        content: '❌ An error occurred while processing your request! Check logs for details.',
        ephemeral: true
      });
    }
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
