const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, StringSelectMenuBuilder } = require('discord.js');
const { Pool } = require('pg');

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query('DROP TABLE IF EXISTS user_points CASCADE');
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        message_id VARCHAR(20),
        channel_id VARCHAR(20)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_options (
        id SERIAL PRIMARY KEY,
        pool_id INTEGER REFERENCES betting_pools(id),
        option_text VARCHAR(255),
        emoji VARCHAR(10),
        is_correct BOOLEAN DEFAULT FALSE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id),
        option_id INTEGER REFERENCES pool_options(id),
        amount INTEGER,
        locked_at TIMESTAMP,
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
    if (result.rows.length === 0) return null;
    return result.rows[0].points;
  } catch (error) {
    console.error('Error getting user points:', error);
    return null;
  }
}

async function registerUser(userId) {
  try {
    const result = await pool.query(`
      INSERT INTO user_points (user_id, points) VALUES ($1, 1000) 
      ON CONFLICT (user_id) DO NOTHING RETURNING points
    `, [userId]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('Error registering user:', error);
    return false;
  }
}

async function updateUserPoints(userId, points) {
  try {
    await pool.query(`
      INSERT INTO user_points (user_id, points) VALUES ($1, $2) 
      ON CONFLICT (user_id) DO UPDATE SET points = $2
    `, [userId, points]);
    return true;
  } catch (error) {
    console.error('Error updating user points:', error);
    return false;
  }
}

async function createPool(creatorId, title, description, options) {
  try {
    const result = await pool.query(
      'INSERT INTO betting_pools (creator_id, title, description) VALUES ($1, $2, $3) RETURNING id',
      [creatorId, title, description]
    );
    const poolId = result.rows[0].id;
    for (const { text, emoji } of options) {
      await pool.query(
        'INSERT INTO pool_options (pool_id, option_text, emoji) VALUES ($1, $2, $3)',
        [poolId, text || 'Option', emoji || '']
      );
    }
    return poolId;
  } catch (error) {
    console.error('Error creating pool:', error);
    return null;
  }
}

async function getOpenPools(creatorId) {
  try {
    return await pool.query(
      'SELECT id, title, description FROM betting_pools WHERE status = $1 AND (creator_id = $2 OR EXISTS (SELECT 1 FROM user_points WHERE user_id = $2 AND points > 0))',
      ['active', creatorId]
    );
  } catch (error) {
    console.error('Error getting open pools:', error);
    return { rows: [] };
  }
}

async function getPoolOptions(poolId) {
  try {
    return await pool.query('SELECT id, option_text, emoji FROM pool_options WHERE pool_id = $1', [poolId]);
  } catch (error) {
    console.error('Error getting pool options:', error);
    return { rows: [] };
  }
}

async function recordBet(userId, poolId, optionId, amount) {
  try {
    await pool.query(
      'INSERT INTO user_bets (user_id, pool_id, option_id, amount, locked_at) VALUES ($1, $2, $3, $4, NULL)',
      [userId, poolId, optionId, amount]
    );
    const currentPoints = await getUserPoints(userId);
    await updateUserPoints(userId, currentPoints - amount);
    return true;
  } catch (error) {
    console.error('Error recording bet:', error);
    return false;
  }
}

async function lockBet(userId, poolId) {
  try {
    await pool.query(
      'UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND pool_id = $2 AND locked_at IS NULL',
      [userId, poolId]
    );
    return true;
  } catch (error) {
    console.error('Error locking bet:', error);
    return false;
  }
}

async function closePool(poolId, correctOptionId) {
  try {
    await pool.query('UPDATE betting_pools SET status = $1 WHERE id = $2', ['closed', poolId]);
    await pool.query('UPDATE pool_options SET is_correct = TRUE WHERE id = $1', [correctOptionId]);
    const bets = await pool.query(
      'SELECT user_id, amount FROM user_bets WHERE pool_id = $1 AND option_id = $2 AND locked_at IS NOT NULL',
      [poolId, correctOptionId]
    );
    const totalStaked = bets.rows.reduce((sum, bet) => sum + bet.amount, 0);
    for (const bet of bets.rows) {
      const reward = (bet.amount / totalStaked) * totalStaked * 0.9; // 90% payout, 10% house cut
      const currentPoints = await getUserPoints(bet.user_id) || 0;
      await updateUserPoints(bet.user_id, currentPoints + reward);
    }
    return true;
  } catch (error) {
    console.error('Error closing pool:', error);
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

// Pool state management
const activePools = new Map();
const betTimeouts = new Map();

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
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
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to add points to')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of points to add')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove points from a user (Admin only)')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to remove points from')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of points to remove')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create a new betting pool'),
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a betting pool and select the correct answer (Admin or creator only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    console.log('🔄 Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] });
    console.log('✅ Cleared global commands.');
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
      console.log(`Command: ${commandName}, User: ${user.id}, Member: ${JSON.stringify(member)}`);
      switch (commandName) {
        case 'daily': {
          const currentPoints = await getUserPoints(user.id);
          if (currentPoints === null) {
            await interaction.reply({ content: '❌ You must use `/participate` first to join the bot!', flags: MessageFlags.Ephemeral });
            break;
          }
          const dailyBonus = 100;
          const newPoints = currentPoints + dailyBonus;
          await updateUserPoints(user.id, newPoints);
          await interaction.reply({ content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!\n💰 New balance: **${formatNumber(newPoints)}** points`, flags: MessageFlags.Ephemeral });
          break;
        }
        case 'participate': {
          const isNewUser = await registerUser(user.id);
          if (isNewUser) {
            await interaction.reply({ content: `✅ **Welcome!** You've joined the bot and received **1000** starting points!`, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: `❌ You've already joined the bot! Use /wallet to check your balance.`, flags: MessageFlags.Ephemeral });
          }
          break;
        }
        case 'wallet': {
          const points = await getUserPoints(user.id);
          if (points === null) {
            await interaction.reply({ content: `❌ You haven't joined yet! Use /participate to start with 1000 points.`, flags: MessageFlags.Ephemeral });
            break;
          }
          await interaction.reply({ content: `💰 **${user.username}**, your current balance is **${formatNumber(points)}** points!`, flags: MessageFlags.Ephemeral });
          break;
        }
        case 'add': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({ content: '❌ You must be a server administrator or have specific admin clearance to use this command!', flags: MessageFlags.Ephemeral });
            break;
          }
          
          const targetUser = interaction.options.getUser('user');
          const amount = interaction.options.getInteger('amount');
          
          const currentPoints = await getUserPoints(targetUser.id);
          if (currentPoints === null) {
            await interaction.reply({ content: `❌ User <@${targetUser.id}> has not joined yet! They must use /participate first.`, flags: MessageFlags.Ephemeral });
            break;
          }
          
          const newPoints = currentPoints + amount;
          await updateUserPoints(targetUser.id, newPoints);
          await interaction.reply({ content: `✅ Added **${formatNumber(amount)}** points to <@${targetUser.id}>!\n💰 New balance: **${formatNumber(newPoints)}** points`, flags: MessageFlags.Ephemeral });
          break;
        }
        case 'remove': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({ content: '❌ You must be a server administrator or have specific admin clearance to use this command!', flags: MessageFlags.Ephemeral });
            break;
          }
          
          const targetUser = interaction.options.getUser('user');
          const amount = interaction.options.getInteger('amount');
          
          const currentPoints = await getUserPoints(targetUser.id);
          if (currentPoints === null) {
            await interaction.reply({ content: `❌ User <@${targetUser.id}> has not joined yet! They must use /participate first.`, flags: MessageFlags.Ephemeral });
            break;
          }
          
          if (currentPoints < amount) {
            await interaction.reply({ content: `❌ User <@${targetUser.id}> only has **${formatNumber(currentPoints)}** points! Cannot remove **${formatNumber(amount)}** points.`, flags: MessageFlags.Ephemeral });
            break;
          }
          
          const newPoints = currentPoints - amount;
          await updateUserPoints(targetUser.id, newPoints);
          await interaction.reply({ content: `✅ Removed **${formatNumber(amount)}** points from <@${targetUser.id}>!\n💰 New balance: **${formatNumber(newPoints)}** points`, flags: MessageFlags.Ephemeral });
          break;
        }
        case 'create': {
          const modal = new ModalBuilder()
            .setCustomId('create_pool_modal')
            .setTitle('Create Betting Pool');
          
          const titleInput = new TextInputBuilder()
            .setCustomId('pool_title')
            .setLabel('Pool Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter a title for your betting pool')
            .setRequired(true)
            .setMaxLength(100);
          
          const descriptionInput = new TextInputBuilder()
            .setCustomId('pool_description')
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('What are people betting on?')
            .setRequired(true)
            .setMaxLength(500);
          
          const option1Input = new TextInputBuilder()
            .setCustomId('option_1')
            .setLabel('Option 1')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Yes')
            .setRequired(true)
            .setMaxLength(80);
          
          const option2Input = new TextInputBuilder()
            .setCustomId('option_2')
            .setLabel('Option 2')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., No')
            .setRequired(true)
            .setMaxLength(80);
          
          const option3Input = new TextInputBuilder()
            .setCustomId('option_3')
            .setLabel('Option 3 (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Maybe')
            .setRequired(false)
            .setMaxLength(80);
          
          modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descriptionInput),
            new ActionRowBuilder().addComponents(option1Input),
            new ActionRowBuilder().addComponents(option2Input),
            new ActionRowBuilder().addComponents(option3Input)
          );
          
          await interaction.showModal(modal);
          break;
        }
        case 'close': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({ content: '❌ You must be a server administrator or the pool creator to use this command!', flags: MessageFlags.Ephemeral });
            break;
          }
          const pools = await getOpenPools(user.id);
          if (pools.rows.length === 0) {
            await interaction.reply({ content: '❌ No open pools available to close.', flags: MessageFlags.Ephemeral });
            break;
          }
          
          const poolSelect = new StringSelectMenuBuilder()
            .setCustomId('pool_select')
            .setPlaceholder('Select a pool to close')
            .addOptions(pools.rows.map(pool => ({
              label: pool.title.substring(0, 100),
              value: pool.id.toString(),
              description: pool.description.substring(0, 100)
            })));
          
          const row = new ActionRowBuilder().addComponents(poolSelect);
          await interaction.reply({ content: 'Select a pool to close:', components: [row], flags: MessageFlags.Ephemeral });
          break;
        }
        default:
          await interaction.reply({ content: '❌ Unknown command!', flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error('Command error:', error.stack);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred while processing your command! Check logs for details.', flags: MessageFlags.Ephemeral });
      }
    }
  } else if (interaction.isModalSubmit()) {
    try {
      const { customId, fields } = interaction;
      console.log(`Modal submit: ${customId}`);
      
      if (customId === 'create_pool_modal') {
        const title = fields.getTextInputValue('pool_title');
        const description = fields.getTextInputValue('pool_description');
        const option1 = fields.getTextInputValue('option_1');
        const option2 = fields.getTextInputValue('option_2');
        const option3 = fields.getTextInputValue('option_3') || null;
        
        const options = [
          { text: option1, emoji: null },
          { text: option2, emoji: null }
        ];
        
        if (option3) {
          options.push({ text: option3, emoji: null });
        }
        
        console.log('Creating pool with:', { title, description, options });
        
        const poolId = await createPool(interaction.user.id, title, description, options);
        if (!poolId) {
          await interaction.reply({ content: '❌ Failed to create pool.', flags: MessageFlags.Ephemeral });
          return;
        }
        
        const channel = interaction.channel;
        const buttons = options.map((opt, i) => 
          new ButtonBuilder()
            .setCustomId(`bet_${poolId}_${i}`)
            .setLabel(opt.text)
            .setStyle(ButtonStyle.Primary)
        );
        
        const poolMessage = await channel.send({
          content: `**${title}**\n${description}\n\n*Created by <@${interaction.user.id}> • Pool closes in 5 minutes*`,
          components: [new ActionRowBuilder().addComponents(buttons)]
        });
        
        await pool.query('UPDATE betting_pools SET message_id = $1, channel_id = $2 WHERE id = $3', [poolMessage.id, channel.id, poolId]);
        activePools.set(poolId, { messageId: poolMessage.id, channelId: channel.id });
        
        // Auto-close after 5 minutes
        setTimeout(async () => {
          try {
            await pool.query('UPDATE betting_pools SET status = $1 WHERE id = $2', ['closed', poolId]);
            const message = await channel.messages.fetch(poolMessage.id);
            await message.edit({ 
              content: `**${title}** *(CLOSED)*\n${description}\n\n*This pool has been closed.*`,
              components: [] 
            });
            activePools.delete(poolId);
          } catch (error) {
            console.error('Error auto-closing pool:', error);
          }
        }, 5 * 60 * 1000);
        
        await interaction.reply({ content: `✅ Pool "${title}" created! It will close automatically in 5 minutes.`, flags: MessageFlags.Ephemeral });
      } else if (customId.startsWith('bet_confirm_')) {
        const [, poolId, optionIndex] = customId.split('_');
        const stake = parseInt(fields.getTextInputValue('stake'));
        const userId = interaction.user.id;
        const currentPoints = await getUserPoints(userId);
        
        if (isNaN(stake) || stake < 1 || stake > 999999 || (currentPoints !== null && currentPoints < stake)) {
          await interaction.reply({ content: '❌ Invalid stake amount or insufficient points!', flags: MessageFlags.Ephemeral });
          return;
        }
        
        const optionsResult = await getPoolOptions(poolId);
        if (!optionsResult.rows.length) {
          await interaction.reply({ content: '❌ No options available for this pool.', flags: MessageFlags.Ephemeral });
          return;
        }
        
        const optionId = optionsResult.rows[parseInt(optionIndex)].id;
        await recordBet(userId, poolId, optionId, stake);
        betTimeouts.set(`${userId}_${poolId}`, setTimeout(() => lockBet(userId, poolId), 30 * 1000));
        await interaction.reply({ content: `✅ Bet of ${formatNumber(stake)} points placed! You have 30 seconds to change it.`, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error('Modal submission error:', error.stack);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred while processing your request! Check logs for details.', flags: MessageFlags.Ephemeral });
      }
    }
  } else if (interaction.isButton()) {
    try {
      const [action, poolId, optionIndex] = interaction.customId.split('_');
      if (action === 'bet') {
        const poolResult = await pool.query('SELECT * FROM betting_pools WHERE id = $1 AND status = $2', [poolId, 'active']);
        if (!poolResult.rows.length) {
          await interaction.reply({ content: '❌ This pool is closed or does not exist.', flags: MessageFlags.Ephemeral });
          return;
        }
        
        const modal = new ModalBuilder()
          .setCustomId(`bet_confirm_${poolId}_${optionIndex}`)
          .setTitle('Place Your Bet');
        
        const stakeInput = new TextInputBuilder()
          .setCustomId('stake')
          .setLabel('Stake Amount')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter points to stake (1-999999)')
          .setRequired(true);
        
        modal.addComponents(new ActionRowBuilder().addComponents(stakeInput));
        await interaction.showModal(modal);
      }
    } catch (error) {
      console.error('Button interaction error:', error.stack);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred while processing your bet!', flags: MessageFlags.Ephemeral });
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'pool_select') {
        const poolId = interaction.values[0];
        const optionsResult = await getPoolOptions(poolId);
        if (!optionsResult.rows.length) {
          await interaction.update({ content: '❌ No options available for this pool.', components: [] });
          return;
        }
        
        const optionSelect = new StringSelectMenuBuilder()
          .setCustomId(`close_pool_${poolId}`)
          .setPlaceholder('Select the correct answer')
          .addOptions(optionsResult.rows.map((opt, i) => ({
            label: opt.option_text,
            value: opt.id.toString(),
            description: `Option ${i + 1}`
          })));
        
        const row = new ActionRowBuilder().addComponents(optionSelect);
        await interaction.update({ content: 'Select the correct answer:', components: [row] });
      } else if (interaction.customId.startsWith('close_pool_')) {
        const poolId = interaction.customId.split('_')[2];
        const correctOptionId = interaction.values[0];
        
        if (await closePool(poolId, correctOptionId)) {
          await interaction.update({ content: `✅ Pool ${poolId} closed successfully! Points have been distributed to winners.`, components: [] });
        } else {
          await interaction.update({ content: '❌ Failed to close pool.', components: [] });
        }
      }
    } catch (error) {
      console.error('Select menu error:', error.stack);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred while processing your selection!', flags: MessageFlags.Ephemeral });
      }
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
